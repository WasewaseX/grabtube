import { ProxyAgent, fetch as undiciFetch, type Dispatcher, type RequestInit as UndiciRequestInit } from "undici";

import { loadSettings, type Settings } from "./settings";

const WARP_SOCKS = "socks5h://127.0.0.1:41080";
const WARP_HTTP = "http://127.0.0.1:41081";
/** consecutive failed probe ROUNDS before a lane is declared unhealthy —
 *  one missed round on a lossy tunnel must NOT flip the active lane */
export const LANE_FAIL_STREAK = 3;

export interface Lane {
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

export function buildLanes(settings: Settings): Lane[] {
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

/* Global state (HMR-safe)                                             */

interface ProxyState {
  lanes: Lane[];
  activeId: string;
  probing: boolean;
  lastProbeAt: number;
}

declare global {
  var __tgProxyState: ProxyState | undefined;
}

export function state(): ProxyState {
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

/** Priority-based selection: WARP wins when its latest probe passed, user
 *  proxies next, direct last. The 403 re-mint path absorbs lane-switch URL
 *  invalidation. */
export function pickActive(): void {
  const s = state();
  const best = s.lanes.find((l) => l.healthy) ?? s.lanes[s.lanes.length - 1];
  if (best && s.activeId !== best.id) {
    console.log(`[proxy] active lane → ${best.id}`);
    s.activeId = best.id;
  }
}

/* Public API                                                          */

export function activeLane(): Lane {
  const s = state();
  return s.lanes.find((l) => l.id === s.activeId) ?? s.lanes[s.lanes.length - 1];
}

/** undici dispatcher for server-side media fetches (null = direct fetch). */
export function mediaDispatcher(): Dispatcher | null {
  return activeLane().agent;
}

/**
 * Server-side fetch routed through the ACTIVE egress lane — MUST be used for
 * googlevideo requests (URLs are IP-locked); falls back to global fetch.
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
