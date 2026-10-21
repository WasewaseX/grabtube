import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { startDownload } from '@/lib/engine'
import { isValidYouTubeUrl, extractVideoId } from '@/lib/ytdlp'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      url?: string
      title?: string
      thumbnail?: string
      duration?: number
      channel?: string
      mode?: 'video' | 'audio'
      quality?: string
      codec?: string
      container?: string
    }

    if (!body.url || !isValidYouTubeUrl(body.url)) {
      return NextResponse.json({ error: 'Invalid YouTube URL' }, { status: 400 })
    }

    const mode = body.mode === 'audio' ? 'audio' : 'video'
    const quality = body.quality ?? 'best'
    const codec = body.codec ?? (mode === 'audio' ? 'aac' : 'h264')
    const container =
      body.container ?? (mode === 'audio' ? (codec === 'opus' ? 'opus' : 'm4a') : 'mp4')

    const job = await db.download.create({
      data: {
        videoId: extractVideoId(body.url) ?? '',
        url: body.url,
        title: body.title ?? 'Fetching title...',
        thumbnail: body.thumbnail,
        duration: body.duration,
        channel: body.channel,
        mode,
        quality,
        codec,
        container,
        status: 'pending',
      },
    })

    // fire and forget — job runs in background, progress polled via /api/jobs
    void startDownload(job.id)

    return NextResponse.json({ job })
  } catch (e) {
    const err = e as Error
    return NextResponse.json({ error: err.message || 'Failed to start download' }, { status: 500 })
  }
}
