import { NextResponse } from "next/server";

import { b64urlDecode } from "@/lib/direct-link";
import { ensureFileForLink, serveLocalFile, type LinkSpec } from "@/lib/file-link";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * /api/dl — PERMANENT direct links (MIDDLEMAN, fetch-first).
 *
 *   /api/dl?u=<b64url webpage_url>&f=<format>&q=<quality>&t=<title>&b=<bitrate>
 *
 *   f = "18"             → single-stream file (server downloads it fully)
 *   f = "137|140|mp4"    → server downloads + merges, then serves the file
 *   f = "mp3", b=320     → server downloads + converts, then serves the file
 *
 * CONTRACT: a hit NEVER streams YouTube media and NEVER hangs waiting for a
 * download. The server downloads the file FIRST (fast pipe + WARP); until
 * the file is fully stored locally, the link answers 503 + Retry-After so
 * download managers (IDM/aria2) retry automatically and land on the finished
 * file the moment it exists. Once ready, the link serves the LOCAL file with
 * full Range/resume (206) support — the user's connection only ever talks to
 * this server, which is what makes it work on slow/censored networks.
 *
 * Links are stable: same signature → same stored file (and same token via
 * /api/file/<token>, which this route serves directly from disk).
 */

function jsonError(code: string, message: string, status: number, retryAfter?: number) {
  const headers: Record<string, string> = {};
  if (retryAfter) headers["Retry-After"] = String(retryAfter);
  return NextResponse.json({ error: { code, message } }, { status, headers });
}

/** SSRF-guarded decode of the `u` param. */
function decodeTarget(raw: string): string | null {
  let target = raw;
  try {
    if (!/^https?:\/\//i.test(target)) target = b64urlDecode(raw);
  } catch {
    return null;
  }
  try {
    const u = new URL(target);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const host = u.hostname.toLowerCase();
    if (
      host === "localhost" ||
      host.endsWith(".local") ||
      /^127\./.test(host) ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
      host === "0.0.0.0" ||
      host === "[::1]"
    ) {
      return null;
    }
    return u.toString();
  } catch {
    return null;
  }
}

function specFromParams(searchParams: URLSearchParams): { spec: LinkSpec | null; error?: string } {
  const target = decodeTarget(searchParams.get("u") || "");
  const format = searchParams.get("f") || "";
  if (!target) return { spec: null, error: "Bad or missing target URL." };
  if (!format) return { spec: null, error: "Missing format parameter." };
  return {
    spec: {
      webpageUrl: target,
      format,
      quality: searchParams.get("q") || undefined,
      title: searchParams.get("t") || undefined,
      bitrate: parseInt(searchParams.get("b") || "0", 10) || undefined,
    },
  };
}

async function handle(req: Request): Promise<Response> {
  const { searchParams } = new URL(req.url);
  const { spec, error } = specFromParams(searchParams);
  if (!spec) return jsonError("INVALID_URL", error || "Bad request.", 400);

  const result = await ensureFileForLink(spec);

  if (result.kind === "ready") {
    return serveLocalFile(req, {
      filePath: result.file.filePath,
      mime: result.file.mime,
      filename: result.file.filename,
    });
  }

  if (result.kind === "busy") {
    // The manager will retry automatically; the file is being fetched by the
    // server right now. This is the "download first, link second" contract.
    return jsonError(
      "FETCHING",
      "Server is downloading this file first — retry in a few seconds.",
      503,
      result.retryAfter,
    );
  }

  const status = result.code === "INVALID_URL" ? 400 : 502;
  return jsonError(result.code, result.message, status, result.retryAfter);
}

export async function GET(req: Request): Promise<Response> {
  return handle(req);
}

/** HEAD: download managers probe links this way before committing. */
export async function HEAD(req: Request): Promise<Response> {
  return handle(req);
}
