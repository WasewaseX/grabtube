import { NextResponse } from "next/server";
import { existsSync } from "fs";

import { ensureFileForLink, serveLocalFile, type LinkSpec } from "@/lib/file-link";
import { headLegacyDownload, serveLegacyDownload } from "@/lib/legacy-download-file";
import { findStoredByToken, parseLookupKey, touchStoredFile } from "@/lib/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * /api/file/<token> — THE stable direct link.
 *
 * Serves a file that the server has ALREADY fully downloaded from YouTube
 * (registered in the StoredFile table). Pure local-disk serving with full
 * Range/resume (206), If-Range, ETag, Last-Modified and RFC 5987 filenames —
 * the user's connection NEVER touches YouTube.
 *
 * Self-healing: if the file was evicted (disk pressure) but the registry row
 * exists, a hit re-starts the server-side download and answers 503 +
 * Retry-After until the file is stored again — the SAME token keeps working.
 */

async function handle(req: Request, token: string): Promise<Response> {
  if (!/^[a-f0-9]{8,64}$/i.test(token)) {
    return NextResponse.json(
      { error: { code: "INVALID_TOKEN", message: "Malformed file token." } },
      { status: 400 },
    );
  }

  const stored = await findStoredByToken(token);
  if (!stored) {
    /* Legacy fallback: ids handed out by the first-generation engine
     * (/api/stress harness) resolve through db.download under the same slug. */
    const legacy = await serveLegacyDownload(req, token);
    if (legacy) return legacy;
    return NextResponse.json(
      { error: { code: "NOT_FOUND", message: "Unknown or expired file link." } },
      { status: 404 },
    );
  }

  /* fast path — file is on disk right now */
  if (existsSync(stored.filePath)) {
    void touchStoredFile(token); // counts + keeps it out of eviction
    return serveLocalFile(req, {
      filePath: stored.filePath,
      mime: stored.mime,
      filename: stored.filename,
    });
  }

  /* self-heal — row exists but file evicted: re-fetch server-side, same link */
  const spec = parseLookupKey(stored.lookupKey) as LinkSpec | null;
  if (!spec) {
    return NextResponse.json(
      { error: { code: "NOT_FOUND", message: "File is gone from the server." } },
      { status: 404 },
    );
  }
  const result = await ensureFileForLink(spec);
  if (result.kind === "ready") {
    void touchStoredFile(token);
    return serveLocalFile(req, {
      filePath: result.file.filePath,
      mime: result.file.mime,
      filename: result.file.filename,
    });
  }
  if (result.kind === "busy") {
    return NextResponse.json(
      { error: { code: "FETCHING", message: "Server is re-fetching this file — retry shortly." } },
      { status: 503, headers: { "Retry-After": String(result.retryAfter) } },
    );
  }
  return NextResponse.json(
    { error: { code: result.code, message: result.message } },
    { status: 502, headers: result.retryAfter ? { "Retry-After": String(result.retryAfter) } : {} },
  );
}

export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await ctx.params;
  return handle(req, token);
}

export async function HEAD(req: Request, ctx: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await ctx.params;
  const stored = await findStoredByToken(token).catch(() => null);
  if (stored) return handle(req, token);
  const legacy = await headLegacyDownload(token);
  if (legacy) return legacy;
  return handle(req, token); // re-runs handle → canonical 400/404 body
}
