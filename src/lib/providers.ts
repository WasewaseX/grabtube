/**
 * Fallback extraction providers – the community proxy tools built exactly for
 * talking to YouTube when the local IP is bot-flagged / rate-limited:
 *
 *   • Piped     – open-source YouTube proxy API (github.com/TeamPiped/Piped)
 *   • Invidious – open-source YouTube front-end API (github.com/iv-org/invidious)
 *
 * Both are converted into the same `RawInfo` shape yt-dlp produces so the rest
 * of the pipeline (format table, streaming proxy, merge jobs) is shared.
 *
 * Instance lists can be extended at runtime with the PROXY_INSTANCES env var
 * (comma-separated base URLs, e.g. "https://pipedapi.example.tld,https://inv.example.tld").
 */
import type { RawInfo, YtRawFormat } from "./ytdlp";

/* ------------------------------------------------------------------ */
/* Instance registry                                                   */
/* ------------------------------------------------------------------ */

export interface Instance {
  name: string;
  kind: "piped" | "invidious";
  base: string;
}

const BUILTIN: Instance[] = [
  { name: "piped.private.coffee", kind: "piped", base: "https://api.piped.private.coffee" },
  { name: "piped.adminforge", kind: "piped", base: "https://pipedapi.adminforge.de" },
  { name: "piped.kavin", kind: "piped", base: "https://pipedapi.kavin.rocks" },
  { name: "invidious.f5.si", kind: "invidious", base: "https://invidious.f5.si" },
  { name: "invidious.nadeko", kind: "invidious", base: "https://inv.nadeko.net" },
];

export function instances(): Instance[] {
  const extra = (process.env.PROXY_INSTANCES || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map<Instance>((base) => ({
      name: new URL(base.includes("://") ? base : `https://${base}`).host,
      kind: /piped/i.test(base) ? "piped" : "invidious",
      base: base.includes("://") ? base.replace(/\/$/, "") : `https://${base}`.replace(/\/$/, ""),
    }));
  const discovered = (globalThis.__tgDiscoveredInstances as Instance[] | undefined) ?? [];
  const seen = new Set([...BUILTIN, ...extra].map((i) => i.base));
  return [...BUILTIN, ...extra, ...discovered.filter((i) => !seen.has(i.base))];
}

/* ------------------------------------------------------------------ */
/* URL → videoId                                                       */
/* ------------------------------------------------------------------ */

export function parseVideoId(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname.replace(/^www\./, "") === "youtu.be") {
      return u.pathname.slice(1).split("/")[0] || null;
    }
    if (/youtube(-nocookie)?\.com$/i.test(u.hostname.replace(/^www\./, ""))) {
      if (u.pathname === "/watch") return u.searchParams.get("v");
      const m = u.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]{6,})/);
      if (m) return m[1];
    }
    return null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* fetch with timeout + UA (some instances require a browser-ish UA)   */
/* ------------------------------------------------------------------ */

async function grab(url: string, timeoutMs = 12_000): Promise<unknown | null> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        Accept: "application/json",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

function parseMime(mime?: string): { ext: string; codecs: string[] } {
  const [type, codecsPart] = (mime || "").split(";");
  const ext = (type || "").split("/")[1]?.trim() || "mp4";
  const codecs: string[] = [];
  const m = (codecsPart || "").match(/codecs="?([^"]*)"?/);
  if (m) codecs.push(...m[1].split(",").map((c) => c.trim()).filter(Boolean));
  return { ext: ext.toLowerCase(), codecs };
}

function codecArgs(kind: "video" | "audio", codecLabel: string): string {
  // Piped gives labels like "H.264", "VP9", "AV1", "opus", "mp4a"
  const c = codecLabel.toLowerCase();
  if (kind === "video") {
    if (c.includes("264") || c.includes("avc")) return "avc1.640028";
    if (c.includes("vp9") || c.includes("vp09")) return "vp9";
    if (c.includes("vp8")) return "vp8";
    if (c.includes("av1")) return "av01.0.08M.08";
    return "unknown";
  }
  if (c.includes("opus")) return "opus";
  if (c.includes("mp4a") || c.includes("aac")) return "mp4a.40.2";
  if (c.includes("vorbis")) return "vorbis";
  return "unknown";
}

/* ------------------------------------------------------------------ */
/* Piped adapter                                                       */
/* ------------------------------------------------------------------ */

interface PipedStream {
  url?: string;
  quality?: string;
  mimeType?: string;
  codec?: string;
  bitrate?: number;
  contentLength?: number;
  videoOnly?: boolean;
  width?: number;
  height?: number;
  fps?: number;
  format?: string; // "MPEG_4" | "WEBM" | "M4A" | ...
}

function pipedToRaw(data: Record<string, unknown>): RawInfo | null {
  const videos = (data.videoStreams as PipedStream[] | undefined) || [];
  const audios = (data.audioStreams as PipedStream[] | undefined) || [];
  const formats: YtRawFormat[] = [];

  for (const s of videos) {
    if (!s.url) continue;
    const { ext } = parseMime(s.mimeType);
    const vc = s.codec ? codecArgs("video", s.codec) : "unknown";
    const hasAudio = s.videoOnly === false && !!s.codec && !s.codec.toLowerCase().includes("hls");
    formats.push({
      format_id: `piped-v-${s.bitrate || s.quality || Math.random().toString(36).slice(2, 6)}`,
      ext: s.format === "WEBM" || ext === "webm" ? "webm" : "mp4",
      url: s.url,
      vcodec: vc,
      acodec: hasAudio ? "mp4a.40.2" : "none",
      height: s.height || parseInt(s.quality || "") || undefined,
      width: s.width,
      fps: s.fps || undefined,
      tbr: s.bitrate ? Math.round(s.bitrate / 1000) : undefined,
      filesize: s.contentLength || undefined,
      protocol: "https",
    });
  }
  for (const s of audios) {
    if (!s.url) continue;
    const { ext } = parseMime(s.mimeType);
    formats.push({
      format_id: `piped-a-${s.bitrate || Math.random().toString(36).slice(2, 6)}`,
      ext: ext === "webm" ? "webm" : "m4a",
      url: s.url,
      vcodec: "none",
      acodec: s.codec ? codecArgs("audio", s.codec) : "mp4a.40.2",
      abr: s.bitrate ? Math.round(s.bitrate / 1000) : undefined,
      tbr: s.bitrate ? Math.round(s.bitrate / 1000) : undefined,
      filesize: s.contentLength || undefined,
      protocol: "https",
    });
  }

  if (formats.length === 0) return null;
  return {
    id: String(data.id || ""),
    title: String(data.title || "Untitled"),
    uploader: String(data.uploader || ""),
    duration: Number(data.duration || 0),
    view_count: Number(data.views || 0),
    thumbnail: String(data.thumbnailUrl || ""),
    webpage_url: `https://www.youtube.com/watch?v=${String(data.id || "")}`,
    is_live: !!data.livestream,
    live_status: data.livestream ? "is_live" : "not_live",
    extractor_key: "Youtube:Piped",
    formats,
  };
}

/* ------------------------------------------------------------------ */
/* Invidious adapter                                                   */
/* ------------------------------------------------------------------ */

interface InvFormat {
  itag?: string;
  url?: string;
  type?: string;
  container?: string;
  qualityLabel?: string;
  encoding?: string;
  bitrate?: string | number;
  clen?: string | number;
  fps?: number;
  quality?: string;
  size?: string;
}

function invToRaw(data: Record<string, unknown>): RawInfo | null {
  const fmtStreams = (data.formatStreams as InvFormat[] | undefined) || [];
  const adaptive = (data.adaptiveFormats as InvFormat[] | undefined) || [];
  const formats: YtRawFormat[] = [];

  const push = (f: InvFormat, audioOnly: boolean, muxed: boolean) => {
    if (!f.url) return;
    const { ext, codecs } = parseMime(f.type);
    const vc = audioOnly ? "none" : (codecs[0] || (f.encoding ? codecArgs("video", f.encoding) : "avc1.640028"));
    const ac = audioOnly ? (codecs[0] || "mp4a.40.2") : muxed ? (codecs[1] || "mp4a.40.2") : "none";
    const bitrate = typeof f.bitrate === "string" ? parseInt(f.bitrate) : f.bitrate;
    const clen = typeof f.clen === "string" ? parseInt(f.clen) : f.clen;
    const height = f.qualityLabel ? parseInt(f.qualityLabel) : undefined;
    formats.push({
      format_id: f.itag || `inv-${Math.random().toString(36).slice(2, 8)}`,
      ext: f.container?.toLowerCase() || ext,
      url: f.url,
      vcodec: vc,
      acodec: ac,
      height: Number.isFinite(height) ? height : undefined,
      fps: f.fps || undefined,
      abr: audioOnly ? Math.round((bitrate || 0) / 1000) || undefined : undefined,
      tbr: bitrate ? Math.round(bitrate / 1000) : undefined,
      filesize: clen || undefined,
      protocol: "https",
    });
  };

  for (const f of fmtStreams) push(f, false, true);
  for (const f of adaptive) {
    const isAudio = /audio\//i.test(f.type || "");
    push(f, isAudio, false);
  }

  if (formats.length === 0) return null;
  const thumbs = (data.videoThumbnails as Array<{ url?: string }> | undefined) || [];
  return {
    id: String(data.videoId || ""),
    title: String(data.title || "Untitled"),
    uploader: String(data.author || ""),
    duration: Number(data.lengthSeconds || 0),
    view_count: Number(data.viewCount || 0),
    thumbnail: thumbs[0]?.url || "",
    webpage_url: `https://www.youtube.com/watch?v=${String(data.videoId || "")}`,
    is_live: !!data.liveNow,
    live_status: data.liveNow ? "is_live" : "not_live",
    extractor_key: "Youtube:Invidious",
    formats,
  };
}

/* ------------------------------------------------------------------ */
/* Public: fetch through the fallback chain                            */
/* ------------------------------------------------------------------ */

/**
 * Races ALL instances in parallel and returns the first healthy response.
 * Sequential walking wastes up to 12 s per dead instance; racing caps the
 * worst case at a single timeout no matter how many instances are down.
 * Per-instance results are remembered so known-good instances are retried
 * first next time (they're all re-probed cheaply here anyway).
 */
export async function fetchViaProxies(videoId: string): Promise<RawInfo> {
  const list = instances();
  const tasks = list.map(async (inst) => {
    const data = (await grab(
      inst.kind === "piped"
        ? `${inst.base}/streams/${videoId}`
        : `${inst.base}/api/v1/videos/${videoId}`,
    )) as Record<string, unknown> | null;
    if (!data) throw new Error(`${inst.name}: no response`);
    if ((data.error || data.message) && !data.formats && !data.videoStreams && !data.adaptiveFormats)
      throw new Error(`${inst.name}: ${(String(data.error || data.message) || "error").slice(0, 60)}`);
    const raw = inst.kind === "piped" ? pipedToRaw(data) : invToRaw(data);
    if (!raw || raw.formats.length === 0) throw new Error(`${inst.name}: no formats`);
    noteResult(inst.name, true);
    return raw;
  });

  try {
    return await Promise.any(tasks);
  } catch {
    for (const t of tasks) void t.catch(() => undefined);
    throw new Error("ALL_PROVIDERS_FAILED");
  }
}

/* ------------------------------------------------------------------ */
/* Health memory + fleet auto-refresh                                  */
/* ------------------------------------------------------------------ */

/** Extra instances discovered from the community fleet lists. */
declare global {
  var __tgDiscoveredInstances: Instance[] | undefined;
  var __tgProviderHealth: Map<string, { ok: number; bad: number; lastOk: number }> | undefined;
  var __tgProviderRefresh: number | undefined;
}

function healthMap(): Map<string, { ok: number; bad: number; lastOk: number }> {
  if (!globalThis.__tgProviderHealth) globalThis.__tgProviderHealth = new Map();
  return globalThis.__tgProviderHealth;
}

function noteResult(name: string, ok: boolean): void {
  const h = healthMap();
  const e = h.get(name) ?? { ok: 0, bad: 0, lastOk: 0 };
  if (ok) {
    e.ok++;
    e.lastOk = Date.now();
  } else e.bad++;
  h.set(name, e);
}

/** Extra instances discovered from the community fleet lists. */

async function refreshFleet(): Promise<void> {
  const found: Instance[] = [];

  // Invidious fleet: https://api.invidious.io/instances.json?sort_by=type,health
  try {
    const res = await fetch("https://api.invidious.io/instances.json?sort_by=type,health", {
      signal: AbortSignal.timeout(8000),
    });
    const arr = (await res.json()) as Array<[string, Record<string, unknown>]>;
    for (const [host, meta] of arr.slice(0, 40)) {
      const api = (meta as { api?: boolean; type?: string })?.api;
      const uri = (meta as { uri?: string })?.uri;
      if (api && uri && /^https:\/\//.test(uri)) {
        found.push({ name: host, kind: "invidious", base: uri.replace(/\/$/, "") });
      }
    }
  } catch {
    /* fleet list unreachable — builtins remain */
  }

  // Piped fleet: https://piped-instances.kavin.rocks/
  try {
    const res = await fetch("https://piped-instances.kavin.rocks/", {
      signal: AbortSignal.timeout(8000),
    });
    const arr = (await res.json()) as Array<{ api_url?: string; name?: string }>;
    for (const it of arr.slice(0, 40)) {
      if (it.api_url && /^https:\/\//.test(it.api_url)) {
        found.push({
          name: it.name || new URL(it.api_url).host,
          kind: "piped",
          base: it.api_url.replace(/\/$/, ""),
        });
      }
    }
  } catch {
    /* fleet list unreachable — builtins remain */
  }

  // dedupe against builtin + previous discoveries
  const seen = new Set(instances().map((i) => i.base));
  const fresh = found.filter((i) => !seen.has(i.base)).slice(0, 14);
  if (fresh.length) {
    globalThis.__tgDiscoveredInstances = [
      ...((globalThis.__tgDiscoveredInstances as Instance[] | undefined) ?? []),
      ...fresh,
    ].slice(-14);
    console.log(`[providers] discovered ${fresh.length} new community instances`);
  }
}

if (globalThis.__tgProviderRefresh === undefined) {
  globalThis.__tgProviderRefresh = 1;
  setTimeout(() => void refreshFleet(), 2000);
  setInterval(() => void refreshFleet(), 10 * 60 * 1000);
}
