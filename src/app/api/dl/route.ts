import { NextResponse } from "next/server";
import { statSync, createReadStream, existsSync } from "fs";
import { Readable } from "stream";

import { fetchInfo, getInfo, resolveFormatUrl, type RawInfo } from "@/lib/ytdlp";
import { createJob, jobStore, sanitizeFilename } from "@/lib/jobs";
import { contentDisposition, MIME_MAP } from "@/lib/http-utils";
import { openMediaStream } from "@/lib/media-stream";
import { b64urlDecode } from "@/lib/direct-link";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * /api/dl — PERMANENT self-contained direct links for external download
 * managers (IDM, Free Download Manager, aria2, wget, curl…).
 *
 *   /api/dl?u=<b64url webpage_url>&f=<format>&q=<quality>&t=<title>&b=<bitrate>
 *
 *   f = "18"            → instant single-stream proxy (fresh-minted URL)
 *   f = "137|140|mp4"   → server runs a merge job, then serves the file
 *   f = "mp3", b=320    → server converts to MP3, then serves the file
 *
 * Every hit re-resolves what it needs (cached briefly), so the link survives
 * restarts and works hours later. Range requests → 206, so segmented
 * multi-connection managers and resume work out of the box.
 */

const INFO_TTL = 4 * 60 * 60 * 1000; // webpage → infoId cache (info store itself lives 6h)
const MINT_TTL = 90 * 60 * 1000; // googlevideo URL cache for an IDM segment swarm
const MERGE_WAIT_MS = 150_000; // IDM tolerates a slow first byte when data eventually flows

declare global {
  var __tgDlInfo: Map<string, { infoId: string; at: number }> | undefined;
  var __tgDlMint: Map<string, { url: string; at: number }> | undefined;
  var __tgDlJob: Map<string, string> | undefined;
}

function dlInfoCache(): Map<string, { infoId: string; at: number }> {
  if (!globalThis.__tgDlInfo) globalThis.__tgDlInfo = new Map();
  return globalThis.__tgDlInfo;
}
function dlMintCache(): Map<string, { url: string; at: number }> {
  if (!globalThis.__tgDlMint) globalThis.__tgDlMint = new Map();
  return globalThis.__tgDlMint;
}
function dlJobRegistry(): Map<string, string> {
  if (!globalThis.__tgDlJob) globalThis.__tgDlJob = new Map();
  return globalThis.__tgDlJob;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

/** webpage URL → RawInfo, via the shared info store (re-extracts when cold). */
async function loadRaw(webpageUrl: string): Promise<{ infoId: string; raw: RawInfo }> {
  const cache = dlInfoCache();
  const hit = cache.get(webpageUrl);
  if (hit && Date.now() - hit.at < INFO_TTL) {
    const entry = getInfo(hit.infoId);
    if (entry) return { infoId: hit.infoId, raw: entry.raw };
  }
  const fresh = await fetchInfo(webpageUrl);
  cache.set(webpageUrl, { infoId: fresh.infoId, at: Date.now() });
  return fresh;
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const format = searchParams.get("f") || "";
  const qualityLabel = searchParams.get("q") || "";
  const titleParam = searchParams.get("t") || "";
  const bitrate = parseInt(searchParams.get("b") || "0", 10) || undefined;

  const target = decodeTarget(searchParams.get("u") || "");
  if (!target) return jsonError("INVALID_URL", "Bad or missing target URL.", 400);
  if (!format) return jsonError("INVALID_URL", "Missing format parameter.", 400);

  /* ==================================================================== */
  /* merge / mp3 → shared job → serve finished file with Range            */
  /* ==================================================================== */
  if (format.includes("|") || format === "mp3") {
    let infoId: string;
    let raw: RawInfo;
    try {
      const loaded = await loadRaw(target);
      infoId = loaded.infoId;
      raw = loaded.raw;
    } catch (e) {
      const code = (e as { code?: string }).code || "FETCH_FAILED";
      return jsonError(code, "Could not resolve this video.", 502, 30);
    }

    const title = sanitizeFilename(titleParam || raw.title || "video");
    const isMp3 = format === "mp3";
    const container = isMp3 ? "mp3" : (format.split("|")[2] || "mkv").toLowerCase();
    const filename = sanitizeFilename(
      `${title}${qualityLabel ? ` (${qualityLabel})` : ""}.${container}`,
    );

    const regKey = `${target}::${format}::${isMp3 ? bitrate || 320 : 0}`;
    const registry = dlJobRegistry();

    let jobId = registry.get(regKey);
    if (jobId) {
      const existing = jobStore().get(jobId);
      // stale/dead job → drop and re-create below
      if (!existing || existing.state === "error" || existing.state === "cancelled") {
        registry.delete(regKey);
        jobId = undefined;
      }
    }
    if (!jobId) {
      try {
        const job = createJob({
          infoId,
          mode: isMp3 ? "mp3" : "merge",
          videoFormatId: isMp3 ? undefined : format,
          bitrate: isMp3 ? bitrate : undefined,
          webpageUrl: target,
          title,
          duration: raw.duration,
        });
        jobId = job.id;
        registry.set(regKey, jobId);
        console.log(`[dl] merge job ${jobId} created for ${regKey.slice(0, 90)}`);
      } catch (e) {
        const code = (e as { code?: string }).code || "INTERNAL";
        return jsonError(code, "Could not start the server-side conversion.", 500);
      }
    }

    /* ---- wait for the shared job (all IDM segments wait together) ---- */
    const deadline = Date.now() + MERGE_WAIT_MS;
    for (;;) {
      const job = jobStore().get(jobId!);
      if (!job) return jsonError("NOT_FOUND", "Job vanished.", 404);
      if (job.state === "ready" && job.filePath && existsSync(job.filePath)) {
        return serveFile(req, job.filePath, job.mime, filename, true);
      }
      if (job.state === "error") {
        // let the next retry create a fresh job
        registry.delete(regKey);
        return jsonError(job.error || "INTERNAL", "Server-side processing failed.", 502, 20);
      }
      if (job.state === "cancelled") {
        registry.delete(regKey);
        return jsonError("CANCELLED", "Processing was cancelled.", 502, 10);
      }
      if (Date.now() > deadline) {
        return jsonError("BUSY", "Still processing — the manager will retry automatically.", 503, 20);
      }
      await sleep(1000);
    }
  }

  /* ==================================================================== */
  /* instant format → fresh-minted ranged proxy stream                    */
  /* ==================================================================== */
  let raw: RawInfo;
  try {
    raw = (await loadRaw(target)).raw;
  } catch (e) {
    const code = (e as { code?: string }).code || "FETCH_FAILED";
    return jsonError(code, "Could not resolve this video.", 502, 30);
  }

  const stored = raw.formats.find((f) => f.format_id === format);
  if (!stored) return jsonError("NO_FORMATS", "Unknown format.", 404);

  const ext = (stored.ext || "mp4").toLowerCase();
  const filename = sanitizeFilename(
    `${titleParam || raw.title || "video"}${qualityLabel ? ` (${qualityLabel})` : ""}.${ext}`,
  );
  const isYouTube = /youtube/i.test(raw.webpage_url);
  const isAudioOnly = stored.vcodec === "none";

  const selector = isYouTube
    ? isAudioOnly
      ? `${format}/bestaudio[acodec!=none]/best`
      : `${format}/22/18/best[acodec!=none][vcodec!=none]/best`
    : format;

  const freshResolve = (): Promise<string | null> =>
    isYouTube
      ? resolveFormatUrl(raw.webpage_url, selector).catch(() => null)
      : Promise.resolve(null);

  /* mint cache: an IDM multi-segment swarm shares ONE minted URL */
  const mintKey = `${target}::${selector}`;
  const mints = dlMintCache();
  const mintHit = mints.get(mintKey);
  const cachedMint = mintHit && Date.now() - mintHit.at < MINT_TTL ? mintHit.url : "";
  const candidates = [cachedMint].filter(Boolean);
  if (!cachedMint) {
    const fresh = await freshResolve();
    if (fresh) {
      mints.set(mintKey, { url: fresh, at: Date.now() });
      candidates.push(fresh);
    }
  }
  candidates.push(stored.url || "");

  /* ---------- client range parsing ---------- */
  const rangeHeader = req.headers.get("range");
  const m = rangeHeader?.match(/bytes=(\d*)-(\d*)/);
  let start = 0;
  let end = -1; // open-ended
  let partial = false;
  let suffix: number | null = null;
  if (m && (m[1] || m[2])) {
    partial = true;
    if (m[1]) {
      start = parseInt(m[1], 10);
      if (m[2]) end = parseInt(m[2], 10);
    } else {
      suffix = parseInt(m[2], 10);
    }
  }

  const result =
    suffix !== null
      ? await (async () => {
          const pre = await openMediaStream({
            candidates,
            start: 0,
            end: 0,
            tag: "dl",
            signal: req.signal,
          });
          const total = pre?.totalSize ?? -1;
          if (!pre || total <= 0) return null;
          return openMediaStream({
            candidates,
            reMint: freshResolve,
            start: Math.max(0, total - suffix!),
            end: total - 1,
            concurrency: 2,
            tag: "dl",
            signal: req.signal,
          });
        })()
      : await openMediaStream({
          candidates,
          reMint: async () => {
            const u = await freshResolve();
            if (u) mints.set(mintKey, { url: u, at: Date.now() });
            return u;
          },
          start,
          end,
          concurrency: partial ? 2 : 4,
          tag: "dl",
          signal: req.signal,
        });

  if (!result) {
    return jsonError("EXPIRED", "Media link expired — the manager will retry.", 502, 15);
  }

  const { stream, totalSize } = result;
  const total = totalSize > 0 ? totalSize : -1;

  const out = new Headers();
  out.set("Content-Type", MIME_MAP[ext] || "application/octet-stream");
  out.set("Content-Disposition", contentDisposition(filename));
  out.set("Cache-Control", "no-store");
  out.set("Accept-Ranges", "bytes");
  if (partial && total > 0) {
    const s = suffix !== null ? Math.max(0, total - suffix) : start;
    const e = Math.min(end < 0 ? total - 1 : end, total - 1);
    out.set("Content-Range", `bytes ${s}-${e}/${total}`);
    out.set("Content-Length", String(e - s + 1));
  } else if (!partial && total > 0) {
    out.set("Content-Length", String(total));
  }

  return new Response(stream, { status: partial ? 206 : 200, headers: out });
}

/* ---------------- finished-job file serving with Range ---------------- */

function serveFile(
  req: Request,
  filePath: string,
  mime: string,
  filename: string,
  keepFile: boolean,
): Response {
  const st = statSync(filePath);
  const size = st.size;

  const rangeHeader = req.headers.get("range");
  const m = rangeHeader?.match(/bytes=(\d*)-(\d*)/);
  let start = 0;
  let end = size - 1;
  let partial = false;
  if (m && (m[1] || m[2]) && size > 0) {
    partial = true;
    if (m[1]) {
      start = Math.min(parseInt(m[1], 10), size - 1);
      end = m[2] ? Math.min(parseInt(m[2], 10), size - 1) : size - 1;
    } else {
      start = Math.max(0, size - parseInt(m[2], 10));
    }
    if (start > end) {
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${size}` },
      });
    }
  }

  const nodeStream = createReadStream(filePath, { start, end });
  req.signal.addEventListener("abort", () => nodeStream.destroy());

  const out = new Headers();
  out.set("Content-Type", mime);
  out.set("Content-Disposition", contentDisposition(filename));
  out.set("Cache-Control", "no-store");
  out.set("Accept-Ranges", "bytes");
  out.set("Content-Length", String(end - start + 1));
  if (partial) out.set("Content-Range", `bytes ${start}-${end}/${size}`);

  // keepFile=true → the file stays available for other IDM segments / resumes;
  // the job TTL cleaner removes it later. (In-app /api/jobs/.../file handles
  // its own served-once cleanup.)
  void keepFile;

  return new Response(Readable.toWeb(nodeStream) as unknown as ReadableStream, {
    status: partial ? 206 : 200,
    headers: out,
  });
}
