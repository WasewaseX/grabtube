// ---- Raw model (yt-dlp JSON / provider adapters share this shape) ----------

export interface YtRawFormat {
  format_id: string
  ext?: string
  url?: string
  vcodec?: string
  acodec?: string
  height?: number
  width?: number
  fps?: number
  tbr?: number
  abr?: number
  asr?: number
  filesize?: number
  filesize_approx?: number
  protocol?: string
  format_note?: string
  dynamic_range?: string
  container?: string
}

export interface RawInfo {
  id: string
  title: string
  uploader?: string
  channel?: string
  duration?: number
  view_count?: number
  thumbnail?: string
  webpage_url: string
  is_live?: boolean
  live_status?: string
  extractor_key?: string
  formats: YtRawFormat[]
}

// ---- Public model (UI-facing) ----------------------------------------------

export interface PublicFormat {
  id: string // format id, or composite "videoId|audioId|container" for merges
  kind: 'video' | 'audio'
  quality: string
  container: string
  height?: number // raw pixel height (e.g. 1080) — undefined for audio
  vcodec?: string
  acodec?: string
  fps?: number
  filesize?: number
  approx?: boolean
  hasAudio?: boolean
  instant: boolean
  needsMerge: boolean
  hdr?: boolean
  recommended?: boolean
}

export interface PublicInfo {
  infoId: string
  title: string
  author: string
  views: number
  duration: number
  thumbnail: string
  webpageUrl: string
  source: string // "youtube" | "other" | provider label
  videoFormats: PublicFormat[]
  audioFormats: PublicFormat[]
  mp3Options: number[]
}
