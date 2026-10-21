export interface YtFormat {
  formatId: string
  ext: string
  height?: number
  width?: number
  fps?: number
  vcodec?: string
  acodec?: string
  abr?: number
  tbr?: number
  filesize?: number
  filesizeApprox?: number
  formatNote?: string
  dynamicRange?: string
}

export interface VideoResult {
  id: string
  url: string
  title: string
  thumbnail?: string
  duration?: number
  channel?: string
  viewCount?: number
  isLive: boolean
  formats: YtFormat[]
}

export interface Job {
  id: string
  videoId: string
  url: string
  title: string
  thumbnail?: string | null
  duration?: number | null
  channel?: string | null
  mode: 'video' | 'audio' | string
  quality: string
  codec: string
  container: string
  status: string // pending | downloading | processing | completed | failed | canceled
  stage: string
  progress: number
  speed?: string | null
  eta?: string | null
  filesize?: number | null
  filename?: string | null
  filepath?: string | null
  error?: string | null
  attempts: number
  strategy?: string | null
  directUrl?: string | null
  createdAt: string
  updatedAt: string
}

export interface HealthInfo {
  ytDlp: string
  ffmpeg: string
  deno: string
  potServer: string
}

export interface SettingsInfo {
  hasCookies: boolean
  proxyCount: number
  cookies?: string
  proxies?: { url: string; healthy?: boolean }[]
  clientOrder?: string[]
  concurrentFragments?: number
  maxRetries?: number
  usePoToken?: boolean
}
