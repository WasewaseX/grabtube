import { NextResponse } from "next/server";
import { execFile } from "child_process";
import { getYtDlpPath, getFfmpegPath, hasFfmpeg, getDenoPath, POT_SERVER_URL, CLIENT_CHAIN } from "@/lib/ytdlp";
import { ensurePotServer } from "@/lib/pot";
import { laneSnapshot, probeAll } from "@/lib/proxy";
import { instances } from "@/lib/providers";
import { getSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

function toolVersion(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 10000 }, (err, stdout) => {
      resolve(err ? null : String(stdout ?? "").trim().split("\n")[0]);
    });
  });
}

async function potStatus(): Promise<string> {
  const up = await ensurePotServer();
  if (!up) return "offline";
  try {
    const res = await fetch(`${POT_SERVER_URL}/ping`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return "offline";
    const data = (await res.json()) as { version?: string };
    return `online v${data.version ?? "?"}`;
  } catch {
    return "offline";
  }
}

export async function GET() {
  const [ytDlp, deno, pot] = await Promise.all([
    toolVersion(getYtDlpPath(), ["--version"]),
    toolVersion(getDenoPath(), ["--version"]),
    potStatus(),
  ]);

  // best-effort lane refresh so the UI shows fresh state
  void probeAll().catch(() => undefined);

  let cookies = false;
  try {
    const s = await getSettings();
    cookies = Boolean(s.cookies && s.cookies.trim());
  } catch {
    /* ignore */
  }

  return NextResponse.json({
    engine: ytDlp ?? null,
    ffmpeg: hasFfmpeg(),
    cookies,
    clients: CLIENT_CHAIN.length,
    lanes: laneSnapshot(),
    providers: instances().map((i) => i.name),
    // extended toolchain info
    ytDlp: ytDlp ?? "not found",
    ffmpegVersion: hasFfmpeg() ? (getFfmpegPath() ?? "") : "",
    deno: deno ?? "not found",
    pot,
  });
}
