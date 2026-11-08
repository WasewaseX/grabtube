import type { PublicFormat, PublicInfo } from "@/lib/ytdlp";

/** Timed pause used by every polling loop (job poll, resolver warm-up). */
export function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Audio conversions: mp3/flac/wav always re-encode; m4a/opus only when no
 * native stream of that container exists (fmt.id === "convert").
 */
export function isAudioConversion(fmt: PublicFormat): boolean {
  return (
    fmt.kind === "audio" &&
    (fmt.id === "convert" || ["mp3", "flac", "wav"].includes(fmt.container))
  );
}

/**
 * Build the /api/dl resolve link for a selection (pre-store fallback).
 * When a download manager (or browser) hits it, the SERVER downloads the
 * file fully first (answering 503 + Retry-After meanwhile), then serves the
 * finished file with Range/resume — the client never touches YouTube.
 */
export function buildDlLink(fmt: PublicFormat, info: PublicInfo, bitrate?: number): string {
  const isConversion = isAudioConversion(fmt);
  const f = isConversion ? fmt.container : fmt.id;
  const qs = new URLSearchParams({
    u: info.webpageUrl,
    f,
    q: fmt.quality || "",
    t: info.title || "",
  });
  if (isConversion && fmt.container === "mp3") qs.set("b", String(bitrate ?? 320));
  return `/api/dl?${qs.toString()}`;
}
