/** Byte-exact drain of one ranged upstream fetch — short reads are re-rolled, never truncated. */

import { fetchRange, sleep, type LaneState } from "./lane";

export async function readChunk(st: LaneState, from: number, to: number): Promise<Uint8Array> {
  const { tag } = st;
  const expected = to - from + 1;
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetchRange(st, st.mediaUrl, from, to, 2);
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
    if (retry || got !== expected) {
      if (!retry) console.log(`[${tag}] short read at ${from}: ${got}/${expected} — re-rolling`);
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
}
