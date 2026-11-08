import type { PublicFormat } from "../../../lib/ytdlp";

export function fmtDuration(sec: number): string {
  if (!sec || sec <= 0) return "";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

export function fmtBytes(b: number): string {
  if (!b || b <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = b;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function qualityHeight(q: string): number {
  return parseInt(q, 10) || 0;
}

export function fmtHeight(f: PublicFormat): number {
  const m = f.quality?.match(/(\d{3,4})/);
  return m ? parseInt(m[1], 10) : 0;
}

export function fmtCodec(f: PublicFormat): string | null {
  const v = (f.vcodec ?? "").toLowerCase();
  if (v.startsWith("h264") || v.startsWith("h.264") || v.startsWith("avc")) return "H.264 (AVC)";
  if (v.startsWith("vp9") || v.startsWith("vp09")) return "VP9";
  if (v.startsWith("av1") || v.startsWith("av01")) return "AV1";
  return null;
}
