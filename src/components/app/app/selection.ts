import type { PublicFormat } from "../../../lib/ytdlp";
import { fmtCodec, fmtHeight } from "./format-utils";

export function codecAvailability(vids: PublicFormat[]): Set<string> {
  const set = new Set<string>();
  for (const f of vids) {
    const c = fmtCodec(f);
    if (c) set.add(c);
  }
  return set;
}

export function pickVideoFormat(
  vids: PublicFormat[],
  atHeight: PublicFormat[],
  selHeight: number,
  wantCodec: string,
): PublicFormat | null {
  const exact = atHeight.find((f) => fmtCodec(f) === wantCodec);
  if (exact) return exact;
  const anyAt = atHeight[0];
  if (anyAt) return anyAt;
  const lower = vids
    .filter((f) => fmtHeight(f) < selHeight && fmtCodec(f) === wantCodec)
    .sort((a, b) => fmtHeight(b) - fmtHeight(a));
  return lower[0] ?? vids.sort((a, b) => fmtHeight(b) - fmtHeight(a))[0] ?? null;
}

const CONVERT_FALLBACK: Pick<PublicFormat, "id" | "kind" | "quality" | "instant" | "needsMerge"> = {
  id: "convert",
  kind: "audio",
  quality: "Audio",
  instant: false,
  needsMerge: false,
};

export function pickAudioFormat(auds: PublicFormat[], name: string): PublicFormat | null {
  if (name === "M4A") {
    const native = auds.find((a) => a.container === "m4a");
    return native ?? { ...CONVERT_FALLBACK, container: "m4a" };
  }
  if (name === "Opus") {
    const native = auds.find((a) => a.container === "webm" || a.container === "opus");
    return native ?? { ...CONVERT_FALLBACK, container: "opus" };
  }
  if (name === "MP3") return { ...CONVERT_FALLBACK, container: "mp3" };
  if (name === "FLAC") return { ...CONVERT_FALLBACK, container: "flac" };
  if (name === "WAV") return { ...CONVERT_FALLBACK, container: "wav" };
  return null;
}

export function containersLabel(vids: PublicFormat[]): string {
  const set = new Set<string>();
  for (const f of vids) set.add(f.container);
  if (set.size === 0) set.add("mp4");
  return [...set].join(" · ");
}
