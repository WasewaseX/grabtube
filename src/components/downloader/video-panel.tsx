'use client'

import { useMemo, useState } from 'react'
import { Download, Film, Music, Eye, CheckCircle2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
import type { VideoResult } from '@/lib/types'
import { formatDuration, formatBytes, formatCount, codecLabel } from '@/lib/format'

interface VideoPanelProps {
  video: VideoResult
  onDownload: (opts: {
    mode: 'video' | 'audio'
    quality: string
    codec: string
    container: string
  }) => Promise<void>
  starting: boolean
}

interface HeightOption {
  height: number
  label: string
  fpsMax: number
  codecs: Set<string>
  size?: number
}

function qualityName(h: number): string {
  if (h >= 4320) return '4320p (8K)'
  if (h >= 2160) return '2160p (4K)'
  if (h >= 1440) return '1440p (2K)'
  if (h >= 1080) return '1080p (Full HD)'
  if (h >= 720) return '720p (HD)'
  if (h >= 480) return '480p'
  if (h >= 360) return '360p'
  return `${h}p`
}

const CODEC_PREFIX: Record<string, string> = {
  h264: 'avc1',
  vp9: 'vp9',
  av1: 'av01',
}

export function VideoPanel({ video, onDownload, starting }: VideoPanelProps) {
  const [mode, setMode] = useState<'video' | 'audio'>('video')
  const [quality, setQuality] = useState('best')
  const [codec, setCodec] = useState('h264')
  const [container, setContainer] = useState('mp4')
  const [audioContainer, setAudioContainer] = useState('m4a')

  const heights = useMemo<HeightOption[]>(() => {
    const map = new Map<number, HeightOption>()
    for (const f of video.formats) {
      if (!f.height || !f.vcodec || f.vcodec === 'none') continue
      const key = f.height
      const entry = map.get(key) ?? {
        height: key,
        label: qualityName(key),
        fpsMax: 0,
        codecs: new Set<string>(),
        size: undefined,
      }
      entry.fpsMax = Math.max(entry.fpsMax, f.fps ?? 0)
      for (const [name, prefix] of Object.entries(CODEC_PREFIX)) {
        if (f.vcodec.startsWith(prefix)) entry.codecs.add(name)
      }
      // track largest file size at this height for estimate
      const fs = f.filesize ?? f.filesizeApprox
      if (fs && (!entry.size || fs > entry.size)) entry.size = fs
      map.set(key, entry)
    }
    const list = Array.from(map.values()).sort((a, b) => b.height - a.height)
    return list
  }, [video.formats])

  const audioAvailable = useMemo(() => {
    const codecs = new Set<string>()
    let bestSize = 0
    for (const f of video.formats) {
      if (f.vcodec && f.vcodec !== 'none') continue
      if (!f.acodec || f.acodec === 'none') continue
      if (f.acodec.startsWith('mp4a')) codecs.add('aac')
      if (f.acodec.startsWith('opus')) codecs.add('opus')
      const fs = f.filesize ?? f.filesizeApprox ?? 0
      if (fs > bestSize) bestSize = fs
    }
    return { codecs, bestSize }
  }, [video.formats])

  const bestAudioSize = audioAvailable.bestSize

  const estimate = useMemo(() => {
    if (mode === 'audio') {
      return bestAudioSize ? formatBytes(bestAudioSize) : undefined
    }
    const h = quality === 'best' ? null : parseInt(quality, 10)
    const candidates = heights.filter(x => (h === null ? true : x.height <= h))
    const vsize = candidates[0]?.size
    if (vsize && bestAudioSize) return formatBytes(vsize + bestAudioSize)
    return vsize ? formatBytes(vsize) : undefined
  }, [mode, quality, heights, bestAudioSize])

  const codecOptions = ['h264', 'vp9', 'av1'].map(c => {
    const availableAtHeight = heights.some(x => x.codecs.has(c))
    return { value: c, label: codecLabel(c), available: availableAtHeight }
  })

  const audioCodecOptions = [
    { value: 'aac', label: 'AAC (native)', available: audioAvailable.codecs.has('aac') },
    { value: 'opus', label: 'Opus (native)', available: audioAvailable.codecs.has('opus') },
  ]

  const effectiveAudioContainer =
    audioContainer === 'm4a' || audioContainer === 'mp3'
      ? 'm4a'
      : audioContainer === 'opus'
        ? 'opus'
        : audioContainer

  const startDownload = async () => {
    if (mode === 'video') {
      await onDownload({ mode, quality, codec, container })
    } else {
      // mp3/flac/wav get transcoded by ffmpeg from bestaudio (aac or opus source)
      const src = audioAvailable.codecs.has('opus') ? 'opus' : 'aac'
      await onDownload({ mode: 'audio', quality: 'best', codec: src, container: audioContainer })
    }
  }

  return (
    <Card className="border-zinc-800 bg-zinc-900/60 shadow-xl shadow-black/20 overflow-hidden">
      <CardContent className="p-0">
        <div className="flex flex-col md:flex-row">
          {/* thumbnail */}
          <div className="relative md:w-72 shrink-0 bg-zinc-950">
            {video.thumbnail ? (
              <img
                src={video.thumbnail}
                alt={`Thumbnail of ${video.title}`}
                className="h-44 md:h-full w-full object-cover"
                referrerPolicy="no-referrer"
              />
            ) : (
              <div className="h-44 md:h-full w-full flex items-center justify-center text-zinc-700">
                <Film className="h-10 w-10" aria-hidden="true" />
              </div>
            )}
            <span className="absolute bottom-2 right-2 rounded bg-black/80 px-1.5 py-0.5 text-[11px] font-medium text-white">
              {formatDuration(video.duration)}
            </span>
          </div>

          {/* info + controls */}
          <div className="flex-1 p-4 md:p-5 space-y-4 min-w-0">
            <div>
              <h2 className="font-semibold text-sm md:text-base leading-snug line-clamp-2" title={video.title}>
                {video.title}
              </h2>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500">
                <span className="font-medium text-zinc-400">{video.channel ?? 'Unknown channel'}</span>
                {video.viewCount ? <span className="flex items-center gap-1"><Eye className="h-3 w-3" aria-hidden="true" />{formatCount(video.viewCount)}</span> : null}
                {video.isLive ? <Badge className="bg-red-600/15 text-red-400 border border-red-500/30 text-[10px]">LIVE</Badge> : null}
              </div>
            </div>

            <Tabs value={mode} onValueChange={v => setMode(v as 'video' | 'audio')}>
              <TabsList className="bg-zinc-950 border border-zinc-800 h-9">
                <TabsTrigger value="video" className="text-xs data-[state=active]:bg-zinc-800 gap-1.5 px-3">
                  <Film className="h-3.5 w-3.5" aria-hidden="true" /> Video + Audio
                </TabsTrigger>
                <TabsTrigger value="audio" className="text-xs data-[state=active]:bg-zinc-800 gap-1.5 px-3">
                  <Music className="h-3.5 w-3.5" aria-hidden="true" /> Audio only
                </TabsTrigger>
              </TabsList>
            </Tabs>

            {mode === 'video' ? (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="space-y-1.5">
                  <label className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">Quality</label>
                  <Select value={quality} onValueChange={setQuality}>
                    <SelectTrigger className="bg-zinc-950 border-zinc-800 h-10 text-sm" aria-label="Video quality">
                      <SelectValue placeholder="Quality" />
                    </SelectTrigger>
                    <SelectContent className="bg-zinc-900 border-zinc-800 max-h-72">
                      <SelectItem value="best">Best available</SelectItem>
                      {heights.map(h => (
                        <SelectItem key={h.height} value={String(h.height)}>
                          {h.label}
                          {h.fpsMax > 30 ? <span className="text-zinc-500 text-xs"> · {h.fpsMax}fps</span> : null}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <label className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">Video codec</label>
                  <Select value={codec} onValueChange={setCodec}>
                    <SelectTrigger className="bg-zinc-950 border-zinc-800 h-10 text-sm" aria-label="Video codec">
                      <SelectValue placeholder="Codec" />
                    </SelectTrigger>
                    <SelectContent className="bg-zinc-900 border-zinc-800">
                      {codecOptions.map(c => (
                        <SelectItem key={c.value} value={c.value}>
                          <span className="flex items-center gap-2">
                            {c.label}
                            {c.available ? (
                              <CheckCircle2 className="h-3 w-3 text-emerald-500" aria-label="available in this video" />
                            ) : (
                              <span className="text-[10px] text-zinc-600">(fallback)</span>
                            )}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <label className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">Container</label>
                  <Select value={container} onValueChange={setContainer}>
                    <SelectTrigger className="bg-zinc-950 border-zinc-800 h-10 text-sm" aria-label="Container">
                      <SelectValue placeholder="Container" />
                    </SelectTrigger>
                    <SelectContent className="bg-zinc-900 border-zinc-800">
                      <SelectItem value="mp4">MP4 (compatible)</SelectItem>
                      <SelectItem value="webm">WebM</SelectItem>
                      <SelectItem value="mkv">MKV</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">Format</label>
                  <Select value={audioContainer} onValueChange={setAudioContainer}>
                    <SelectTrigger className="bg-zinc-950 border-zinc-800 h-10 text-sm" aria-label="Audio format">
                      <SelectValue placeholder="Format" />
                    </SelectTrigger>
                    <SelectContent className="bg-zinc-900 border-zinc-800">
                      <SelectItem value="m4a">M4A / AAC — original quality</SelectItem>
                      <SelectItem value="mp3">MP3 — universal</SelectItem>
                      <SelectItem value="opus">Opus — smallest</SelectItem>
                      <SelectItem value="flac">FLAC — lossless</SelectItem>
                      <SelectItem value="wav">WAV — uncompressed</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <label className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">Source codec</label>
                  <div className="flex h-10 items-center gap-2 rounded-md border border-zinc-800 bg-zinc-950 px-3 text-sm">
                    {audioCodecOptions.filter(c => c.available).map(c => c.label).join(', ') || 'Best available'}
                  </div>
                </div>
              </div>
            )}

            <div className="flex flex-col sm:flex-row sm:items-center gap-3 pt-1">
              <Button
                onClick={startDownload}
                disabled={starting}
                className="bg-red-600 hover:bg-red-500 text-white font-semibold h-11 px-6"
              >
                <Download className="h-4 w-4 mr-1" aria-hidden="true" />
                {starting ? 'Starting...' : 'Download'}
              </Button>
              {estimate ? (
                <span className="text-xs text-zinc-500">
                  Estimated size: <span className="text-zinc-300 font-medium">{estimate}</span>
                </span>
              ) : null}
              {effectiveAudioContainer === 'mp3' || audioContainer === 'mp3' ? (
                <span className="text-[11px] text-zinc-600">converted by ffmpeg on server</span>
              ) : null}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
