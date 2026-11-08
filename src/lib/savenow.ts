/**
 * SAVENOW PROVIDER — reverse-engineered from the savefrom.net / loader.fo
 * family (the largest commercial YouTube-download backend still standing).
 *
 * Provenance (all of this was lifted from their shipped client code:
 *   loader.fo/js/shared/savenow-api.js + loader.fo/assets/v3/dist/app-compat.js):
 *
 *   1. GET  https://p.savenow.to/api/pow/challenge
 *        → { salt, difficulty, expires_at, signature }
 *   2. solve proof-of-work: find nonce where sha256hex(salt + ":" + nonce)
 *      starts with `difficulty` hex zeros (their JS ships a hand-rolled
 *      SHA-256; production difficulty is 3 → milliseconds of work)
 *   3. POST https://p.savenow.to/api/pow/verify
 *        { salt, difficulty, expires_at, signature, nonce }
 *        → { success, token, expires_at }        (JWT-ish, ~10 min TTL)
 *   4. GET  https://p.savenow.to/api/v2/download
 *        ?format=<q>&url=<enc watch-url>&apikey=<public key>
 *        Authorization: Bearer <token>
 *        → { success, id, progress_url, title, info.image, full_format }
 *   5. poll progress_url every ~1.5 s (their UI allows 120 attempts):
 *        ready   → { success:1, progress:1000, download_url, title, ... }
 *        working → { text: "Preparing streaming download" }
 *        dead    → success:0 / error / status in [failed, cancelled, ...]
 *
 *   The final download_url lives on their CDN (emmaNN.savenow.to) as a
 *   complete, muxed MP4 / audio file with Content-Disposition — our middleman
 *   pulls it server-side and re-serves it with proper Range/resume support.
 *
 * Public api key + formats (videoQualities / audioQualities maps in their
 * bundle): video 144,240,360,480,720,1080,1440,4k,8k — audio
 * mp3,m4a,webm,aac,flac,opus,ogg,wav.
 *
 * Why this matters: when YouTube bot-walls our egress AND every community
 * instance (Piped/Invidious) is down, this backend still extracts — it runs
 * its own cookie/session farm server-side. It turned the "Route busy forever"
 * dead-end into a working path (verified live end-to-end).
 */
import { createHash } from "crypto";

import type { RawInfo, YtRawFormat } from "./ytdlp";

const HOST = "https://p.savenow.to";
const API_KEY = "REDACTED_COMMUNITY_KEY";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const TOKEN_SKEW_MS = 30_000;
const START_TIMEOUT_MS = 20_000;
const RESOLVE_TIMEOUT_MS = 150_000;
const POLL_INTERVAL_MS = 2_500;

export const SAVENOW_QUALITIES = ["144", "240", "360", "480", "720", "1080", "1440", "4k"] as const;
export type SavenowVideoFormat = (typeof SAVENOW_QUALITIES)[number];
// NOTE: only "mp3" is synthesized as a stream — our urlaudio job re-encodes
// any audio input to mp3 anyway, so an m4a placeholder would mislabel bytes
export const SAVENOW_AUDIO_FORMATS = ["mp3"] as const;
export type SavenowAudioFormat = (typeof SAVENOW_AUDIO_FORMATS)[number];
export type SavenowFormat = SavenowVideoFormat | SavenowAudioFormat;

/** Placeholder URL scheme embedded in synthesized RawInfo formats — never
 *  fetched directly; jobs resolve it lazily right before spawning ffmpeg. */
export function savenowPlaceholder(videoId: string, format: string): string {
  return `savenow://${videoId}/${format}`;
}

export function isSavenowPlaceholder(url: string | undefined): boolean {
  return !!url && url.startsWith("savenow://");
}

export function parseSavenowPlaceholder(
  url: string | undefined,
): { videoId: string; format: string } | null {
  if (!isSavenowPlaceholder(url)) return null;
  const m = (url || "").match(/^savenow:\/\/([\w-]+)\/([\w]+)$/);
  return m ? { videoId: m[1], format: m[2] } : null;
}

export function isSavenowSource(raw: { extractor_key?: string }): boolean {
  return /:savenow/i.test(raw.extractor_key || "");
}

/* HTTP + PoW                                                          */

const JSON_HEADERS = { "User-Agent": UA, Accept: "application/json" } as const;

type GrabInit = RequestInit & { auth?: string; timeoutMs?: number };

async function grabJson(
  url: string,
  init: GrabInit = {},
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const headers: Record<string, string> = { ...JSON_HEADERS };
  if (init.auth) headers.Authorization = `Bearer ${init.auth}`;
  if (init.body) headers["Content-Type"] = "application/json";
  try {
    const res = await fetch(url, {
      method: init.method || "GET",
      headers,
      body: init.body,
      signal: AbortSignal.timeout(init.timeoutMs ?? START_TIMEOUT_MS),
      cache: "no-store",
    });
    const text = await res.text();
    try {
      return { status: res.status, body: JSON.parse(text) as Record<string, unknown> };
    } catch {
      console.log(`[savenow] grabJson non-JSON response from ${new URL(url).host}${new URL(url).pathname}: ${text.slice(0, 120)}`);
      return { status: res.status, body: null };
    }
  } catch (e) {
    console.log(`[savenow] grabJson failed for ${new URL(url).host}${new URL(url).pathname}: ${(e as Error)?.name}: ${(e as Error)?.message}`);
    return { status: 0, body: null };
  }
}

interface TokenState {
  token: string;
  expiresAt: number;
  inflight?: Promise<string | null>;
}
declare global {
  var __tgSavenowToken: TokenState | undefined;
}

function solvePow(salt: string, difficulty: number, budgetMs = 8_000): number | null {
  if (!Number.isFinite(difficulty) || difficulty < 0 || difficulty > 8) return null;
  const prefix = "0".repeat(difficulty);
  const started = Date.now();
  let nonce = 0;
  while (Date.now() - started < budgetMs) {
    const hex = createHash("sha256").update(`${salt}:${nonce}`).digest("hex");
    if (hex.startsWith(prefix)) return nonce;
    nonce++;
  }
  return null;
}

/** Mint (or reuse a cached) PoW Bearer token. Single-flighted. */
export async function powToken(force = false): Promise<string | null> {
  const st = globalThis.__tgSavenowToken ?? { token: "", expiresAt: 0 };
  if (!force && st.token && Date.now() < st.expiresAt - TOKEN_SKEW_MS) return st.token;
  if (st.inflight) return st.inflight;

  st.inflight = (async () => {
    const ch = await grabJson(`${HOST}/api/pow/challenge`, { timeoutMs: 12_000 });
    const salt = ch.body?.salt as string | undefined;
    const difficulty = Number(ch.body?.difficulty);
    const expiresAt = Number(ch.body?.expires_at);
    const signature = ch.body?.signature as string | undefined;
    if (ch.status !== 200 || !salt || !signature) return null;

    const nonce = solvePow(salt, difficulty);
    if (nonce == null) return null;

    const vf = await grabJson(`${HOST}/api/pow/verify`, {
      method: "POST",
      body: JSON.stringify({ salt, difficulty, expires_at: expiresAt, signature, nonce }),
      timeoutMs: 12_000,
    });
    const token = vf.body?.token as string | undefined;
    const expMs = Number(vf.body?.expires_at) * 1000 || Date.now() + 9 * 60_000;
    if (vf.status !== 200 || !token) return null;

    st.token = token;
    st.expiresAt = expMs;
    return token;
  })().finally(() => {
    st.inflight = undefined;
  });

  globalThis.__tgSavenowToken = st;
  return st.inflight;
}

/* Start + poll                                                        */

export interface SavenowStart {
  id: string;
  progressUrl: string;
  title?: string;
  thumbnail?: string;
  fullFormat?: string;
}

/** Start their server-side conversion for one format. Returns immediately
 *  with the progress handle (their backend does the YouTube work). */
export async function savenowStart(videoId: string, format: string): Promise<SavenowStart | null> {
  const token = await powToken();
  if (!token) return null;
  const watch = encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`);
  const res = await grabJson(
    `${HOST}/api/v2/download?format=${encodeURIComponent(format)}&url=${watch}&apikey=${API_KEY}`,
    { auth: token, timeoutMs: START_TIMEOUT_MS },
  );
  const body = res.body;
  if (res.status !== 200 || !body || !body.success || !body.id || !body.progress_url) {
    console.log(
      `[savenow] start(${format}) non-success: status=${res.status} body=${JSON.stringify(body ?? null).slice(0, 220)}`,
    );
    // token might have expired server-side → one forced re-mint retry
    if (res.status === 401 || res.status === 403) {
      const fresh = await powToken(true);
      if (!fresh) return null;
      const retry = await grabJson(
        `${HOST}/api/v2/download?format=${encodeURIComponent(format)}&url=${watch}&apikey=${API_KEY}`,
        { auth: fresh, timeoutMs: START_TIMEOUT_MS },
      );
      const rb = retry.body;
      if (retry.status === 200 && rb?.success && rb.id && rb.progress_url) {
        return {
          id: String(rb.id),
          progressUrl: String(rb.progress_url),
          title: (rb.title as string) || undefined,
          thumbnail: ((rb.info as { image?: string })?.image as string) || undefined,
          fullFormat: (rb.full_format as string) || undefined,
        };
      }
    }
    return null;
  }
  return {
    id: String(body.id),
    progressUrl: String(body.progress_url),
    title: (body.title as string) || undefined,
    thumbnail: ((body.info as { image?: string })?.image as string) || undefined,
    fullFormat: (body.full_format as string) || undefined,
  };
}

const TERMINAL_TEXT =
  /(^|\b)(error|failed|failure|unavailable|removed|private|unsupported|cancelled|canceled|expired|not_found)/i;

/** Poll a started job until the CDN link materializes (or it dies). */
export async function savenowWaitReady(start: SavenowStart): Promise<string | null> {
  const token = await powToken();
  const deadline = Date.now() + RESOLVE_TIMEOUT_MS;
  let first = true;
  while (Date.now() < deadline) {
    const res = await grabJson(start.progressUrl, {
      auth: token || undefined,
      timeoutMs: 15_000,
    });
    const b = res.body;
    if (res.status === 200 && b) {
      if (first) {
        console.log(
          `[savenow] progress(${start.id}): ${JSON.stringify(b).slice(0, 220)}`,
        );
        first = false;
      }
      const url =
        (b.download_url as string) ||
        (b.url as string) ||
        (b.downloadUrl as string) ||
        (b.file_url as string) ||
        (b.file as string) ||
        (b.link as string);
      if (url && /^https:\/\//.test(url)) return url;
      // EXACT semantics lifted from their client (app-compat.js):
      //   success === false (boolean)          → terminal
      //   Number(success) === 0 ONLY counts as dead when progress >= 1000
      //   (finished without a file); while preparing, success may be 0/absent
      const successRaw = (b as { success?: unknown }).success;
      const successNum = Number(successRaw);
      const progress = Number(b.progress);
      const text = String(b.text || "");
      const status = String(b.status || "");
      const finishedWithoutFile = successNum === 0 && progress >= 1000;
      if (
        successRaw === false ||
        finishedWithoutFile ||
        b.error ||
        TERMINAL_TEXT.test(status) ||
        (TERMINAL_TEXT.test(text) && text.toLowerCase() !== "finished")
      ) {
        console.log(
          `[savenow] progress(${start.id}) terminal: ${JSON.stringify(b).slice(0, 200)}`,
        );
        return null;
      }
    }
    if (first) {
      // token may have lapsed mid-poll — refresh once
      void powToken();
      first = false;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  console.log(`[savenow] progress(${start.id}) wait deadline exceeded`);
  return null;
}

/** Full resolution: start + wait → final CDN URL (our middleman pulls it). */
export async function resolveSavenowUrl(
  videoId: string,
  format: string,
): Promise<{ url: string; title?: string; thumbnail?: string } | null> {
  const start = await savenowStart(videoId, format);
  if (!start) return null;
  const url = await savenowWaitReady(start);
  if (!url) return null;
  return { url, title: start.title, thumbnail: start.thumbnail };
}

/* Info synthesis — full quality menu from ONE lightweight start call   */

const HEIGHTS: Record<string, number> = {
  "144": 144,
  "240": 240,
  "360": 360,
  "480": 480,
  "720": 720,
  "1080": 1080,
  "1440": 1440,
  "4k": 2160,
};

/**
 * Synthesize a yt-dlp-shaped RawInfo for a video using ONLY the cheap start
 * response (title + thumbnail arrive instantly — no polling needed). Formats
 * carry `savenow://` placeholders; the job engine resolves them lazily right
 * before spawning ffmpeg, so the user sees a full quality menu immediately.
 */
export async function savenowInfo(videoId: string): Promise<RawInfo | null> {
  const start = await savenowStart(videoId, "360"); // cheapest probe with full metadata
  if (!start) return null;

  const formats: YtRawFormat[] = [];
  for (const q of SAVENOW_QUALITIES) {
    formats.push({
      format_id: `sn-${q}`,
      ext: "mp4",
      url: savenowPlaceholder(videoId, q),
      vcodec: "avc1.640028",
      acodec: "mp4a.40.2",
      height: HEIGHTS[q],
      width: Math.round((HEIGHTS[q] * 16) / 9),
      fps: q === "4k" ? 60 : 30,
      protocol: "",
      format_note: "community mirror",
    });
  }
  for (const a of SAVENOW_AUDIO_FORMATS) {
    formats.push({
      format_id: `sn-${a}`,
      ext: a,
      url: savenowPlaceholder(videoId, a),
      vcodec: "none",
      acodec: a === "mp3" ? "mp3" : "mp4a.40.2",
      abr: a === "mp3" ? 320 : 256,
      tbr: a === "mp3" ? 320 : 256,
      protocol: "",
      format_note: "community mirror",
    });
  }

  return {
    id: videoId,
    title: start.title || "YouTube video",
    uploader: "",
    duration: 0,
    thumbnail: start.thumbnail || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    webpage_url: `https://www.youtube.com/watch?v=${videoId}`,
    is_live: false,
    live_status: "not_live",
    extractor_key: "Youtube:Savenow",
    formats,
  };
}
