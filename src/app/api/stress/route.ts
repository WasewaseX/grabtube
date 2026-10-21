import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { startDownload, cancelDownload } from '@/lib/engine'
import { ensurePotServer } from '@/lib/pot'
import { getSettings } from '@/lib/settings'

export const dynamic = 'force-dynamic'
export const maxDuration = 600

/**
 * Stress-test harness (internal).
 * POST { url, mode?, quality?, codec?, container?, timeoutSec? }
 * Runs the full engine synchronously and reports the final job state so
 * automated loops can measure success rates. Not linked in the UI.
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      url?: string
      mode?: 'video' | 'audio'
      quality?: string
      codec?: string
      container?: string
      timeoutSec?: number
      title?: string
    }
    if (!body.url) return NextResponse.json({ error: 'url required' }, { status: 400 })

    await ensurePotServer().catch(() => false)
    const settings = await getSettings()

    const job = await db.download.create({
      data: {
        videoId: 'STRESS',
        url: body.url,
        title: body.title ?? 'Stress test',
        mode: body.mode === 'audio' ? 'audio' : 'video',
        quality: body.quality ?? 'best',
        codec: body.codec ?? 'h264',
        container: body.container ?? 'mp4',
        status: 'pending',
      },
    })

    const timeoutSec = Math.min(Math.max(body.timeoutSec ?? 240, 10), 540)
    const runner = startDownload(job.id)
    const timeout = new Promise<null>(r => setTimeout(() => r(null), timeoutSec * 1000))

    await Promise.race([runner, timeout])
    const final = await db.download.findUnique({ where: { id: job.id } })

    return NextResponse.json({
      ok: final?.status === 'completed',
      settings: {
        hasCookies: Boolean(settings.cookies?.trim()),
        proxyCount: settings.proxies.length,
        potEnabled: settings.usePoToken,
      },
      job: final,
    })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}

export async function DELETE() {
  // cleanup: remove all stress-test rows
  const jobs = await db.download.findMany({ where: { videoId: 'STRESS' } })
  for (const j of jobs) {
    cancelDownload(j.id)
    await db.download.delete({ where: { id: j.id } }).catch(() => {})
  }
  return NextResponse.json({ removed: jobs.length })
}
