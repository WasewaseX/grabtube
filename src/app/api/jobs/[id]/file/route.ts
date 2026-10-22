import { NextResponse } from "next/server";
import { jobFilePath, markServed } from "@/lib/jobs";
import { statSync, createReadStream } from "fs";
import { Readable } from "stream";
import { contentDisposition } from "@/lib/http-utils";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Streams a finished merge/MP3/file job. Range requests are honored so the
 *  in-app downloader and external managers (IDM/aria2 on slow networks) can
 *  resume after a mid-transfer disconnect. Every hit touches the job's
 *  serve timestamp, which keeps the TTL cleaner away from files that are
 *  still being downloaded. Files are kept for hours — the link stays valid
 *  so it can be re-pasted or resumed at any time. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const found = jobFilePath(id);
  if (!found) {
    return NextResponse.json(
      { error: { code: "NOT_FOUND", message: "Job file not available." } },
      { status: 404 },
    );
  }
  const st = statSync(found.path);
  const size = st.size;
  const disposition = contentDisposition(found.job.filename);

  /* ---------- Range parsing ---------- */
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

  const nodeStream = createReadStream(found.path, { start, end });
  req.signal.addEventListener("abort", () => {
    nodeStream.destroy();
  });

  markServed(id); // touch (never delete-under-downloader; TTL cleaner handles removal)

  const out = new Headers();
  out.set("Content-Type", found.job.mime);
  out.set("Content-Disposition", disposition);
  out.set("Cache-Control", "no-store");
  out.set("Accept-Ranges", "bytes");
  out.set("Content-Length", String(end - start + 1));
  if (partial) out.set("Content-Range", `bytes ${start}-${end}/${size}`);

  const stream = Readable.toWeb(nodeStream) as unknown as ReadableStream;

  return new Response(stream, { status: partial ? 206 : 200, headers: out });
}
