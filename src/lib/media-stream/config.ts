/** Shared constants and option/result contracts for the media stream engine. */

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
