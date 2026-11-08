/** One ranged upstream fetch lane with retries; owns the re-mintable URL state. */

import { proxiedFetch } from "../proxy";
import { UA } from "./config";

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function combinedTimeout(ms: number, external?: AbortSignal): AbortSignal {
  const t = AbortSignal.timeout(ms);
  if (!external) return t;
  try {
    return AbortSignal.any([t, external]);
  } catch {
    return t;
  }
}

/** Mutable per-stream upstream state (the active media URL, log tag, signal). */
export interface LaneState {
  tag: string;
  signal?: AbortSignal;
  mediaUrl: string;
}

export async function fetchRange(
  st: LaneState,
  url: string,
  from: number,
  to: number,
  tries = 4,
): Promise<Response | null> {
  const { tag, signal } = st;
  for (let i = 0; i < tries; i++) {
    try {
      // Routed through the SAME egress lane that minted the URL
      // (googlevideo URLs are IP-locked).
      const res = await proxiedFetch(url, {
        headers: { "User-Agent": UA, Range: `bytes=${from}-${to}` },
        signal: combinedTimeout(12_000, signal),
      });
      if (res.ok || res.status === 206) return res;
      console.log(
        `[${tag}] upstream ${res.status} (try ${i + 1}/${tries}) ${new URL(url).host} bytes=${from}-${to}`,
      );
      try {
        await res.body?.cancel();
      } catch {
        /* noop */
      }
    } catch (e) {
      if (signal?.aborted) return null;
      console.log(`[${tag}] upstream threw (try ${i + 1}/${tries}): ${String(e).slice(0, 120)}`);
    }
    // Rotating-egress hosts: every new TCP connection re-rolls the source IP,
    // so a fresh attempt can satisfy an IP-locked URL.
    await sleep(700);
  }
  return null;
}
