import { NextResponse } from "next/server";
import { DlError, hasFfmpeg } from "@/lib/ytdlp";
import { jobSnapshot, pollFetch, startFetch } from "@/lib/fetch-queue";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const STATUS: Record<string, number> = {
  INVALID_URL: 400,
  PRIVATE: 422,
  UNAVAILABLE: 422,
  AGE_RESTRICTED: 422,
  LIVE: 422,
  NO_FORMATS: 422,
  UNSUPPORTED_URL: 422,
  BOT_CHECK: 502,
  RATE_LIMITED: 429,
  GEO_BLOCKED: 451,
  TIMEOUT: 504,
  FETCH_FAILED: 502,
  EXPIRED: 410,
  INTERNAL: 500,
};

function errorResponse(e: unknown) {
  if (e instanceof DlError) {
    return NextResponse.json(
      { error: { code: e.code, message: e.message, hint: e.hint } },
      { status: STATUS[e.code] ?? 500 },
    );
  }
  return NextResponse.json(
    { error: { code: "INTERNAL", message: "Unexpected server error." } },
    { status: 500 },
  );
}

/**
 * GET /api/info?u=<video url> — poll a background extraction job.
 * 200 done → {info, mp3}; 202 running → {pending, attempts, elapsedMs};
 * failed → the mapped error status.
 */
export async function GET(req: Request) {
  const url = new URL(req.url).searchParams.get("u")?.trim();
  if (!url) {
    return NextResponse.json(
      { error: { code: "INVALID_URL", message: "Missing URL." } },
      { status: 400 },
    );
  }
  const job = pollFetch(url);
  if (!job) {
    // unknown job (server restarted) → tell the client to resubmit
    return NextResponse.json({ pending: false, missing: true }, { status: 404 });
  }
  const snap = jobSnapshot(job);
  if (snap.state === "done" && snap.info) {
    return NextResponse.json({ info: snap.info, mp3: snap.mp3 ?? hasFfmpeg() });
  }
  if (snap.state === "running") {
    return NextResponse.json(
      { pending: true, attempts: snap.attempts, elapsedMs: snap.elapsedMs },
      { status: 202, headers: { "Retry-After": "5" } },
    );
  }
  // failed
  const code = snap.error?.code ?? "FETCH_FAILED";
  return NextResponse.json(
    {
      error: {
        code,
        message: snap.error?.message ?? "Extraction failed.",
        hint: snap.error?.hint,
        attempts: snap.attempts,
      },
    },
    { status: STATUS[code] ?? 502 },
  );
}

export async function POST(req: Request) {
  let body: { url?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: { code: "INVALID_URL", message: "Missing URL." } },
      { status: 400 },
    );
  }
  const url = (body.url || "").trim();
  if (!url) {
    return NextResponse.json(
      { error: { code: "INVALID_URL", message: "Missing URL." } },
      { status: 400 },
    );
  }

  // already running in the background? → answer as pending right away
  const running = pollFetch(url);
  if (running && running.state === "running") {
    const snap = jobSnapshot(running);
    return NextResponse.json(
      { pending: true, attempts: snap.attempts, elapsedMs: snap.elapsedMs },
      { status: 202, headers: { "Retry-After": "5" } },
    );
  }

  const job = startFetch(url);

  // fast path: a healthy tunnel phase settles the job inside 25 s — resolve
  // inline. The queue's OWN loop performs the extraction (no duplicate
  // yt-dlp spawns); we merely wait for it to leave the running state.
  const outcome = await Promise.race([
    job.info
      ? Promise.resolve({ kind: "done" as const })
      : job.settled?.then(() => ({ kind: "settled" as const })) ?? Promise.resolve({ kind: "settled" as const }),
    new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 25_000)),
  ]);

  const snap = jobSnapshot(job);
  if (snap.state === "done" && snap.info) {
    return NextResponse.json({ info: snap.info, mp3: snap.mp3 ?? hasFfmpeg() });
  }
  if (outcome !== "timeout" && snap.state === "failed" && snap.error) {
    return NextResponse.json(
      {
        error: {
          code: snap.error.code,
          message: snap.error.message,
          hint: snap.error.hint,
          attempts: snap.attempts,
        },
      },
      { status: STATUS[snap.error.code] ?? 502 },
    );
  }

  // transient or slow → the background loop owns it now; client polls GET
  return NextResponse.json(
    { pending: true, attempts: snap.attempts, elapsedMs: snap.elapsedMs },
    { status: 202, headers: { "Retry-After": "5" } },
  );
}
