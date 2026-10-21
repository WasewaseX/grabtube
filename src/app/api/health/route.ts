import { NextResponse } from 'next/server'
import { execFile } from 'child_process'
import { getYtDlpPath, getFfmpegPath, getDenoPath, POT_SERVER_URL } from '@/lib/ytdlp'
import { ensurePotServer } from '@/lib/pot'

export const dynamic = 'force-dynamic'

function version(cmd: string, args: string[]): Promise<string> {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout: 10000 }, (err, stdout) => {
      resolve(err ? 'not found' : String(stdout ?? '').trim().split('\n')[0])
    })
  })
}

async function potStatus(): Promise<string> {
  const up = await ensurePotServer()
  if (!up) return 'offline'
  try {
    const res = await fetch(`${POT_SERVER_URL}/ping`, { signal: AbortSignal.timeout(4000) })
    if (!res.ok) return 'offline'
    const data = (await res.json()) as { version?: string }
    return `online v${data.version ?? '?'}`
  } catch {
    return 'offline'
  }
}

export async function GET() {
  const [ytDlp, ffmpeg, deno, pot] = await Promise.all([
    version(getYtDlpPath(), ['--version']),
    version(getFfmpegPath(), ['-version']),
    version(getDenoPath(), ['--version']),
    potStatus(),
  ])
  return NextResponse.json({
    ytDlp,
    ffmpeg: ffmpeg === 'not found' ? 'not found' : ffmpeg.replace('ffmpeg version ', '').split(' ')[0],
    deno: deno === 'not found' ? 'not found' : (deno.match(/deno (\d+\.\d+\.\d+)/)?.[1] ?? deno.split('\n')[0]),
    potServer: pot,
  })
}
