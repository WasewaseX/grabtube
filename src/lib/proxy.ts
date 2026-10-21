/**
 * Egress lane manager.
 *
 * YouTube mints googlevideo URLs that are IP-locked to the requesting
 * address, so extraction and media fetching MUST share one egress. This
 * module owns that decision:
 *
 *   lane 0  WARP tunnel   – socks5h://127.0.0.1:41080 (yt-dlp)
 *                           http://127.0.0.1:41081  (Node fetch / ffmpeg)
 *                           consumer-grade Cloudflare egress; defeats the
 *                           datacenter-IP bot wall.
 *   lane 1+ user proxies  – configured at runtime in Settings (http/socks).
 *   last   direct         – no proxy; still useful for cached videos and
 *                           as a safety net.
 *
 * Every lane is health-probed (cheap /cdn-cgi/trace request) every 60 s.
 * The active lane is sticky: we stay on it while it passes probes and only
 * switch when it fails — switching mid-session invalidates minted URLs.
 * A lane that recovers automatically becomes eligible again.
 */
import { ProxyAgent, fetch as undiciFetch, type Dispatcher, type RequestInit as UndiciRequestInit } from "undici";
import { spawn } from "child_process";
import { existsSync, mkdirSync, readFileSync } from "fs";

export const DATA_DIR = "/home/z/my-project/data";
export const SETTINGS_PATH = `${DATA_DIR}/settings.json`;
export const COOKIES_PATH = `${DATA_DIR}/cookies.txt`;

const WARP_SOCKS = "socks5h://127.0.0.1:41080";
const WARP_HTTP = "http://127.0.0.1:41081";
const TRACE_URL = "https://www.cloudflare.com/cdn-cgi/trace";

/* ------------------------------------------------------------------ */
/* Settings persistence (written by /api/settings)                      */
/* ------------------------------------------------------------------ */

export interface Settings {
  extraProxies?: string[];
  cookies?: string | null; // Netscape cookies.txt content
  updatedAt?: number;
}

export function loadSettings(): Settings {
  try {
    if (!existsSync(SETTINGS_PATH)) return {};
    return JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as Settings;
  } catch {
    return {};
  }
}

/* ------------------------------------------------------------------ */
/* Lanes                                                               */
/* ------------------------------------------------------------------ */

interface Lane {
  id: string;
  label: string;
  kind: "warp" | "user" | "direct";
  /** what to pass to yt-dlp --proxy (null = direct) */
  ytdlpProxy: string | null;
  /** HTTP CONNECT proxy for undici ProxyAgent / ffmpeg (null = none) */
  httpProxy: string | null;
  agent: Dispatcher | null;
  healthy: boolean;
  latencyMs: number | null;
  egressIp: string | null;
  lastCheck: number | null;
  failStreak: number;
  note?: string;
}

function parseUserProxy(raw: string): Lane | null {
  const p = raw.trim();
  if (!p || !/^https?:\/\//.test(p) && !/^socks(4|4a|5|h)?:\/\//.test(p)) return null;
  const isHttp = /^https?:\/\//.test(p);
  let agent: Dispatcher | null = null;
  if (isHttp) {
    try {
      agent = new ProxyAgent({ uri: p, connect: { timeout: 12_000 } });
    } catch {
      agent = null;
    }
  }
  return {
    id: `user:${p}`,
    label: p.replace(/^\w+:\/\//, "").slice(0, 42),
    kind: "user",
    ytdlpProxy: p,
    httpProxy: isHttp ? p : null,
    agent,
    healthy: true, // user-provided lanes start optimistic
    latencyMs: null,
    egressIp: null,
    lastCheck: null,
    failStreak: 0,
    note: isHttp ? undefined : "socks: yt-dlp only",
  };
}

function buildLanes(settings: Settings): Lane[] {
  const lanes: Lane[] = [
    {
      id: "warp",
      label: "Cloudflare WARP tunnel",
      kind: "warp",
      ytdlpProxy: WARP_SOCKS,
      httpProxy: WARP_HTTP,
      agent: new ProxyAgent({ uri: WARP_HTTP, connect: { timeout: 12_000 } }),
      healthy: true,
      latencyMs: null,
      egressIp: null,
      lastCheck: null,
      failStreak: 0,
    },
  ];
  for (const p of settings.extraProxies ?? []) {
    const lane = parseUserProxy(p);
    if (lane) lanes.push(lane);
  }
  lanes.push({
    id: "direct",
    label: "Direct (server IP)",
    kind: "direct",
    ytdlpProxy: null,
    httpProxy: null,
    agent: null,
    healthy: true,
    latencyMs: null,
    egressIp: null,
    lastCheck: null,
    failStreak: 0,
  });
  return lanes;
}

/* ------------------------------------------------------------------ */
/* Global state (HMR-safe)                                             */
/* ------------------------------------------------------------------ */

interface ProxyState {
  lanes: Lane[];
  activeId: string;
  probing: boolean;
  lastProbeAt: number;
}

declare global {
  var __tgProxyState: ProxyState | undefined;
}

function state(): ProxyState {
  if (!globalThis.__tgProxyState) {
    globalThis.__tgProxyState = {
      lanes: buildLanes(loadSettings()),
      activeId: "warp",
      probing: false,
      lastProbeAt: 0,
    };
  }
  return globalThis.__tgProxyState;
}

/** Rebuild lanes after Settings change (keeps probe freshness where possible). */
export function reloadLanes(): void {
  const s = state();
  const old = new Map(s.lanes.map((l) => [l.id, l]));
  s.lanes = buildLanes(loadSettings()).map((l) => {
    const prev = old.get(l.id);
    return prev ? { ...l, healthy: prev.healthy, latencyMs: prev.latencyMs, egressIp: prev.egressIp, lastCheck: prev.lastCheck } : l;
  });
  if (!s.lanes.some((l) => l.id === s.activeId)) s.activeId = s.lanes[0]?.id ?? "direct";
}

/* ------------------------------------------------------------------ */
/* Probing                                                             */
/* ------------------------------------------------------------------ */

function curlThroughProxy(proxy: string): Promise<{ ok: boolean; body: string; ms: number }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    try {
      const proc = spawn("curl", ["-s", "-m", "9", "--proxy", proxy, TRACE_URL], {
        stdio: ["ignore", "pipe", "ignore"],
      });
      let out = "";
      const timer = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* noop */
        }
      }, 10_000);
      proc.stdout?.on("data", (c: Buffer) => (out += c.toString()));
      proc.on("close", () => {
        clearTimeout(timer);
        resolve({ ok: out.includes("ip="), body: out, ms: Date.now() - t0 });
      });
      proc.on("error", () => {
        clearTimeout(timer);
        resolve({ ok: false, body: "", ms: Date.now() - t0 });
      });
    } catch {
      resolve({ ok: false, body: "", ms: Date.now() - t0 });
    }
  });
}

async function probeLane(lane: Lane): Promise<void> {
  const t0 = Date.now();
  try {
    let body = "";
    if (lane.ytdlpProxy) {
      // curl speaks HTTP CONNECT and SOCKS natively and is immune to runtime
      // bundling quirks — the single source of truth for lane health
      const r = await curlThroughProxy(lane.ytdlpProxy);
      body = r.body;
    } else {
      const res = await fetch(TRACE_URL, {
        headers: { "User-Agent": "TubeGrab/2.1 health" },
        signal: AbortSignal.timeout(10_000),
      });
      body = await res.text();
    }
    const ip = body.match(/ip=([^\s]+)/)?.[1] ?? null;
    const ok = body.includes("ip=");
    lane.lastCheck = Date.now();
    lane.latencyMs = Date.now() - t0;
    lane.egressIp = ip;
    if (ok) {
      lane.healthy = true;
      lane.failStreak = 0;
      lane.note = undefined;
    } else {
      lane.failStreak++;
      lane.healthy = false;
      lane.note = "probe returned no IP";
    }
  } catch (e) {
    lane.lastCheck = Date.now();
    lane.latencyMs = Date.now() - t0;
    lane.healthy = false;
    lane.failStreak++;
    const err = e as Error & { cause?: unknown };
    const cause = err?.cause ? String(err.cause).slice(0, 90) : "";
    lane.note = `${String(e).slice(0, 60)}${cause ? ` ← ${cause}` : ""}`;
  }
}

export async function probeAll(): Promise<void> {
  const s = state();
  if (s.probing) return;
  s.probing = true;
  try {
    await Promise.all(s.lanes.map(probeLane));
    s.lastProbeAt = Date.now();
    pickActive();
  } finally {
    s.probing = false;
  }
}

/** Priority-based selection: WARP (consumer egress) always wins when its
 *  latest probe passed; user proxies next; direct is the last resort.
 *  The 403 re-mint path absorbs the URL invalidation a lane switch causes. */
function pickActive(): void {
  const s = state();
  const best = s.lanes.find((l) => l.healthy) ?? s.lanes[s.lanes.length - 1];
  if (best && s.activeId !== best.id) {
    console.log(`[proxy] active lane → ${best.id}`);
    s.activeId = best.id;
  }
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

export function activeLane(): Lane {
  const s = state();
  return s.lanes.find((l) => l.id === s.activeId) ?? s.lanes[s.lanes.length - 1];
}

/** undici dispatcher for server-side media fetches (null = direct fetch). */
export function mediaDispatcher(): Dispatcher | null {
  return activeLane().agent;
}

/**
 * Server-side fetch routed through the ACTIVE egress lane. MUST be used for
 * every googlevideo request: minted URLs are IP-locked to the lane.
 * Falls back to global fetch when the active lane is direct.
 */
export async function proxiedFetch(
  url: string,
  init: { headers?: Record<string, string>; signal?: AbortSignal } = {},
): Promise<Response> {
  const dispatcher = activeLane().agent;
  if (!dispatcher) return fetch(url, init as RequestInit);
  return undiciFetch(url, {
    ...init,
    dispatcher,
  } as UndiciRequestInit) as unknown as Response;
}

/** Value for yt-dlp --proxy (null = direct). */
export function ytDlpProxy(): string | null {
  return activeLane().ytdlpProxy;
}

/** Environment for ffmpeg spawns so -i https://… tunnels through the lane. */
export function ffmpegProxyEnv(): Record<string, string> {
  const http = activeLane().httpProxy;
  if (!http) return {};
  return {
    http_proxy: http,
    https_proxy: http,
    HTTP_PROXY: http,
    HTTPS_PROXY: http,
    no_proxy: "127.0.0.1,localhost",
  };
}

export interface LaneStatus {
  id: string;
  label: string;
  kind: Lane["kind"];
  active: boolean;
  healthy: boolean;
  latencyMs: number | null;
  egressIp: string | null;
  lastCheck: number | null;
  note?: string;
}

export function laneSnapshot(): LaneStatus[] {
  const s = state();
  return s.lanes.map((l) => ({
    id: l.id,
    label: l.label,
    kind: l.kind,
    active: l.id === s.activeId,
    healthy: l.healthy,
    latencyMs: l.latencyMs,
    egressIp: l.egressIp,
    lastCheck: l.lastCheck,
    note: l.note,
  }));
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

if (!globalThis.__tgProxyBooted) {
  globalThis.__tgProxyBooted = true;
  setTimeout(() => void probeAll(), 500);
  setInterval(() => void probeAll(), 60_000);
  // keep-alive the agents so sockets through the tunnel stay warm
  setInterval(() => {
    try {
      const dispatcher = activeLane().agent;
      const req = dispatcher
        ? undiciFetch(TRACE_URL, { dispatcher, signal: AbortSignal.timeout(8000) } as UndiciRequestInit)
        : fetch(TRACE_URL, { signal: AbortSignal.timeout(8000) });
      void req.then((r) => r.body?.cancel()).catch(() => undefined);
    } catch {
      /* noop */
    }
  }, 25_000);
}

declare global {
  var __tgProxyBooted: boolean | undefined;
}
