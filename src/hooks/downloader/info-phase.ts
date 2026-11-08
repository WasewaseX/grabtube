import type { PublicInfo } from "@/lib/ytdlp";

import { delay } from "./api-client";
import type { InfoPhase } from "./types";

/** UI setters the info phase drives; mirrors the hook's info state. */
export interface InfoUi {
  setPhase: (phase: InfoPhase) => void;
  setInfo: (info: PublicInfo | null) => void;
  setErrorMsg: (msg: string | null) => void;
  setErrorCode: (code: string | null) => void;
  setPendingNote: (note: string | null) => void;
}

/**
 * Honest status ladder for the extraction poll: the server cycles through
 * yt-dlp → Piped/Invidious mirrors → the community-mirror backend on every
 * attempt; the copy reflects what actually happens at each stage.
 */
function pendingStatus(attempts: number, elapsedMs: number): string {
  if (attempts <= 1) return "Connecting to YouTube…";
  if (attempts <= 3) return `YouTube is throttling this route — retrying (attempt ${attempts})…`;
  if (elapsedMs > 180_000)
    return `Still working — the mirror farm is preparing your file (attempt ${attempts})…`;
  return `YouTube blocked us — community mirrors engaged (attempt ${attempts})…`;
}

function failInfo(ui: InfoUi, code: string, message: string): void {
  ui.setPhase("error");
  ui.setPendingNote(null);
  ui.setErrorCode(code);
  ui.setErrorMsg(message);
}

/** Consume a finished /api/info response: fill the card or surface the error. */
async function acceptFinalInfo(res: Response, ui: InfoUi): Promise<void> {
  const json = await res.json();
  if (!res.ok || json.error) {
    failInfo(ui, json?.error?.code || "FETCH_FAILED", json?.error?.message || "Failed");
    return;
  }
  ui.setInfo(json.info as PublicInfo);
  ui.setPendingNote(null);
  ui.setPhase("ready");
}

/** Poll a 202 "pending" session until done, failed, or the 12 min deadline. */
async function pollPendingInfo(clean: string, ui: InfoUi): Promise<void> {
  const deadline = Date.now() + 12 * 60_000;
  while (Date.now() < deadline) {
    await delay(4_000);
    const pr = await fetch(`/api/info?u=${encodeURIComponent(clean)}`, {
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    if (!pr) {
      ui.setPendingNote("Reconnecting…");
      continue;
    }
    if (pr.status === 200) {
      const json = await pr.json();
      if (json?.info) {
        ui.setInfo(json.info as PublicInfo);
        ui.setPhase("ready");
        ui.setPendingNote(null);
        return;
      }
      continue;
    }
    if (pr.status === 202) {
      const j = await pr.json().catch(() => null);
      ui.setPendingNote(pendingStatus(j?.attempts ?? 0, j?.elapsedMs ?? 0));
      continue;
    }
    const j = await pr.json().catch(() => null);
    failInfo(ui, j?.error?.code || "FETCH_FAILED", j?.error?.message || "Failed");
    return;
  }
  failInfo(ui, "TIMEOUT", "The engine could not reach YouTube in time — try again in a few minutes.");
}

export async function fetchVideoInfo(rawUrl: string, ui: InfoUi): Promise<void> {
  const clean = rawUrl.trim();
  if (!clean) return;
  ui.setPhase("loading");
  ui.setErrorMsg(null);
  ui.setErrorCode(null);
  try {
    const res = await fetch("/api/info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: clean }),
      // the server answers within ~26 s: either the result or a 202
      // "pending" that its background retry loop now owns
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 202) {
      // cobalt-style session: the server keeps retrying through tunnel
      // phases — poll until done / failed / user gives up
      await pollPendingInfo(clean, ui);
      return;
    }
    await acceptFinalInfo(res, ui);
  } catch (e) {
    const aborted = e instanceof DOMException && e.name === "TimeoutError";
    failInfo(
      ui,
      "FETCH_FAILED",
      aborted
        ? "The engine took too long — the tunnel is congested. Try again in a minute."
        : "Network error",
    );
  }
}
