/**
 * Ranged media proxy-streaming engine shared by /api/download and /api/dl.
 *
 * Why it exists:
 *  - googlevideo throttles full-file GETs to a trickle and binds minted URLs
 *    to the egress IP, so upstream is fetched in bounded ranged chunks through
 *    the SAME lane that minted the URL.
 *  - TRUE BACKPRESSURE: the ReadableStream pulls exactly ONE window at a time
 *    (never buffers the whole file server-side). Slow clients (e.g. Iran
 *    mobile networks) therefore cannot blow up memory or get the connection
 *    reset mid-transfer — the previous eager-buffer implementation was the
 *    root cause of "download failed midway" on big files.
 *  - Byte-exact: short reads are re-rolled (never silently truncating), and a
 *    mid-stream URL re-mint keeps long transfers alive when googlevideo
 *    invalidates the minted URL.
 */

import { proxiedFetch } from "./proxy";

export const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export const DEFAULT_CHUNK = 4 * 1024 * 1024; // 4 MiB ranged fetches dodge the throttle

export interface MediaStreamOptions {
  /** Ordered candidate URLs — the first one that answers a ranged probe wins. */
  candidates: string[];
  /** Fresh URL minting (used on probe failure + mid-stream recovery). */
  reMint?: () => Promise<string | null>;
  /** Requested byte window (client Range). */
  start: number;
  end: number;
  /** Parallel upstream fetches inside the window (2 when client asked for a
   *  sub-range — download managers already parallelize across connections). */
  concurrency?: number;
  chunkSize?: number;
  /** Aborted when the client disconnects (ReadableStream.cancel). */
  signal?: AbortSignal;
  tag?: string; // log tag
}

export interface MediaStreamResult {
  stream: ReadableStream<Uint8Array>;
  totalSize: number; // -1 when unknown
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function combinedTimeout(ms: number, external?: AbortSignal): AbortSignal {
  const t = AbortSignal.timeout(ms);
  if (!external) return t;
  try {
    return AbortSignal.any([t, external]);
  } catch {
    return t;
  }
}

export async function openMediaStream(opts: MediaStreamOptions): Promise<MediaStreamResult | null> {
  const {
    candidates,
    reMint,
    start,
    end,
    concurrency = 4,
    chunkSize = DEFAULT_CHUNK,
    signal,
    tag = "media",
  } = opts;

  /* ---------- one ranged upstream fetch with retries ---------- */
  const fetchRange = async (
    url: string,
    from: number,
    to: number,
    tries = 4,
  ): Promise<Response | null> => {
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
  };

  /* ---------- probe candidates, learn total size ---------- */
  let mediaUrl = "";
  let totalSize = -1;
  const t0 = Date.now();
  for (const url of candidates) {
    if (!url) continue;
    const probe = await fetchRange(url, start, Math.min(start + chunkSize - 1, end < 0 ? start + chunkSize - 1 : end), 4);
    if (probe) {
      mediaUrl = url;
      const cr = probe.headers.get("content-range"); // "bytes 0-8388607/12345678"
      const m = cr?.match(/\/(\d+)$/);
      totalSize = m ? parseInt(m[1], 10) : Number(probe.headers.get("content-length")) || -1;
      await probe.body?.cancel().catch(() => undefined);
      console.log(`[${tag}] probe ok in ${Date.now() - t0}ms, total=${totalSize}`);
      break;
    }
  }
  if (!mediaUrl) return null;

  // Open-ended window (end < 0): clamp to the real size learned from the probe.
  const winEnd = end < 0 && totalSize > 0 ? totalSize - 1 : end;
  if (winEnd < start) return null; // empty / out-of-bounds range

  /* ---------- drain one ranged fetch byte-exactly ---------- */
  const readChunk = async (from: number, to: number): Promise<Uint8Array> => {
    const expected = to - from + 1;
    for (let attempt = 0; attempt < 5; attempt++) {
      const res = await fetchRange(mediaUrl, from, to, 2);
      if (!res || !res.body) continue;
      const reader = res.body.getReader();
      const parts: Uint8Array[] = [];
      let got = 0;
      const ts = Date.now();
      let retry = false;
      for (;;) {
        const r = await Promise.race([
          reader.read(),
          new Promise<"stall">((r2) => setTimeout(() => r2("stall"), 8000)),
        ]);
        if (r === "stall") {
          console.log(`[${tag}] stalled lane dropped at ${from} (got ${got}/${expected})`);
          retry = true;
          break;
        }
        const { done, value } = r;
        if (done) break;
        parts.push(value);
        got += value.length;
        const dt = Date.now() - ts;
        if (dt > 10_000 && got < 1_000_000) {
          console.log(`[${tag}] throttled lane re-rolled at ${from} (${got}B in ${dt}ms)`);
          retry = true;
          break;
        }
      }
      if (retry) {
        await reader.cancel().catch(() => undefined);
        await sleep(300 + attempt * 200);
        continue;
      }
      if (got !== expected) {
        console.log(`[${tag}] short read at ${from}: ${got}/${expected} — re-rolling`);
        await reader.cancel().catch(() => undefined);
        await sleep(300 + attempt * 200);
        continue;
      }
      const out = new Uint8Array(got);
      let off = 0;
      for (const p of parts) {
        out.set(p, off);
        off += p.length;
      }
      return out;
    }
    throw new Error(`upstream failed at ${from}`);
  };

  /* ---------- windowed generator (bounded memory, pull-driven) ---------- */
  async function* upstreamChunks(): AsyncGenerator<Uint8Array> {
    const windowStart = start;
    const totalBytes = winEnd - start + 1;
    const total = Math.ceil(totalBytes / chunkSize);
    const results = new Map<number, Uint8Array | null>();
    const inFlight = new Set<Promise<void>>();
    let launched = 0;
    let consumed = 0;
    let reMints = 0;

    const launchNext = (idx: number) => {
      launched = Math.max(launched, idx + 1);
      const s = windowStart + idx * chunkSize;
      const e = Math.min(s + chunkSize - 1, winEnd);
      const p = readChunk(s, e)
        .then((buf) => {
          results.set(idx, buf);
        })
        .catch((err) => {
          results.set(idx, null); // never leave a rejected promise in the race set
          console.log(`[${tag}] chunk ${idx} failed: ${String(err).slice(0, 80)}`);
        })
        .finally(() => {
          inFlight.delete(p);
        });
      inFlight.add(p);
    };

    const reMintUrl = async (): Promise<boolean> => {
      if (reMints >= 2 || !reMint) return false;
      reMints++;
      console.log(`[${tag}] re-minting media URL mid-stream (#${reMints})`);
      const u = await reMint();
      if (u) {
        mediaUrl = u;
        return true;
      }
      return false;
    };

    try {
      while (consumed < total) {
        while (inFlight.size < concurrency && launched < total) launchNext(launched);
        if (inFlight.size === 0 && results.size === 0) break;
        if (inFlight.size > 0) await Promise.race(inFlight);
        while (results.has(consumed)) {
          const buf = results.get(consumed)!;
          results.delete(consumed);
          if (buf) {
            consumed++;
            yield buf;
          } else {
            // failed chunk: re-mint URL if needed, retry the chunk twice
            let ok = false;
            for (let retry = 0; retry < 2 && !ok; retry++) {
              const s = windowStart + consumed * chunkSize;
              const e2 = Math.min(s + chunkSize - 1, winEnd);
              try {
                const fixed = await readChunk(s, e2);
                results.set(consumed, fixed);
                ok = true;
              } catch {
                ok = false;
                if (retry === 0) await reMintUrl();
              }
            }
            if (!ok) throw new Error(`chunk ${consumed} unrecoverable`);
          }
        }
      }
    } finally {
      for (const p of inFlight) void p.catch(() => undefined);
    }
    if (consumed < total) throw new Error(`upstream ended early at chunk ${consumed}/${total}`);
  }

  /* ---------- BACKPRESSURED ReadableStream ----------
   * pull() advances the generator ONE chunk per call — the consumer (client
   * socket) governs the pace; nothing is buffered ahead of the network.     */
  const iterator = upstreamChunks();
  let done = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (done) {
        controller.close();
        return;
      }
      try {
        const { value, done: finished } = await iterator.next();
        if (finished) {
          done = true;
          controller.close();
        } else {
          controller.enqueue(value!);
        }
      } catch (e) {
        done = true;
        controller.error(e);
      }
    },
    async cancel() {
      done = true;
      try {
        await iterator.return?.(undefined);
      } catch {
        /* noop */
      }
    },
  });

  return { stream, totalSize };
}
