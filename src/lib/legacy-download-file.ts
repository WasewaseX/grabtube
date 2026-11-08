import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { createReadStream, statSync } from "fs";
import { Readable } from "stream";
import { contentDisposition } from "@/lib/http-utils";

/**
 * Legacy download-id file serving.
 *
 * The first-generation engine (src/lib/engine.ts, still used by the internal
 * /api/stress harness) stores finished files on db.download rows and hands
 * out directUrl: /api/file/<jobId>. It used to live in its own dynamic slug
 * (src/app/api/file/[id]) — which collided with /api/file/[token] and killed
 * the whole route group at boot ("You cannot use different slug names for the
 * same dynamic path"). Both handlers now live under the single [token] slug:
 * canonical stored-token lookup first, this legacy lookup second.
 *
 * Full HTTP Range/206 support — download managers (IDM/aria2/wget -c) can
 * resume after a mid-transfer disconnect.
 */

function safeFileStream(filepath: string, range?: { start: number; end: number }): ReadableStream {
  const rs = createReadStream(filepath, range);
  // prevent unhandled 'error' events (e.g. client aborts) from crashing the server
  rs.on("error", () => rs.destroy());
  return Readable.toWeb(rs) as ReadableStream;
}

function guessContentType(filename: string, container?: string | null): string {
  const ext = (filename.split(".").pop() ?? container ?? "mp4").toLowerCase();
  const map: Record<string, string> = {
    mp4: "video/mp4",
    webm: "video/webm",
    mkv: "video/x-matroska",
    m4a: "audio/mp4",
    mp3: "audio/mpeg",
    opus: "audio/opus",
    ogg: "audio/ogg",
    flac: "audio/flac",
    wav: "audio/wav",
  };
  return map[ext] ?? "application/octet-stream";
}

/** Serve a finished legacy Download row by id. Returns null when the id is
 *  unknown so the caller can answer 404 for the canonical token path. */
export async function serveLegacyDownload(req: Request, id: string): Promise<Response | null> {
  const job = await db.download.findUnique({ where: { id } }).catch(() => null);
  if (!job) return null;

  if (job.status !== "completed" || !job.filepath) {
    return NextResponse.json(
      { error: "File is not ready yet", status: job.status, progress: job.progress },
      { status: 409 },
    );
  }

  let fileSize: number;
  try {
    fileSize = statSync(job.filepath).size;
  } catch {
    return NextResponse.json({ error: "File missing on disk. Retry the download." }, { status: 410 });
  }

  const filename = job.filename ?? `video-${id}.mp4`;
  const contentType = guessContentType(filename, job.container);

  const baseHeaders: Record<string, string> = {
    "Accept-Ranges": "bytes",
    "Content-Disposition": contentDisposition(filename),
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "X-Download-Id": id,
  };

  // ---- HTTP Range support (mandatory for IDM / wget -c / curl resume) ----
  const rangeHeader = req.headers.get("range");
  const m = rangeHeader?.match(/bytes=(\d*)-(\d*)/);
  if (m) {
    let start = m[1] ? parseInt(m[1], 10) : 0;
    let end = m[2] ? parseInt(m[2], 10) : fileSize - 1;
    if (isNaN(start) || start < 0) start = 0;
    if (isNaN(end) || end >= fileSize) end = fileSize - 1;

    if (start > end || start >= fileSize) {
      return new NextResponse(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${fileSize}`, ...baseHeaders },
      });
    }

    const chunkSize = end - start + 1;
    return new NextResponse(safeFileStream(job.filepath, { start, end }), {
      status: 206,
      headers: {
        ...baseHeaders,
        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
        "Content-Length": String(chunkSize),
      },
    });
  }

  return new NextResponse(safeFileStream(job.filepath), {
    status: 200,
    headers: { ...baseHeaders, "Content-Length": String(fileSize) },
  });
}

/** HEAD probe for legacy rows (download managers check availability first). */
export async function headLegacyDownload(id: string): Promise<Response | null> {
  const job = await db.download.findUnique({ where: { id } }).catch(() => null);
  if (!job || job.status !== "completed" || !job.filepath) {
    return job ? new NextResponse(null, { status: 409 }) : null;
  }
  try {
    const size = statSync(job.filepath).size;
    return new NextResponse(null, {
      status: 200,
      headers: {
        "Accept-Ranges": "bytes",
        "Content-Length": String(size),
        "Content-Disposition": contentDisposition(job.filename ?? `video-${id}.mp4`),
        "Content-Type": guessContentType(job.filename ?? "", job.container),
      },
    });
  } catch {
    return new NextResponse(null, { status: 410 });
  }
}
