/** Candidate probing: pick the first URL that answers a ranged fetch, learn total size. */

import { fetchRange, type LaneState } from "./lane";

export interface ProbeResult {
  mediaUrl: string;
  totalSize: number; // -1 when unknown
}

export async function probeCandidates(
  st: LaneState,
  candidates: string[],
  start: number,
  end: number,
  chunkSize: number,
): Promise<ProbeResult | null> {
  let mediaUrl = "";
  let totalSize = -1;
  const t0 = Date.now();
  for (const url of candidates) {
    if (!url) continue;
    const probe = await fetchRange(
      st,
      url,
      start,
      Math.min(start + chunkSize - 1, end < 0 ? start + chunkSize - 1 : end),
      4,
    );
    if (probe) {
      mediaUrl = url;
      const cr = probe.headers.get("content-range"); // "bytes 0-8388607/12345678"
      const m = cr?.match(/\/(\d+)$/);
      totalSize = m ? parseInt(m[1], 10) : Number(probe.headers.get("content-length")) || -1;
      await probe.body?.cancel().catch(() => undefined);
      console.log(`[${st.tag}] probe ok in ${Date.now() - t0}ms, total=${totalSize}`);
      break;
    }
  }
  if (!mediaUrl) return null;
  return { mediaUrl, totalSize };
}
