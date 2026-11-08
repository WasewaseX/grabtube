import { spawn } from "node:child_process";

import { LANE_FAIL_STREAK, pickActive, state, type Lane } from "./lanes";

export const TRACE_URL = "https://www.cloudflare.com/cdn-cgi/trace";
/** Probe candidates: a tunnel answering ANY of these is alive. Fallbacks
 *  exist because the cloudflare trace stalls THROUGH WARP (hairpin quirk);
 *  without them the manager flapped warp→direct, and direct gets bot-walled. */
const PROBE_URLS = [
  "https://www.cloudflare.com/cdn-cgi/trace",
  "https://one.one.one.one/cdn-cgi/trace",
  "https://api.ipify.org/?format=text",
];

function curlThroughProxy(proxy: string, url = TRACE_URL): Promise<{ ok: boolean; body: string; ms: number }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    try {
      const proc = spawn("curl", ["-s", "-m", "9", "--proxy", proxy, url], {
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
    // try each probe URL until one answers — ANY success keeps the lane alive
    for (const url of PROBE_URLS) {
      try {
        if (lane.ytdlpProxy) {
          // curl speaks HTTP CONNECT and SOCKS natively and is immune to
          // runtime bundling quirks — the source of truth for lane health
          const r = await curlThroughProxy(lane.ytdlpProxy, url);
          if (r.ok) {
            body = r.body;
            break;
          }
        } else {
          const res = await fetch(url, {
            headers: { "User-Agent": "TubeGrab/2.1 health" },
            signal: AbortSignal.timeout(10_000),
          });
          const text = await res.text();
          if (res.ok && /ip=|\d+\.\d+\.\d+\.\d+/.test(text)) {
            body = text;
            break;
          }
        }
      } catch {
        /* try the next probe URL */
      }
    }
    const ip = body.match(/ip=([^\s]+)/)?.[1] ?? body.match(/(\d+\.\d+\.\d+\.\d+)/)?.[1] ?? null;
    lane.lastCheck = Date.now();
    lane.latencyMs = Date.now() - t0;
    if (ip) {
      lane.egressIp = ip;
      lane.healthy = true;
      lane.failStreak = 0;
      lane.note = undefined;
    } else {
      lane.failStreak++;
      // tolerate transient blips: only go unhealthy after N straight misses
      lane.healthy = lane.failStreak < LANE_FAIL_STREAK && lane.healthy;
      lane.note = `probe returned no IP (${lane.failStreak}/${LANE_FAIL_STREAK})`;
    }
  } catch (e) {
    lane.lastCheck = Date.now();
    lane.latencyMs = Date.now() - t0;
    lane.failStreak++;
    lane.healthy = lane.failStreak < LANE_FAIL_STREAK && lane.healthy;
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
