import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { cancelDownload, startDownload, isJobActive } from '@/lib/engine'
import { unlink, rm } from 'fs/promises'
import path from 'path'
import { DOWNLOAD_DIR } from '@/lib/engine'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const job = await db.download.findUnique({ where: { id } })
  if (!job) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ job })
}

// PATCH actions: cancel | retry
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const { action } = (await req.json()) as { action?: string }
  const job = await db.download.findUnique({ where: { id } })
  if (!job) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  if (action === 'cancel') {
    const wasActive = isJobActive(id)
    cancelDownload(id)
    await db.download.update({
      where: { id },
      data: { status: 'canceled', stage: 'canceled', speed: null, eta: null },
    })
    return NextResponse.json({ ok: true, wasActive })
  }

  if (action === 'retry') {
    cancelDownload(id)
    await db.download.update({
      where: { id },
      data: { status: 'pending', stage: 'extract', error: null, progress: 0, speed: null, eta: null },
    })
    void startDownload(id)
    return NextResponse.json({ ok: true })
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const job = await db.download.findUnique({ where: { id } })
  if (!job) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  cancelDownload(id)

  if (job.filepath) {
    try {
      await unlink(job.filepath)
    } catch {
      /* file may be gone */
    }
  }
  try {
    await rm(path.join(DOWNLOAD_DIR, id), { recursive: true, force: true })
  } catch {
    /* ignore */
  }

  await db.download.delete({ where: { id } })
  return NextResponse.json({ ok: true })
}
