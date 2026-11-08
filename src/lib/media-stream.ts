/** Ranged media proxy-streaming engine shared by /api/download and /api/dl:
 *  bounded ranged chunks through the SAME lane that minted the URL, one
 *  window in flight at a time (true backpressure), mid-stream re-mint. */

export { DEFAULT_CHUNK, UA } from "./media-stream/config";
export type { MediaStreamOptions, MediaStreamResult } from "./media-stream/config";
export { openMediaStream } from "./media-stream/open";
