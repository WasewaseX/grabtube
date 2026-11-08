/** Public orchestration: probe → windowed generator → backpressured ReadableStream. */

import { DEFAULT_CHUNK, type MediaStreamOptions, type MediaStreamResult } from "./config";
import type { LaneState } from "./lane";
import { probeCandidates } from "./probe";
import { upstreamChunks } from "./window";

/** BACKPRESSURED ReadableStream: pull() advances the generator ONE chunk per
 *  call — the consumer (client socket) governs the pace; nothing is buffered
 *  ahead of the network. */
function backpressuredStream(iterator: AsyncGenerator<Uint8Array>): ReadableStream<Uint8Array> {
  let done = false;
  return new ReadableStream<Uint8Array>({
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

  const st: LaneState = { tag, signal, mediaUrl: "" };
  const probed = await probeCandidates(st, candidates, start, end, chunkSize);
  if (!probed) return null;
  st.mediaUrl = probed.mediaUrl;

  // Open-ended window (end < 0): clamp to the real size learned from the probe.
  const winEnd = end < 0 && probed.totalSize > 0 ? probed.totalSize - 1 : end;
  if (winEnd < start) return null; // empty / out-of-bounds range

  const iterator = upstreamChunks(st, { start, winEnd, chunkSize, concurrency, reMint });
  return { stream: backpressuredStream(iterator), totalSize: probed.totalSize };
}
