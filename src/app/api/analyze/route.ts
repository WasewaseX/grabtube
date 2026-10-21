import { NextRequest, NextResponse } from 'next/server'
import { analyzeUrl, isValidYouTubeUrl, extractVideoId } from '@/lib/ytdlp'
import { getSettings } from '@/lib/settings'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function POST(req: NextRequest) {
  try {
    const { url } = (await req.json()) as { url?: string }
    if (!url || !isValidYouTubeUrl(url)) {
      return NextResponse.json({ error: 'Please enter a valid YouTube video URL.' }, { status: 400 })
    }

    const settings = await getSettings()
    const { info, strategy } = await analyzeUrl(url, settings)

    return NextResponse.json({
      video: {
        id: info.id || extractVideoId(url) || '',
        url,
        title: info.title,
        thumbnail: info.thumbnail,
        duration: info.duration,
        channel: info.channel ?? info.uploader,
        viewCount: info.viewCount,
        isLive: info.isLive,
        formats: info.formats,
      },
      strategy,
    })
  } catch (e) {
    const err = e as Error
    return NextResponse.json({ error: err.message || 'Analysis failed' }, { status: 502 })
  }
}
