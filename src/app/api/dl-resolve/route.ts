import { NextResponse } from "next/server";

import { ensureFileForLink, type LinkSpec } from "@/lib/file-link";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * /api/dl-resolve — UI helper for the "Direct link" button.
 *
 * Resolves a selection to its stored direct link WITHOUT long-blocking:
 *
 *   ready  → { status:"ready", directUrl:"/api/file/<token>", filename, sizeBytes }
 *            the file is fully on the server; copy/paste the link anywhere.
 *   busy   → { status:"busy", jobId } the server started downloading the
 *            file first (fetch-first); the UI tracks the job and the direct
 *            link appears on the download row when it completes.
 *   failed → { status:"failed", code, message }
 *
 * POST JSON: { url, format, quality?, bitrate?, title? }
 */
export async function POST(req: Request): Promise<Response> {
  let body: {
    url?: string;
    format?: string;
    quality?: string;
    bitrate?: number;
    title?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: { code: "INVALID_URL", message: "Bad request." } }, { status: 400 });
  }

  const url = (body.url || "").trim();
  const format = (body.format || "").trim();
  if (!/^https?:\/\//i.test(url) || !format) {
    return NextResponse.json(
      { error: { code: "INVALID_URL", message: "Missing url or format." } },
      { status: 400 },
    );
  }

  const spec: LinkSpec = {
    webpageUrl: url,
    format,
    quality: body.quality || undefined,
    bitrate: body.bitrate || undefined,
    title: body.title || undefined,
  };

  const result = await ensureFileForLink(spec);

  if (result.kind === "ready") {
    return NextResponse.json({
      status: "ready",
      directUrl: `/api/file/${result.file.token}`,
      filename: result.file.filename,
      sizeBytes: result.file.sizeBytes,
    });
  }
  if (result.kind === "busy") {
    return NextResponse.json({ status: "busy", jobId: result.jobId ?? null });
  }
  return NextResponse.json(
    { status: "failed", code: result.code, message: result.message },
    { status: 502 },
  );
}
