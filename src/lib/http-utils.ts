/**
 * Shared HTTP response helpers for download/streaming routes.
 */

export const MIME_MAP: Record<string, string> = {
  mp4: "video/mp4",
  webm: "video/webm",
  mkv: "video/x-matroska",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  opus: "audio/opus",
  wav: "audio/wav",
};

/**
 * RFC 5987/6266 Content-Disposition builder.
 * The inline `filename` parameter must be a ByteString (latin-1 only), so any
 * non-latin1 characters (em-dashes, Persian, …) are replaced with "_" there,
 * while the UTF-8 `filename*` parameter carries the real name.
 */
export function contentDisposition(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "'");
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
