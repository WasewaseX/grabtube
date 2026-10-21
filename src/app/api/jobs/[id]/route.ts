import { NextResponse } from "next/server";
import { jobStore, publicJob, cancelJob } from "@/lib/jobs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Job status for the in-app downloader poll loop. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const job = jobStore().get(id);
  if (!job) {
    return NextResponse.json(
      { error: { code: "NOT_FOUND", message: "Download job not found." } },
      { status: 404 },
    );
  }
  return NextResponse.json({ job: publicJob(job) });
}

/** Cancel a running/conversion job and delete its artifacts. */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const ok = cancelJob(id);
  if (!ok) {
    return NextResponse.json(
      { error: { code: "NOT_FOUND", message: "Download job not found." } },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true });
}
