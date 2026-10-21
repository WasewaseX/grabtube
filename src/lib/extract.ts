/**
 * Extraction orchestrator.
 *
 * Chain: yt-dlp (with client rotation) → Piped instances → Invidious instances.
 * Terminal video states (private / unavailable / live) stop immediately;
 * bot-checks, rate limits, timeouts and network failures fall through to the
 * community proxy APIs.
 */
import { DlError, fetchInfo, putInfo, toPublicInfo, type PublicInfo, type RawInfo } from "./ytdlp";
import { fetchViaProxies, parseVideoId } from "./providers";
import { activeLane, probeAll } from "./proxy";

const TERMINAL = new Set(["PRIVATE", "UNAVAILABLE", "LIVE", "AGE_RESTRICTED", "UNSUPPORTED_URL"]);

export async function extract(url: string): Promise<{ infoId: string; info: PublicInfo }> {
  // boxed so the closure below can mutate it without TS narrowing it to never
  const errRef: { current: DlError | null } = { current: null };

  const attempt = async (): Promise<{ infoId: string; info: PublicInfo } | null> => {
    try {
      const { infoId, raw } = await fetchInfo(url);
      return { infoId, info: toPublicInfo(infoId, raw) };
    } catch (e) {
      if (e instanceof DlError) {
        if (TERMINAL.has(e.code) || e.code === "INVALID_URL") throw e;
        errRef.current = e;
        // bot-walled? re-probe the lanes immediately — a recovered tunnel or
        // a healthier user proxy gets picked for the retry below
        if (e.code === "BOT_CHECK" || e.code === "RATE_LIMITED") await probeAll();
      } else {
        errRef.current = new DlError("FETCH_FAILED", "Unexpected engine failure.");
      }
      return null;
    }
  };

  /* ---------- 1. primary: yt-dlp (with one self-healing retry) ---------- */
  const first = await attempt();
  if (first) return first;
  if (errRef.current && (errRef.current.code === "BOT_CHECK" || errRef.current.code === "RATE_LIMITED")) {
    const lane = activeLane();
    if (lane.kind === "warp" || lane.kind === "user") {
      const second = await attempt(); // tunnel recovered mid-request → retry
      if (second) return second;
    }
  }

  /* ---------- 2. fallback: community proxy APIs ---------- */
  const videoId = parseVideoId(url);
  if (!videoId) throw errRef.current ?? new DlError("FETCH_FAILED", "Could not fetch this video.");

  let raw: RawInfo;
  try {
    raw = await fetchViaProxies(videoId);
  } catch {
    throw errRef.current ?? new DlError("FETCH_FAILED", "All extraction providers failed.");
  }

  if (raw.is_live) throw new DlError("LIVE", "Live streams cannot be downloaded.");

  const infoId = putInfo(raw);
  return { infoId, info: toPublicInfo(infoId, raw) };
}

/** True when the stored info came from a proxy provider (affects job routing). */
export function isProxySource(raw: RawInfo): boolean {
  return /:piped|:invidious/i.test(raw.extractor_key || "");
}
