import { hasFfmpeg } from './tools'
import type { PublicFormat, PublicInfo, RawInfo, YtRawFormat } from './model'
import { isYouTubeUrl } from './url'

function codecLabel(c?: string): string | undefined {
  if (!c || c === 'none') return undefined
  const s = c.toLowerCase()
  if (s.startsWith('avc1') || s.startsWith('avc3') || s.includes('h264') || s.includes('h.264')) return 'H.264'
  if (s.startsWith('vp9') || s.includes('vp09')) return 'VP9'
  if (s.startsWith('vp8')) return 'VP8'
  if (s.startsWith('av01')) return 'AV1'
  if (s.startsWith('mp4a') || s.includes('aac')) return 'AAC'
  if (s.includes('opus')) return 'Opus'
  if (s.includes('vorbis')) return 'Vorbis'
  if (s.includes('ec-3') || s.includes('eac3')) return 'E-AC3'
  if (s.includes('ac-3')) return 'AC3'
  return c.split('.')[0].toUpperCase()
}

function fmtSize(f: YtRawFormat): number | undefined {
  return f.filesize || f.filesize_approx || undefined
}

function videoQuality(f: YtRawFormat): string {
  const h = f.height
  if (!h) return f.format_note || f.format_id
  const fps = f.fps && f.fps > 30 ? f.fps : 0
  return `${h}p${fps || ''}`
}

function audioQuality(f: YtRawFormat): string {
  const k = Math.round(f.abr || f.tbr || 0)
  return k > 0 ? `${k}k` : f.format_note || f.format_id
}

function isStreamable(f: YtRawFormat): boolean {
  const proto = (f.protocol ?? '').toLowerCase()
  return proto === 'https' || proto === 'http' || proto === ''
}

function pickAudio(formats: YtRawFormat[], container: string): YtRawFormat | null {
  const audios = formats.filter((f) => f.vcodec === 'none' && f.acodec && f.acodec !== 'none')
  if (audios.length === 0) return null
  const family = /webm|mkv/.test(container) ? ['opus', 'vorbis'] : ['mp4a', 'aac']
  const scored = audios
    .map((f) => {
      const s = (f.acodec ?? '').toLowerCase()
      const fam = family.some((x) => s.includes(x)) ? 1 : 0
      return { f, score: fam * 1000 + (f.abr ?? f.tbr ?? 0) }
    })
    .sort((a, b) => b.score - a.score)
  return scored[0].f
}

function sourceLabel(raw: RawInfo): string {
  const isYT = /youtube/i.test(raw.extractor_key ?? '') || isYouTubeUrl(raw.webpage_url)
  return /:savenow/i.test(raw.extractor_key ?? '')
    ? 'Community mirror'
    : /:piped/i.test(raw.extractor_key ?? '')
      ? 'Piped'
      : /:invidious/i.test(raw.extractor_key ?? '')
        ? 'Invidious'
        : isYT
          ? 'youtube'
          : 'other'
}

function thumbProxy(u?: string): string {
  if (!u || !/^https?:\/\//.test(u)) return ''
  return `/api/thumb?url=${encodeURIComponent(u)}`
}

function muxedInstantFormat(f: YtRawFormat, size: number | undefined): PublicFormat | null {
  const ext = (f.ext ?? 'mp4').toLowerCase()
  if (!isStreamable(f)) return null
  return {
    id: f.format_id,
    kind: 'video',
    quality: videoQuality(f),
    container: ext === 'webm' ? 'webm' : 'mp4',
    height: f.height,
    vcodec: codecLabel(f.vcodec),
    acodec: codecLabel(f.acodec),
    fps: f.fps,
    filesize: size,
    approx: !f.filesize,
    hasAudio: true,
    instant: true,
    needsMerge: false,
    hdr: /hdr/i.test(f.dynamic_range ?? ''),
    recommended: true,
  }
}

function videoOnlyEntry(f: YtRawFormat, size: number | undefined): { f: YtRawFormat; fmt: PublicFormat } {
  const ext = (f.ext ?? 'mp4').toLowerCase()
  const container = ext === 'webm' ? 'webm' : 'mp4'
  return {
    f,
    fmt: {
      id: f.format_id, // replaced by composite below
      kind: 'video',
      quality: videoQuality(f),
      container,
      height: f.height,
      vcodec: codecLabel(f.vcodec),
      fps: f.fps,
      filesize: size,
      approx: !f.filesize,
      hasAudio: false,
      instant: false,
      needsMerge: true,
      hdr: /hdr/i.test(f.dynamic_range ?? ''),
    },
  }
}

function audioOnlyFormat(f: YtRawFormat, size: number | undefined): PublicFormat | null {
  const ext = (f.ext ?? 'mp4').toLowerCase()
  if (!isStreamable(f)) return null
  return {
    id: f.format_id,
    kind: 'audio',
    quality: audioQuality(f),
    container: ext === 'webm' ? 'webm' : ext === 'm4a' ? 'm4a' : ext,
    acodec: codecLabel(f.acodec),
    filesize: size,
    approx: !f.filesize,
    hasAudio: true,
    instant: true,
    needsMerge: false,
  }
}

/** Composite merges: pair each video-only track with its best audio partner. */
function compositeMerges(
  formats: YtRawFormat[],
  videoOnly: Array<{ f: YtRawFormat; fmt: PublicFormat }>,
): PublicFormat[] {
  // A video-only track with NO audio partner in the same container family
  // can never be merged into a playable file — offering it as a tile only
  // produces a server job that fails with "Bad merge request". Skip it.
  const out: PublicFormat[] = []
  for (const { f, fmt } of videoOnly) {
    const a = pickAudio(formats, fmt.container)
    if (!a) continue
    const id = `${f.format_id}|${a.format_id}|${fmt.container}`
    const total = (fmt.filesize ?? 0) + (fmtSize(a) ?? 0)
    out.push({
      ...fmt,
      id,
      filesize: total > 0 ? total : fmt.filesize,
      approx: !f.filesize || !a.filesize,
    })
  }
  return out
}

function rankVideo(f: PublicFormat): number {
  const h = parseInt(f.quality, 10) || 0
  return h * 100 + (f.fps ?? 0) * 2 + (f.container === 'mp4' ? 1 : 0)
}

export function toPublicInfo(infoId: string, raw: RawInfo): PublicInfo {
  const instant: PublicFormat[] = []
  const videoOnly: Array<{ f: YtRawFormat; fmt: PublicFormat }> = []
  const audio: PublicFormat[] = []

  for (const f of raw.formats) {
    const hasV = f.vcodec && f.vcodec !== 'none'
    const hasA = f.acodec && f.acodec !== 'none'
    const size = fmtSize(f)

    if (hasV && hasA) {
      // muxed — instant single-stream
      const fmt = muxedInstantFormat(f, size)
      if (fmt) instant.push(fmt)
    } else if (hasV) {
      videoOnly.push(videoOnlyEntry(f, size))
    } else if (hasA) {
      const fmt = audioOnlyFormat(f, size)
      if (fmt) audio.push(fmt)
    }
  }

  const composites = compositeMerges(raw.formats, videoOnly)
  instant.sort((a, b) => rankVideo(b) - rankVideo(a))
  composites.sort((a, b) => rankVideo(b) - rankVideo(a))
  audio.sort((a, b) => (parseInt(b.quality, 10) || 0) - (parseInt(a.quality, 10) || 0))

  return {
    infoId,
    title: raw.title,
    author: raw.uploader || raw.channel || '',
    views: raw.view_count ?? 0,
    duration: raw.duration ?? 0,
    thumbnail: thumbProxy(raw.thumbnail),
    webpageUrl: raw.webpage_url,
    source: sourceLabel(raw),
    videoFormats: [...composites, ...instant],
    audioFormats: audio,
    mp3Options: hasFfmpeg() ? [320, 192, 128] : [],
  }
}
