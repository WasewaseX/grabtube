// ---- Format selection ------------------------------------------------------

export interface SelectOptions {
  mode: 'video' | 'audio'
  quality: string // "2160" | "1440" | "1080" | "720" | "480" | "360" | "best"
  codec: string // h264 | vp9 | av1 | aac | opus
  container: string // mp4 | webm | mkv | m4a | mp3 | opus | flac | wav
}

const VIDEO_CODEC_MAP: Record<string, string> = {
  h264: 'avc1',
  vp9: 'vp9',
  av1: 'av01',
}

const AUDIO_CODEC_MAP: Record<string, string> = {
  aac: 'mp4a',
  opus: 'opus',
}

export function buildFormatString(o: SelectOptions): string {
  if (o.mode === 'audio') {
    const ac = AUDIO_CODEC_MAP[o.codec]
    if (ac) return `bestaudio[acodec^=${ac}]/bestaudio/best`
    return 'bestaudio/best'
  }
  const h = o.quality === 'best' ? 4321 : parseInt(o.quality, 10) || 2160
  const vc = VIDEO_CODEC_MAP[o.codec]
  const prefer = vc ? `bv*[vcodec^=${vc}][height<=${h}]` : `bv*[height<=${h}]`
  return `${prefer}+ba[acodec^=mp4a]/${prefer}+ba/bv*[height<=${h}]+ba/b[height<=${h}]/bv*+ba/b`
}

export function buildOutputArgs(o: SelectOptions): string[] {
  const args: string[] = []
  if (o.mode === 'audio') {
    args.push('-x', '--audio-format', o.container, '--audio-quality', '0', '--add-metadata')
  } else {
    args.push('--merge-output-format', o.container === 'webm' ? 'webm' : 'mp4')
    args.push('--embed-metadata')
  }
  return args
}
