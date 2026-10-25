/**
 * MIDDLEMAN link engine — everything a direct link needs in one place.
 *
 * Contract (what the user asked for):
 *   "download the video to database first, THEN give the direct link —
 *    so I never download from YouTube, only from your server."
 *
 * • A direct link resolves to a file that the server has ALREADY fully
 *   downloaded (yt-dlp/ffmpeg job) and registered in the StoredFile table.
 * • While the server is fetching, a link hit answers FAST with
 *   503 + Retry-After — download managers (IDM/aria2) retry automatically
 *   and the file appears under the same URL when ready. No hanging requests,
 *   no live YouTube proxying, no mid-stream breakage.
 * • Links are stable: the token is derived from the request signature, so a
 *   re-request hours later (or after eviction + re-download) lands on the
 *   same stored file / token.
 */
import { existsSync, statSync, createReadStream } from "fs";
import { Readable } from "stream";

import { getInfo, type RawInfo } from "@/lib/ytdlp";
import { ensureRawInfo } from "@/lib/extract";
import { createJob, jobStore, sanitizeFilename, type Job } from "@/lib/jobs";
import { isSavenowSource, SAVENOW_QUALITIES, savenowPlaceholder } from "@/lib/savenow";
import { parseVideoId } from "@/lib/providers";
import { MIME_MAP, contentDisposition } from "@/lib/http-utils";
import {
  findStoredByLookupKey,
  lookupKeyFor,
  registerStoredFile,
  videoKeyFromFormat,
  type StoredFileInfo,
} from "@/lib/store";

const AUDIO_TARGETS = new Set(["mp3", "m4a", "opus", "flac", "wav"]);
const INFO_TTL = 4 * 60 * 60 * 1000; // webpage → infoId cache
const ERROR_TTL = 90 * 1000; // remember a failed warm-up briefly so retries fail fast

export interface LinkSpec {
  webpageUrl: string;
  /** instant itag ("18"/"140"), merge composite ("137|140|mp4"), or audio target ("mp3") */
  format: string;
  quality?: string;
  bitrate?: number;
  title?: string;
}

type RegistryEntry = {
  jobId?: string;
  pending?: Promise<void>;
  error?: { code: string; message: string; at: number };
};

declare global {
  var __tgLinkInfo: Map<string, { infoId: string; at: number }> | undefined;
  var __tgLinkJobs: Map<string, RegistryEntry> | undefined;
}

function infoCache(): Map<string, { infoId: string; at: number }> {
  if (!globalThis.__tgLinkInfo) globalThis.__tgLinkInfo = new Map();
  return globalThis.__tgLinkInfo;
}
function jobRegistry(): Map<string, RegistryEntry> {
  if (!globalThis.__tgLinkJobs) globalThis.__tgLinkJobs = new Map();
  return globalThis.__tgLinkJobs;
}

export function specKey(spec: LinkSpec): string {
  return lookupKeyFor(spec.webpageUrl, spec.format, spec.bitrate);
}

/**
 * Storage identity for a link spec. Video itags DRIFT between extraction
 * sessions (same 360p H.264 selection → itag 134 one hour, 230 the next),
 * so video links resolve to a SEMANTIC key (height+fps+codec+container).
 * Audio conversions keep the exact target key (mp3/320 etc.). Resolving
 * here — not just at registration — makes a link hit land on the shared
 * stored file no matter which itag variant the link was minted with.
 */
async function resolveStorageKey(spec: LinkSpec): Promise<string> {
  const isAudio = AUDIO_TARGETS.has(spec.format.toLowerCase());
  if (isAudio || !spec.format.includes("|")) return specKey(spec);
  try {
    const { raw } = await loadRawInfo(spec.webpageUrl);
    const vId = spec.format.split("|")[0];
    const vf = raw.formats.find((f) => f.format_id === vId) ?? null;
    return videoKeyFromFormat(spec.webpageUrl, vf, spec.format);
  } catch {
    return specKey(spec); // extraction down → identity falls back to itag
  }
}

/** webpage URL → RawInfo through the FULL extraction chain (yt-dlp →
 *  Piped/Invidious fleet → savenow mirror), re-extracting when cold. */
export async function loadRawInfo(webpageUrl: string): Promise<{ infoId: string; raw: RawInfo }> {
  const cache = infoCache();
  const hit = cache.get(webpageUrl);
  if (hit && Date.now() - hit.at < INFO_TTL) {
    const entry = getInfo(hit.infoId);
    if (entry) return { infoId: hit.infoId, raw: entry.raw };
  }
  const fresh = await ensureRawInfo(webpageUrl);
  cache.set(webpageUrl, { infoId: fresh.infoId, at: Date.now() });
  return fresh;
}

function jobAlive(job: Job | undefined): boolean {
  return !!job && (job.state === "queued" || job.state === "downloading" || job.state === "merging");
}

/** Filename for a stored/registered file of this spec. */
export function filenameForSpec(spec: LinkSpec, raw: RawInfo): string {
  const isAudio = AUDIO_TARGETS.has(spec.format.toLowerCase());
  const ext = isAudio
    ? spec.format.toLowerCase()
    : spec.format.includes("|")
      ? (spec.format.split("|")[2] || "mp4").toLowerCase()
      : (raw.formats.find((f) => f.format_id === spec.format)?.ext || "mp4").toLowerCase();
  const title = sanitizeFilename(spec.title || raw.title || "video");
  const q = spec.quality ? ` (${spec.quality})` : "";
  return sanitizeFilename(`${title}${q}.${ext}`);
}

/** Nearest savenow quality for a requested pixel height. */
function nearestSavenowQuality(height: number | undefined): string {
  if (!height) return "360";
  const ranked = [...SAVENOW_QUALITIES]
    .map((q) => ({ q, h: q === "4k" ? 2160 : parseInt(q, 10) || 0 }))
    .sort((a, b) => Math.abs(a.h - height) - Math.abs(b.h - height));
  return ranked[0]?.q || "360";
}

/**
 * Kick off (or attach to) the server-side job for this link spec in the
 * background — never awaited by link hits, which answer 503 immediately.
 * If ANY alive job already carries this lookupKey (e.g. an in-app download
 * of the same selection), it is adopted instead of spawning a duplicate.
 */
function warmUp(key: string, spec: LinkSpec): void {
  const registry = jobRegistry();

  // dedupe: adopt an alive job with the same dlKey (in-app or link-originated)
  for (const job of jobStore().values()) {
    if (job.dlKey === key && jobAlive(job)) {
      registry.set(key, { jobId: job.id });
      return;
    }
  }

  const pending = (async () => {
    try {
      const { infoId, raw } = await loadRawInfo(spec.webpageUrl);
      const isAudio = AUDIO_TARGETS.has(spec.format.toLowerCase());
      const mirror = isSavenowSource(raw);
      const filename = filenameForSpec(spec, raw);

      let mode: Job["mode"] = isAudio ? "mp3" : spec.format.includes("|") ? "merge" : "file";
      let urls: { video?: string; audio?: string } | undefined;
      if (mirror) {
        // savenow source: yt-dlp can't run (that's WHY we're on the mirror) —
        // route to ffmpeg jobs that resolve the placeholder at spawn time
        const videoId = raw.id || parseVideoId(raw.webpage_url) || "";
        if (isAudio) {
          mode = "urlaudio";
          urls = { audio: savenowPlaceholder(videoId, "mp3") };
        } else {
          mode = "urlfile";
          const fmtId = spec.format.split("|")[0];
          const stored = raw.formats.find((f) => f.format_id === fmtId);
          const height =
            stored?.height ??
            (parseInt(spec.quality || "", 10) || null);
          urls = {
            video:
              stored?.url && /savenow:\/\//.test(stored.url)
                ? stored.url
                : savenowPlaceholder(videoId, nearestSavenowQuality(height ?? undefined)),
          };
        }
      }

      const job = createJob({
        infoId,
        mode,
        videoFormatId: isAudio ? undefined : spec.format,
        audioFormat: isAudio ? spec.format.toLowerCase() : undefined,
        bitrate: spec.bitrate,
        webpageUrl: spec.webpageUrl,
        // title WITH quality suffix → job.filename / stored filename carry it
        title: sanitizeFilename(
          `${sanitizeFilename(spec.title || raw.title || "video")}${
            spec.quality ? ` (${spec.quality})` : ""
          }`,
        ),
        duration: raw.duration,
        dlKey: key,
        urls,
      });
      registry.set(key, { jobId: job.id });
      console.log(`[link] job ${job.id} started for ${filename}${mirror ? " (mirror)" : ""}`);
    } catch (e) {
      const code = (e as { code?: string }).code || "FETCH_FAILED";
      registry.set(key, {
        error: { code, message: (e as Error)?.message || "warm-up failed", at: Date.now() },
      });
      console.error(`[link] warm-up failed for ${key.slice(0, 80)}: ${code}`);
    }
  })();
  registry.set(key, { pending });
  void pending.then(() => {
    const entry = registry.get(key);
    if (entry && entry.pending === pending && !entry.jobId && !entry.error) registry.delete(key);
  });
}

export type EnsureResult =
  | { kind: "ready"; file: StoredFileInfo }
  | { kind: "busy"; jobId?: string; retryAfter: number }
  | { kind: "failed"; code: string; message: string; retryAfter?: number };

/**
 * Resolve a link spec to a STORED file — ready only when the file is fully
 * on this server. Otherwise starts the server-side fetch and reports busy.
 */
export async function ensureFileForLink(spec: LinkSpec): Promise<EnsureResult> {
  const key = await resolveStorageKey(spec);

  /* 1 — already downloaded & registered → serve from disk */
  const stored = await findStoredByLookupKey(key);
  if (stored) return { kind: "ready", file: stored };

  /* 2 — a row exists but the file was evicted → allow re-warm below */
  const registry = jobRegistry();
  const entry = registry.get(key);

  if (entry?.error) {
    if (Date.now() - entry.error.at > ERROR_TTL) registry.delete(key);
    else
      return {
        kind: "failed",
        code: entry.error.code,
        message: entry.error.message,
        retryAfter: 30,
      };
  }
  if (entry?.jobId) {
    const job = jobStore().get(entry.jobId);
    if (jobAlive(job)) return { kind: "busy", jobId: entry.jobId, retryAfter: 10 };
    // job died (error/cancelled/TTL) → forget it so a retry re-creates
    registry.delete(key);
  } else if (entry?.pending) {
    return { kind: "busy", retryAfter: 10 };
  }

  /* 3 — nothing running → start the server-side fetch NOW (background) */
  warmUp(key, spec);
  return { kind: "busy", retryAfter: 10 };
}

/* ------------------------------------------------------------------ */
/* Local-file serving with production-grade Range support              */
/* ------------------------------------------------------------------ */

function etagFor(size: number, mtimeMs: number): string {
  return `"${size.toString(16)}-${Math.floor(mtimeMs).toString(16)}"`;
}

/**
 * Serve a local file to GET and HEAD requests with:
 * Accept-Ranges, single/suffix ranges, 416, If-Range, ETag, Last-Modified,
 * Content-Length and RFC 5987 Content-Disposition — what segmented download
 * managers need for pause/resume on flaky networks.
 */
export function serveLocalFile(
  req: Request,
  file: { filePath: string; mime: string; filename: string },
  sizeHint?: number,
): Response {
  let size = sizeHint ?? 0;
  let mtimeMs = 0;
  try {
    const st = statSync(file.filePath);
    size = st.size;
    mtimeMs = st.mtimeMs;
  } catch {
    return Response.json(
      { error: { code: "NOT_FOUND", message: "File is gone from the server." } },
      { status: 404 },
    );
  }
  if (size <= 0) {
    return Response.json(
      { error: { code: "NOT_FOUND", message: "File is empty." } },
      { status: 404 },
    );
  }

  const etag = etagFor(size, mtimeMs);
  const base: Record<string, string> = {
    "Content-Type": file.mime || MIME_MAP.mp4,
    "Content-Disposition": contentDisposition(file.filename),
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=3600",
    ETag: etag,
  };
  if (mtimeMs > 0) base["Last-Modified"] = new Date(mtimeMs).toUTCString();

  /* ---------- Range parsing (single + suffix ranges) ---------- */
  const rangeHeader = req.headers.get("range");
  let start = 0;
  let end = size - 1;
  let partial = false;

  if (rangeHeader && /^bytes=/i.test(rangeHeader)) {
    // multi-range requests (rare) → fall back to a full 200 response
    const ranges = rangeHeader.replace(/^bytes=/i, "").split(",").filter((r) => r.trim());
    if (ranges.length === 1) {
      const m = ranges[0].trim().match(/^(\d*)-(\d*)$/);
      if (m && (m[1] || m[2])) {
        if (m[1]) {
          start = parseInt(m[1], 10);
          end = m[2] ? Math.min(parseInt(m[2], 10), size - 1) : size - 1;
        } else {
          start = Math.max(0, size - parseInt(m[2], 10)); // suffix: last N bytes
        }
        partial = true;
      }
    }
  }

  /* If-Range: stale validator → serve the whole file (RFC 7233) */
  const ifRange = req.headers.get("if-range");
  if (partial && ifRange) {
    const matches = ifRange === etag || ifRange.startsWith(`"${mtimeMs.toString(16)}`);
    if (!matches) partial = false;
  }

  if (partial && (start > end || start >= size)) {
    return new Response(null, {
      status: 416,
      headers: { ...base, "Content-Range": `bytes */${size}` },
    });
  }
  if (!partial) {
    start = 0;
    end = size - 1;
  }

  const len = end - start + 1;
  const headers = new Headers(base);
  headers.set("Content-Length", String(len));
  if (partial) headers.set("Content-Range", `bytes ${start}-${end}/${size}`);

  if (req.method === "HEAD") return new Response(null, { status: partial ? 206 : 200, headers });

  const nodeStream = createReadStream(file.filePath, { start, end });
  req.signal.addEventListener("abort", () => nodeStream.destroy());
  const stream = Readable.toWeb(nodeStream) as unknown as ReadableStream;
  return new Response(stream, { status: partial ? 206 : 200, headers });
}
