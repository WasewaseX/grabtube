import type { SpeedSample } from "./types";

/** Initial zero-speed sample registered when a download row is created. */
export function freshSample(): SpeedSample {
  return { lastT: performance.now(), lastB: 0, ema: 0, lastRender: 0 };
}

/**
 * Exponential moving average of bytes/sec, re-sampled at most every 400 ms
 * so the UI rate stays readable on jittery connections.
 */
export function sampleDownloadSpeed(
  store: Map<string, SpeedSample>,
  id: string,
  received: number,
): number {
  const now = performance.now();
  const s = store.get(id) ?? { lastT: now, lastB: received, ema: 0, lastRender: 0 };
  const dt = (now - s.lastT) / 1000;
  if (dt >= 0.4) {
    const inst = (received - s.lastB) / dt;
    s.ema = s.ema === 0 ? inst : s.ema * 0.7 + inst * 0.3;
    s.lastT = now;
    s.lastB = received;
  }
  store.set(id, s);
  return s.ema;
}
