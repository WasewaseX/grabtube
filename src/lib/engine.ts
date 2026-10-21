import { spawn, ChildProcess } from 'child_process'
import { readdirSync, statSync, mkdirSync } from 'fs'
import path from 'path'
import { db } from '@/lib/db'
import { buildBypassArgs, detectBotCheck, getFfmpegPath, getYtDlpPath, ExtractionError } from '@/lib/ytdlp'
import { getSettings, markProxyResult, healthyProxies } from '@/lib/settings'

export const DOWNLOAD_DIR = '/home/z/my-project/downloads'

// ---- Active job registry ---------------------------------------------------

interface ActiveJob {
  process: ChildProcess | null
  canceled: boolean
}

const globalForEngine = globalThis as unknown as {
  activeJobs: Map<string, ActiveJob> | undefined
}
const activeJobs: Map<string, ActiveJob> = globalForEngine.activeJobs ?? new Map()
globalForEngine.activeJobs = activeJobs

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

// ---- Progress parsing ------------------------------------------------------

interface ProgressUpdate {
  progress?: number
  speed?: string
  eta?: string
  stage?: string
  filesize?: number
}

const SPEED_RE = /at\s+([\d.]+\s*[KMG]?i?B\/s)/
const ETA_RE = /ETA\s+(\d+:\d+(?::\d+)?)/
const PERCENT_RE = /\[download\]\s+([\d.]+)%\s+of\s+~?\s*([\d.]+\s*[KMG]?i?B)/

export function parseProgressLine(line: string): ProgressUpdate | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('[download]')) {
    if (trimmed.startsWith('[Merger]')) return { stage: 'merge', progress: 99 }
    if (trimmed.startsWith('[ExtractAudio]')) return { stage: 'extract_audio', progress: 99 }
    if (trimmed.startsWith('[EmbedThumbnail]') || trimmed.startsWith('[Metadata]'))
      return { stage: 'finalize', progress: 99 }
    return null
  }
  const pm = trimmed.match(PERCENT_RE)
  if (!pm) return null
  const progress = Math.min(99.5, parseFloat(pm[1]))
  const sm = trimmed.match(SPEED_RE)
  const em = trimmed.match(ETA_RE)
  return {
    progress,
    speed: sm ? sm[1] : undefined,
    eta: em ? em[1] : undefined,
    stage: 'download',
    filesize: parseSizeToBytes(pm[2]),
  }
}

function parseSizeToBytes(s: string): number {
  const m = s.match(/([\d.]+)\s*([KMGT]i?B)/)
  if (!m) return 0
  const n = parseFloat(m[1])
  const mult: Record<string, number> = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 }
  return Math.round(n * (mult[m[2].replace('i', '')] ?? 1))
}

// ---- Helpers ---------------------------------------------------------------

function findFinalFile(dir: string): { filename: string; filepath: string; size: number } | null {
  try {
    for (const f of readdirSync(dir)) {
      if (f.endsWith('.part') || f.endsWith('.ytdl') || f.endsWith('.tmp')) continue
      const fp = path.join(dir, f)
      const st = statSync(fp)
      if (st.isFile() && st.size > 0) return { filename: f, filepath: fp, size: st.size }
    }
  } catch {
    /* ignore */
  }
  return null
}

let lastDbUpdate = 0

function throttledJobUpdate(id: string, upd: ProgressUpdate) {
  const now = Date.now()
  if (now - lastDbUpdate < 1200) return
  lastDbUpdate = now
  db.download
    .update({
      where: { id },
      data: {
        progress: upd.progress,
        speed: upd.speed,
        eta: upd.eta,
        stage: upd.stage,
        filesize: upd.filesize,
      },
    })
    .catch(() => {})
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

// ---- Single attempt --------------------------------------------------------

interface AttemptOpts {
  client: string
  proxy?: string
  cookies?: string
  usePoToken?: boolean
  concurrentFragments?: number
}

async function runSingleAttempt(
  jobId: string,
  url: string,
  outDir: string,
  select: SelectOptions,
  opts: AttemptOpts,
  registry: ActiveJob
): Promise<void> {
  const bypass = await buildBypassArgs({
    cookies: opts.cookies,
    proxy: opts.proxy,
    client: opts.client,
    usePoToken: opts.usePoToken,
  })
  const outputTemplate = path.join(outDir, '%(title).150B.%(ext)s')
  const args = [
    '--no-playlist',
    '--no-warnings',
    '--newline',
    '--no-mtime',
    '--continue',
    '--restrict-filenames',
    '--concurrent-fragments', String(opts.concurrentFragments ?? 5),
    '-f', buildFormatString(select),
    ...buildOutputArgs(select),
    ...bypass,
    '-o', outputTemplate,
    '--ffmpeg-location', getFfmpegPath(),
    url,
  ]

  return new Promise((resolve, reject) => {
    const proc = spawn(getYtDlpPath(), args, { stdio: ['ignore', 'pipe', 'pipe'] })
    registry.process = proc
    let stderrBuf = ''

    proc.stdout.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) {
        const upd = parseProgressLine(line)
        if (upd) throttledJobUpdate(jobId, upd)
      }
    })

    proc.stderr.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString()
      if (stderrBuf.length > 100000) stderrBuf = stderrBuf.slice(-50000)
    })

    proc.on('error', err => reject(new ExtractionError(`Failed to spawn yt-dlp: ${err.message}`)))

    proc.on('close', code => {
      registry.process = null
      if (registry.canceled) {
        reject(new ExtractionError('Download canceled by user'))
        return
      }
      if (code === 0) resolve()
      else {
        const msg = stderrBuf.split('\n').filter(Boolean).pop() ?? `yt-dlp exited with code ${code}`
        reject(new ExtractionError(msg.replace(/^ERROR:\s*/i, '')))
      }
    })
  })
}

// ---- Main download routine with strategy rotation ---------------------------

function buildAttemptOrder(clients: string[]): string[] {
  const preferred = ['tv', 'web_safari', 'mweb', 'web', 'ios', 'android']
  const ordered = clients.filter(c => preferred.includes(c))
  const rest = clients.filter(c => !preferred.includes(c))
  return [...(ordered.length ? ordered : preferred), ...rest]
}

function summarizeError(err: string): string {
  const e = err.slice(0, 400)
  if (detectBotCheck(e))
    return 'YouTube requires verification for this server. Fix: add YouTube cookies in Settings (or a working proxy), then press Retry.'
  return e
}

export async function startDownload(jobId: string): Promise<void> {
  const job = await db.download.findUnique({ where: { id: jobId } })
  if (!job) return

  const settings = await getSettings()
  if (settings.usePoToken) {
    const { ensurePotServer } = await import('@/lib/pot')
    await ensurePotServer().catch(() => false)
  }
  const proxies = healthyProxies(settings.proxies)
  const clients = buildAttemptOrder(settings.clientOrder?.length ? settings.clientOrder : [])
  const maxRounds = Math.max(1, Math.min(settings.maxRetries ?? 3, 6))

  const outDir = path.join(DOWNLOAD_DIR, jobId)
  mkdirSync(outDir, { recursive: true })

  const select: SelectOptions = {
    mode: job.mode === 'audio' ? 'audio' : 'video',
    quality: job.quality,
    codec: job.codec,
    container: job.container,
  }

  const registry: ActiveJob = { process: null, canceled: false }
  activeJobs.set(jobId, registry)

  const proxyOrder = ['', ...proxies.map(p => p.url)]

  await db.download.update({
    where: { id: jobId },
    data: { status: 'downloading', stage: 'extract', attempts: job.attempts + 1, error: null },
  })

  let lastError = 'Download failed'

  try {
    for (let round = 0; round < maxRounds; round++) {
      for (const client of clients) {
        if (registry.canceled) {
          await db.download
            .update({ where: { id: jobId }, data: { status: 'canceled', stage: 'canceled' } })
            .catch(() => {})
          return
        }
        const proxy = proxyOrder[round % proxyOrder.length]
        const strategy = `${client}${proxy ? ' via proxy' : ' direct'}`

        try {
          await runSingleAttempt(job.id, job.url, outDir, select, {
            client,
            proxy: proxy || undefined,
            cookies: settings.cookies,
            usePoToken: settings.usePoToken,
            concurrentFragments: settings.concurrentFragments,
          }, registry)

          const found = findFinalFile(outDir)
          if (!found) throw new ExtractionError('Download finished but output file was not found')

          await db.download.update({
            where: { id: jobId },
            data: {
              status: 'completed',
              stage: 'done',
              progress: 100,
              speed: null,
              eta: null,
              filename: found.filename,
              filepath: found.filepath,
              filesize: found.size,
              directUrl: `/api/file/${jobId}`,
              strategy,
              error: null,
            },
          })
          if (proxy) await markProxyResult(proxy, true)
          return
        } catch (e) {
          const err = (e as Error).message || String(e)
          if (registry.canceled) {
            await db.download
              .update({ where: { id: jobId }, data: { status: 'canceled', stage: 'canceled' } })
              .catch(() => {})
            return
          }
          lastError = err
          if (proxy) await markProxyResult(proxy, !detectBotCheck(err))
          await db.download
            .update({ where: { id: jobId }, data: { error: `${strategy}: ${err.slice(0, 500)}` } })
            .catch(() => {})
          await sleep(Math.min(1500 * 2 ** round, 12000))
        }
      }
    }

    await db.download.update({
      where: { id: jobId },
      data: { status: 'failed', stage: 'failed', error: summarizeError(lastError) },
    })
  } finally {
    activeJobs.delete(jobId)
  }
}

export function cancelDownload(jobId: string): boolean {
  const reg = activeJobs.get(jobId)
  if (reg) {
    reg.canceled = true
    try {
      reg.process?.kill('SIGKILL')
    } catch {
      /* ignore */
    }
    activeJobs.delete(jobId)
    return true
  }
  return false
}

export function isJobActive(jobId: string): boolean {
  return activeJobs.has(jobId)
}

// ---- Recovery on server boot ------------------------------------------------

const globalForRecovery = globalThis as unknown as { recovered: boolean | undefined }
export async function recoverInterruptedJobs(): Promise<void> {
  if (globalForRecovery.recovered) return
  globalForRecovery.recovered = true
  try {
    const stuck = await db.download.findMany({
      where: { status: { in: ['downloading', 'processing'] } },
    })
    for (const job of stuck) {
      if (!activeJobs.has(job.id)) {
        await db.download.update({
          where: { id: job.id },
          data: {
            status: 'failed',
            stage: 'failed',
            error: 'Interrupted by server restart. Press Retry to resume (partial files are kept).',
          },
        })
      }
    }
  } catch {
    /* ignore */
  }
}
