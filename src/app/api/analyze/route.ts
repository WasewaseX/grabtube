import { NextRequest, NextResponse } from 'next/server'
import { extractVideoId, fetchInfo, isValidYouTubeUrl, toPublicInfo } from '@/lib/ytdlp'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function POST(req: NextRequest) {
  try {
    const { url } = (await req.json()) as { url?: string }
    if (!url || !isValidYouTubeUrl(url)) {
      return NextResponse.json({ error: 'Please enter a valid YouTube video URL.' }, { status: 400 })
    }

    // fetchInfo runs the full anti-bot stack (cookies, visitor_data, player
    // client chain, PO tokens) and stores the raw payload in the info store.
    const { infoId, raw } = await fetchInfo(url)
    const pub = toPublicInfo(infoId, raw)

    return NextResponse.json({
      video: {
        id: raw.id || extractVideoId(url) || '',
        url,
        title: raw.title,
        thumbnail: raw.thumbnail ?? '',
        duration: raw.duration ?? 0,
        channel: raw.channel ?? raw.uploader ?? '',
        viewCount: raw.view_count ?? 0,
        isLive: Boolean(raw.is_live),
        formats: [...pub.videoFormats, ...pub.audioFormats],
      },
      strategy: 'yt-dlp client-chain',
    })
  } catch (e) {
    const err = e as Error
    return NextResponse.json({ error: err.message || 'Analysis failed' }, { status: 502 })
  }
}
