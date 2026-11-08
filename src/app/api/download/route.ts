import { NextResponse } from "next/server";
import { getInfo, resolveFormatUrl, type RawInfo } from "@/lib/ytdlp";
import { contentDisposition, MIME_MAP } from "@/lib/http-utils";
import { openMediaStream, type MediaStreamResult } from "@/lib/media-stream";
import { sanitizeFilename } from "@/lib/jobs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * /api/download — INSTANT single-format proxy stream.
 *
 *   GET /api/download?infoId=…&formatId=…&q=<quality-label>
 *
 * Streams the stored format's media URL through the ACTIVE egress lane with
 * full Range/206 support (bounded windows, backpressure, mid-stream re-mint).
 * Used by the in-app downloader for direct (muxed / audio-only) formats.
 */

/** Client Range header, pre-parsed for the stream engine. */
interface ParsedRange {
  start: number;
  end: number; // -1 = open-ended
  partial: boolean;
  suffix: number | null; // last-N-bytes request (`bytes=-N`)
}

function parseRange(rangeHeader: string | null): ParsedRange {
  const m = rangeHeader?.match(/bytes=(\d*)-(\d*)/);
  const range: ParsedRange = { start: 0, end: -1, partial: false, suffix: null };
  if (!m || !(m[1] || m[2])) return range;
  range.partial = true;
  if (m[1]) {
    range.start = parseInt(m[1], 10);
    if (m[2]) range.end = parseInt(m[2], 10);
  } else {
    range.suffix = parseInt(m[2], 10);
  }
  return range;
}

async function wireStream(
  candidates: string[],
  freshResolve: () => Promise<string | null>,
  range: ParsedRange,
  signal: AbortSignal,
): Promise<MediaStreamResult | null> {
  const suffix = range.suffix;
  if (suffix !== null) {
    // suffix request: probe the total size first, then reopen the tail window
    const pre = await openMediaStream({ candidates, start: 0, end: 0, tag: "download", signal });
    const total = pre?.totalSize ?? -1;
    if (!pre || total <= 0) return null;
    return openMediaStream({
      candidates,
      reMint: freshResolve,
      start: Math.max(0, total - suffix),
      end: total - 1,
      concurrency: 2,
      tag: "download",
      signal,
    });
  }
  return openMediaStream({
    candidates,
    reMint: freshResolve,
    start: range.start,
    end: range.end,
    concurrency: range.partial ? 2 : 4,
    tag: "download",
    signal,
  });
}

function buildHeaders(ext: string, filename: string, range: ParsedRange, total: number): Headers {
  const out = new Headers();
  out.set("Content-Type", MIME_MAP[ext] || "application/octet-stream");
  out.set("Content-Disposition", contentDisposition(filename));
  out.set("Cache-Control", "no-store");
  out.set("Accept-Ranges", "bytes");
  if (range.partial && total > 0) {
    const s = range.suffix !== null ? Math.max(0, total - range.suffix) : range.start;
    const e = Math.min(range.end < 0 ? total - 1 : range.end, total - 1);
    out.set("Content-Range", `bytes ${s}-${e}/${total}`);
    out.set("Content-Length", String(e - s + 1));
  } else if (!range.partial && total > 0) {
    out.set("Content-Length", String(total));
  }
  return out;
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const infoId = searchParams.get("infoId") || "";
  const formatId = searchParams.get("formatId") || "";
  const qualityLabel = searchParams.get("q") || "";
  if (!infoId || !formatId) {
    return NextResponse.json(
      { error: { code: "INVALID_URL", message: "Missing infoId or formatId." } },
      { status: 400 },
    );
  }

  const entry = getInfo(infoId);
  if (!entry) {
    return NextResponse.json(
      { error: { code: "EXPIRED", message: "Session expired — fetch the video again." } },
      { status: 410 },
    );
  }
  const raw: RawInfo = entry.raw;
  const stored = raw.formats.find((f) => f.format_id === formatId);
  if (!stored || !stored.url) {
    return NextResponse.json(
      { error: { code: "NO_FORMATS", message: "Unknown format." } },
      { status: 404 },
    );
  }

  const ext = (stored.ext || "mp4").toLowerCase();
  const filename = sanitizeFilename(
    `${raw.title || "video"}${qualityLabel ? ` (${qualityLabel})` : ""}.${ext}`,
  );
  const isYouTube = /youtube/i.test(raw.webpage_url);
  const isAudioOnly = stored.vcodec === "none";

  const selector = isYouTube
    ? isAudioOnly
      ? `${formatId}/bestaudio[acodec!=none]/best`
      : `${formatId}/22/18/best[acodec!=none][vcodec!=none]/best`
    : null;

  const freshResolve = (): Promise<string | null> =>
    selector ? resolveFormatUrl(raw.webpage_url, selector).catch(() => null) : Promise.resolve(null);

  // probe the stored URL first; the fresh mint is the recovery path
  const candidates = [stored.url];
  const range = parseRange(req.headers.get("range"));

  const result = await wireStream(candidates, freshResolve, range, req.signal);
  if (!result) {
    return NextResponse.json(
      { error: { code: "EXPIRED", message: "Media link expired — retry the download." } },
      { status: 502 },
    );
  }

  const { stream, totalSize } = result;
  const total = totalSize > 0 ? totalSize : -1;
  const headers = buildHeaders(ext, filename, range, total);
  return new Response(stream, { status: range.partial ? 206 : 200, headers });
}
