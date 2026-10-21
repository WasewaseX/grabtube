import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { createReadStream, statSync } from 'fs'
import { Readable } from 'stream'

export const dynamic = 'force-dynamic'
// large downloads need a long window in dev; production streams directly
export const maxDuration = 3600

function safeFileStream(filepath: string, range?: { start: number; end: number }): ReadableStream {
  const rs = createReadStream(filepath, range)
  // prevent unhandled 'error' events (e.g. client aborts) from crashing the server
  rs.on('error', () => rs.destroy())
  return Readable.toWeb(rs) as ReadableStream
}

function encodeFilename(name: string): string {
  const ascii = name.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const job = await db.download.findUnique({ where: { id } })

  if (!job) {
    return NextResponse.json({ error: 'Download not found' }, { status: 404 })
  }
  if (job.status !== 'completed' || !job.filepath) {
    return NextResponse.json(
      { error: 'File is not ready yet', status: job.status, progress: job.progress },
      { status: 409 }
    )
  }

  let fileSize: number
  try {
    fileSize = statSync(job.filepath).size
  } catch {
    return NextResponse.json({ error: 'File missing on disk. Retry the download.' }, { status: 410 })
  }

  const filename = job.filename ?? `video-${id}.mp4`
  const contentType = guessContentType(filename, job.container)

  // ---- HTTP Range support (mandatory for IDM / wget -c / curl resume) ----
  const rangeHeader = req.headers.get('range')
  const baseHeaders: Record<string, string> = {
    'Accept-Ranges': 'bytes',
    'Content-Disposition': encodeFilename(filename),
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'X-Download-Id': id,
  }

  if (rangeHeader) {
    const m = rangeHeader.match(/bytes=(\d*)-(\d*)/)
    if (m) {
      let start = m[1] ? parseInt(m[1], 10) : 0
      let end = m[2] ? parseInt(m[2], 10) : fileSize - 1
      if (isNaN(start) || start < 0) start = 0
      if (isNaN(end) || end >= fileSize) end = fileSize - 1

      if (start > end || start >= fileSize) {
        return new NextResponse(null, {
          status: 416,
          headers: { 'Content-Range': `bytes */${fileSize}`, ...baseHeaders },
        })
      }

      const chunkSize = end - start + 1
      return new NextResponse(safeFileStream(job.filepath, { start, end }), {
        status: 206,
        headers: {
          ...baseHeaders,
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Content-Length': String(chunkSize),
        },
      })
    }
  }

  return new NextResponse(safeFileStream(job.filepath), {
    status: 200,
    headers: {
      ...baseHeaders,
      'Content-Length': String(fileSize),
    },
  })
}

// HEAD support: download managers probe with HEAD first
export async function HEAD(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const job = await db.download.findUnique({ where: { id } })
  if (!job || job.status !== 'completed' || !job.filepath) {
    return new NextResponse(null, { status: 404 })
  }
  try {
    const size = statSync(job.filepath).size
    return new NextResponse(null, {
      status: 200,
      headers: {
        'Accept-Ranges': 'bytes',
        'Content-Length': String(size),
        'Content-Disposition': encodeFilename(job.filename ?? `video-${id}.mp4`),
        'Content-Type': guessContentType(job.filename ?? '', job.container),
      },
    })
  } catch {
    return new NextResponse(null, { status: 410 })
  }
}

function guessContentType(filename: string, container?: string | null): string {
  const ext = (filename.split('.').pop() ?? container ?? 'mp4').toLowerCase()
  const map: Record<string, string> = {
    mp4: 'video/mp4',
    webm: 'video/webm',
    mkv: 'video/x-matroska',
    m4a: 'audio/mp4',
    mp3: 'audio/mpeg',
    opus: 'audio/opus',
    ogg: 'audio/ogg',
    flac: 'audio/flac',
    wav: 'audio/wav',
  }
  return map[ext] ?? 'application/octet-stream'
}
