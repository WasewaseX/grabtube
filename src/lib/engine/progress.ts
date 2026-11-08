// ---- Progress parsing ------------------------------------------------------

import { db } from '@/lib/db'

export interface ProgressUpdate {
  progress?: number
  speed?: string
  eta?: string
  stage?: string
  filesize?: number
}

const SPEED_RE = /at\s+([\d.]+\s*[KMG]?i?B\/s)/
const ETA_RE = /ETA\s+(\d+:\d+(?::\d+)?)/
const PERCENT_RE = /\[download\]\s+([\d.]+)%\s+of\s+~?\s*([\d.]+\s*[KMG]?i?B)/

export function parseProgressLine(line: string): ProgressUpdate | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('[download]')) {
    if (trimmed.startsWith('[Merger]')) return { stage: 'merge', progress: 99 }
    if (trimmed.startsWith('[ExtractAudio]')) return { stage: 'extract_audio', progress: 99 }
    if (trimmed.startsWith('[EmbedThumbnail]') || trimmed.startsWith('[Metadata]'))
      return { stage: 'finalize', progress: 99 }
    return null
  }
  const pm = trimmed.match(PERCENT_RE)
  if (!pm) return null
  const progress = Math.min(99.5, parseFloat(pm[1]))
  const sm = trimmed.match(SPEED_RE)
  const em = trimmed.match(ETA_RE)
  return {
    progress,
    speed: sm ? sm[1] : undefined,
    eta: em ? em[1] : undefined,
    stage: 'download',
    filesize: parseSizeToBytes(pm[2]),
  }
}

function parseSizeToBytes(s: string): number {
  const m = s.match(/([\d.]+)\s*([KMGT]i?B)/)
  if (!m) return 0
  const n = parseFloat(m[1])
  const mult: Record<string, number> = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 }
  return Math.round(n * (mult[m[2].replace('i', '')] ?? 1))
}

let lastDbUpdate = 0

export function throttledJobUpdate(id: string, upd: ProgressUpdate) {
  const now = Date.now()
  if (now - lastDbUpdate < 1200) return
  lastDbUpdate = now
  db.download
    .update({
      where: { id },
      data: {
        progress: upd.progress,
        speed: upd.speed,
        eta: upd.eta,
        stage: upd.stage,
        filesize: upd.filesize,
      },
    })
    .catch(() => {})
}
