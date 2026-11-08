import type { PublicFormat } from "../../../lib/ytdlp";

export const MP3_FMT: PublicFormat = {
  id: "mp3",
  kind: "audio",
  quality: "mp3",
  container: "mp3",
  hasAudio: true,
  needsMerge: false,
  instant: false,
};
