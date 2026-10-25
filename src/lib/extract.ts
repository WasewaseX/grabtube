/**
 * Extraction orchestrator — the multi-layer fallback chain.
 *
 *   1. yt-dlp (local engine: WARP egress + PO tokens + JS challenge solver)
 *   2. Piped / Invidious community instance fleet (raced in parallel)
 *   3. Savenow — reverse-engineered savefrom.net / loader.fo commercial
 *      backend (their own server-side cookie farm does the extraction and
 *      hosts the finished file on their CDN)
 *
 * Terminal video states (private / unavailable / live) stop immediately;
 * bot-checks, rate limits, timeouts and network failures fall through to
 * the next layer.
 */
import { DlError, fetchInfo, putInfo, toPublicInfo, type PublicInfo, type RawInfo } from "./ytdlp";
import { fetchViaProxies, parseVideoId } from "./providers";
import { savenowInfo } from "./savenow";

const TERMINAL = new Set(["PRIVATE", "UNAVAILABLE", "LIVE", "AGE_RESTRICTED", "UNSUPPORTED_URL"]);

/**
 * One extraction pass over the whole chain. Returns the stored infoId + the
 * raw payload (shared store — jobs and direct links read the same entry).
 */
export async function ensureRawInfo(url: string): Promise<{ infoId: string; raw: RawInfo }> {
  const errRef: { current: DlError | null } = { current: null };

  /* ---------- 1. primary: yt-dlp (single pass) ---------- */
  // NOTE: no internal retry here — the fetch-queue owns retry cycling now
  // (shorter attempts = faster rotation through tunnel phases).
  try {
    const { infoId, raw } = await fetchInfo(url);
    return { infoId, raw };
  } catch (e) {
    if (e instanceof DlError) {
      if (TERMINAL.has(e.code) || e.code === "INVALID_URL") throw e;
      errRef.current = e;
    } else {
      errRef.current = new DlError("FETCH_FAILED", "Unexpected engine failure.");
    }
  }

  const videoId = parseVideoId(url);
  if (!videoId) throw errRef.current ?? new DlError("FETCH_FAILED", "Could not fetch this video.");

  /* ---------- 2. community proxy fleet (Piped + Invidious, raced) ---------- */
  try {
    const raw = await fetchViaProxies(videoId);
    if (!raw.is_live) {
      const infoId = putInfo(raw);
      return { infoId, raw };
    }
    throw new DlError("LIVE", "Live streams cannot be downloaded.");
  } catch {
    /* fall through to the commercial backend */
  }

  /* ---------- 3. savenow (savefrom.net / loader.fo backend) ---------- */
  const snRaw = await savenowInfo(videoId).catch(() => null);
  if (snRaw) {
    const infoId = putInfo(snRaw);
    return { infoId, raw: snRaw };
  }

  throw errRef.current ?? new DlError("FETCH_FAILED", "All extraction providers failed.");
}

export async function extract(url: string): Promise<{ infoId: string; info: PublicInfo }> {
  const { infoId, raw } = await ensureRawInfo(url);
  return { infoId, info: toPublicInfo(infoId, raw) };
}

/** True when the stored info came from a proxy provider (affects job routing). */
export function isProxySource(raw: RawInfo): boolean {
  return /:piped|:invidious|:savenow/i.test(raw.extractor_key || "");
}
