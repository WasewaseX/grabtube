import { NextResponse } from "next/server";
import { DlError, hasFfmpeg } from "@/lib/ytdlp";
import { extract } from "@/lib/extract";

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

  try {
    const { info } = await extract(url);
    return NextResponse.json({ info, mp3: hasFfmpeg() });
  } catch (e) {
    return errorResponse(e);
  }
}
