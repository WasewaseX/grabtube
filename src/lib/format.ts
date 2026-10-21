/**
 * Deterministic, locale-independent formatters.
 * IMPORTANT: these are hydration-safe (no Date.now/Math.random/locale APIs)
 * as long as they are only invoked with values that exist after mount
 * (e.g. fetched data) or inside event handlers.
 */

export function formatDuration(seconds?: number | null): string {
  if (seconds === undefined || seconds === null || !isFinite(seconds) || seconds <= 0) return '--:--'
  const s = Math.round(seconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
  return `${m}:${String(sec).padStart(2, '0')}`
}

export function formatBytes(bytes?: number | null): string {
  if (!bytes || bytes <= 0 || !isFinite(bytes)) return '--'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  const digits = v >= 100 || i === 0 ? 0 : v >= 10 ? 1 : 2
  return `${v.toFixed(digits)} ${units[i]}`
}

export function formatCount(n?: number | null): string {
  if (n === undefined || n === null) return ''
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B views`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M views`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K views`
  return `${n} views`
}

export function formatWhen(iso?: string | null): string {
  if (!iso) return ''
  const then = new Date(iso).getTime()
  if (isNaN(then)) return ''
  const now = Date.now()
  const diff = Math.max(0, now - then)
  const min = Math.floor(diff / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d ago`
  const dt = new Date(then)
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${months[dt.getUTCMonth()]} ${dt.getUTCDate()}, ${dt.getUTCFullYear()}`
}

export function qualityLabel(quality: string): string {
  const h = parseInt(quality, 10)
  if (isNaN(h)) return quality === 'best' ? 'Best' : quality
  if (h >= 4320) return '4320p (8K)'
  if (h >= 2160) return '2160p (4K)'
  if (h >= 1440) return '1440p (2K)'
  if (h >= 1080) return '1080p (Full HD)'
  if (h >= 720) return '720p (HD)'
  return `${h}p`
}

export function codecLabel(codec: string): string {
  switch (codec) {
    case 'h264':
      return 'H.264'
    case 'vp9':
      return 'VP9'
    case 'av1':
      return 'AV1'
    case 'aac':
      return 'AAC'
    case 'opus':
      return 'Opus'
    default:
      return codec.toUpperCase()
  }
}

export const STATUS_META: Record<string, { label: string; cls: string }> = {
  pending: { label: 'Queued', cls: 'bg-zinc-700/60 text-zinc-200' },
  downloading: { label: 'Downloading', cls: 'bg-amber-500/15 text-amber-400 border border-amber-500/30' },
  processing: { label: 'Processing', cls: 'bg-amber-500/15 text-amber-400 border border-amber-500/30' },
  completed: { label: 'Completed', cls: 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30' },
  failed: { label: 'Failed', cls: 'bg-red-500/15 text-red-400 border border-red-500/30' },
  canceled: { label: 'Canceled', cls: 'bg-zinc-700/60 text-zinc-300' },
}

export function isActiveStatus(status: string): boolean {
  return status === 'pending' || status === 'downloading' || status === 'processing'
}
