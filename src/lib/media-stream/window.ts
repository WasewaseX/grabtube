/** Windowed chunk pipeline: bounded in-flight fetches, pull-driven, mid-stream re-mint. */

import type { LaneState } from "./lane";
import { readChunk } from "./tunnel";

export interface WindowOptions {
  start: number;
  winEnd: number;
  chunkSize: number;
  concurrency: number;
  /** Fresh URL minting used on mid-stream recovery. */
  reMint?: () => Promise<string | null>;
}

/** Re-rolls a failed chunk twice, re-minting the media URL after the first miss. */
async function recoverFailedChunk(
  st: LaneState,
  o: WindowOptions,
  reMintUrl: () => Promise<boolean>,
  idx: number,
): Promise<Uint8Array | null> {
  for (let retry = 0; retry < 2; retry++) {
    const s = o.start + idx * o.chunkSize;
    const e = Math.min(s + o.chunkSize - 1, o.winEnd);
    try {
      return await readChunk(st, s, e);
    } catch {
      if (retry === 0) await reMintUrl();
    }
  }
  return null;
}

export async function* upstreamChunks(
  st: LaneState,
  o: WindowOptions,
): AsyncGenerator<Uint8Array> {
  const windowStart = o.start;
  const totalBytes = o.winEnd - o.start + 1;
  const total = Math.ceil(totalBytes / o.chunkSize);
  const results = new Map<number, Uint8Array | null>();
  const inFlight = new Set<Promise<void>>();
  let launched = 0;
  let consumed = 0;
  let reMints = 0;

  const launchNext = (idx: number) => {
    launched = Math.max(launched, idx + 1);
    const s = windowStart + idx * o.chunkSize;
    const e = Math.min(s + o.chunkSize - 1, o.winEnd);
    const p = readChunk(st, s, e)
      .then((buf) => {
        results.set(idx, buf);
      })
      .catch((err) => {
        results.set(idx, null); // never leave a rejected promise in the race set
        console.log(`[${st.tag}] chunk ${idx} failed: ${String(err).slice(0, 80)}`);
      })
      .finally(() => {
        inFlight.delete(p);
      });
    inFlight.add(p);
  };

  const reMintUrl = async (): Promise<boolean> => {
    if (reMints >= 2 || !o.reMint) return false;
    reMints++;
    console.log(`[${st.tag}] re-minting media URL mid-stream (#${reMints})`);
    const u = await o.reMint();
    if (u) {
      st.mediaUrl = u;
      return true;
    }
    return false;
  };

  try {
    while (consumed < total) {
      while (inFlight.size < o.concurrency && launched < total) launchNext(launched);
      if (inFlight.size === 0 && results.size === 0) break;
      if (inFlight.size > 0) await Promise.race(inFlight);
      while (results.has(consumed)) {
        const buf = results.get(consumed)!;
        results.delete(consumed);
        if (buf) {
          consumed++;
          yield buf;
        } else {
          const fixed = await recoverFailedChunk(st, o, reMintUrl, consumed);
          if (!fixed) throw new Error(`chunk ${consumed} unrecoverable`);
          results.set(consumed, fixed);
        }
      }
    }
  } finally {
    for (const p of inFlight) void p.catch(() => undefined);
  }
  if (consumed < total) throw new Error(`upstream ended early at chunk ${consumed}/${total}`);
}
