import { spawn, execFile } from 'child_process'
import { existsSync } from 'fs'
import path from 'path'
import os from 'os'

// ---- Tool discovery --------------------------------------------------------

function firstExisting(candidates: string[]): string | null {
  for (const c of candidates) {
    try {
      if (existsSync(c)) return c
    } catch {
      /* ignore */
    }
  }
  return null
}

const YT_DLP_CANDIDATES = [
  '/home/z/.venv/bin/yt-dlp',
  '/usr/local/bin/yt-dlp',
  '/usr/bin/yt-dlp',
  path.join(os.homedir(), '.venv/bin/yt-dlp'),
  path.join(os.homedir(), '.local/bin/yt-dlp'),
]

const FFMPEG_CANDIDATES = ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/home/linuxbrew/.linuxbrew/bin/ffmpeg']

const DENO_CANDIDATES = ['/home/z/.deno/bin/deno', path.join(os.homedir(), '.deno/bin/deno'), '/usr/local/bin/deno']

let ytDlpPath: string | null = null
let ffmpegPath: string | null = null
let denoPath: string | null = null

export function getYtDlpPath(): string {
  if (!ytDlpPath) ytDlpPath = firstExisting(YT_DLP_CANDIDATES) ?? 'yt-dlp'
  return ytDlpPath
}

export function getFfmpegPath(): string {
  if (!ffmpegPath) ffmpegPath = firstExisting(FFMPEG_CANDIDATES) ?? 'ffmpeg'
  return ffmpegPath
}

export function getDenoPath(): string {
  if (!denoPath) denoPath = firstExisting(DENO_CANDIDATES) ?? 'deno'
  return denoPath
}

export const POT_SERVER_URL = 'http://127.0.0.1:4416'

// ---- Types -----------------------------------------------------------------

export interface YtFormat {
  formatId: string
  ext: string
  height?: number
  width?: number
  fps?: number
  vcodec?: string
  acodec?: string
  abr?: number
  tbr?: number
  filesize?: number
  filesizeApprox?: number
  formatNote?: string
  dynamicRange?: string
}

export interface VideoInfo {
  id: string
  title: string
  thumbnail?: string
  duration?: number
  channel?: string
  uploader?: string
  viewCount?: number
  uploadDate?: string
  description?: string
  isLive?: boolean
  formats: YtFormat[]
}

// ---- Command execution -----------------------------------------------------

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

export function runYtDlp(args: string[], timeoutMs = 120000): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(
      getYtDlpPath(),
      args,
      { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err && typeof (err as NodeJS.ErrnoException).code === 'undefined' && !stdout && !stderr) {
          return reject(err)
        }
        const code = err ? ((err as NodeJS.ErrnoException).code === 0 ? 0 : 1) : 0
        resolve({ code: err ? 1 : 0, stdout: stdout ?? '', stderr: stderr ?? '' })
      }
    )
  })
}

// ---- Bypass layers ---------------------------------------------------------

export async function writeCookiesFile(cookies: string): Promise<string | null> {
  if (!cookies || !cookies.trim()) return null
  const dir = '/tmp/ytdl-cookies'
  try {
    const { mkdirSync, writeFileSync } = await import('fs')
    mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `cookies-${process.pid}.txt`)
    writeFileSync(file, cookies, { mode: 0o600 })
    return file
  } catch {
    return null
  }
}

export interface BypassOptions {
  cookies?: string
  proxy?: string
  client?: string
  usePoToken?: boolean
  extraArgs?: string[]
}

/**
 * Build the yt-dlp argument prefix implementing our multi-layer anti-bot defense:
 *  1. player client selection
 *  2. cookies (user provided, stored server side)
 *  3. proxy (rotating residential/datacenter list)
 *  4. PO token provider (bgutil deno server)
 *  5. network hardening (timeouts, retries, ipv4)
 */
export async function buildBypassArgs(opts: BypassOptions): Promise<string[]> {
  const args: string[] = []
  if (opts.client) {
    args.push('--extractor-args', `youtube:player_client=${opts.client}`)
  }
  if (opts.cookies) {
    const cookieFile = await writeCookiesFile(opts.cookies)
    if (cookieFile) args.push('--cookies', cookieFile)
  }
  if (opts.proxy) {
    args.push('--proxy', opts.proxy)
  }
  if (opts.usePoToken !== false) {
    args.push('--extractor-args', `youtubepot-bgutilhttp:base_url=${POT_SERVER_URL}`)
  }
  // network hardening
  args.push(
    '--socket-timeout', '30',
    '--retries', '20',
    '--fragment-retries', '20',
    '--retry-sleep', 'linear=1:5',
    '--force-ipv4',
    '--no-check-certificates',
    '--extractor-retries', '3',
  )
  if (opts.extraArgs) args.push(...opts.extraArgs)
  return args
}

// ---- Analyze ---------------------------------------------------------------

export class ExtractionError extends Error {
  isBotCheck: boolean
  constructor(message: string, isBotCheck = false) {
    super(message)
    this.isBotCheck = isBotCheck
  }
}

const BOT_CHECK_PATTERNS = [
  /sign in to confirm/i,
  /not a bot/i,
  /login required/i,
  /HTTP Error 429/i,
  /Too Many Requests/i,
  /age.*confirm/i,
]

export function detectBotCheck(stderr: string): boolean {
  return BOT_CHECK_PATTERNS.some(p => p.test(stderr))
}

function parseInfoJson(json: string): VideoInfo {
  const data = JSON.parse(json)
  const formats: YtFormat[] = (data.formats ?? [])
    .filter((f: Record<string, unknown>) => {
      const vcodec = f.vcodec as string | undefined
      const acodec = f.acodec as string | undefined
      const protocol = f.protocol as string | undefined
      // skip HLS/DASH manifests and storyboards
      if (protocol && (protocol.includes('m3u8') || protocol.includes('dash') || protocol === 'http_dash_segments')) return false
      if (vcodec === 'none' && acodec === 'none') return false
      if ((f.format_note as string | undefined)?.includes('storyboard')) return false
      if ((f.ext as string) === 'mhtml') return false
      return true
    })
    .map((f: Record<string, unknown>) => ({
      formatId: String(f.format_id),
      ext: String(f.ext ?? ''),
      height: f.height as number | undefined,
      width: f.width as number | undefined,
      fps: f.fps as number | undefined,
      vcodec: (f.vcodec as string) || undefined,
      acodec: (f.acodec as string) || undefined,
      abr: f.abr as number | undefined,
      tbr: f.tbr as number | undefined,
      filesize: f.filesize as number | undefined,
      filesizeApprox: f.filesize_approx as number | undefined,
      formatNote: (f.format_note as string) || undefined,
      dynamicRange: (f.dynamic_range as string) || undefined,
    }))
  return {
    id: String(data.id ?? ''),
    title: String(data.title ?? 'Untitled'),
    thumbnail: data.thumbnail ?? undefined,
    duration: data.duration ?? undefined,
    channel: data.channel ?? data.uploader ?? undefined,
    uploader: data.uploader ?? undefined,
    viewCount: data.view_count ?? undefined,
    uploadDate: data.upload_date ?? undefined,
    description: data.description ?? undefined,
    isLive: !!data.is_live,
    formats,
  }
}

export function isValidYouTubeUrl(url: string): boolean {
  const patterns = [
    /^(https?:\/\/)?(www\.|m\.|music\.)?(youtube\.com\/(watch\?[^ ]*v=[\w-]+|shorts\/[\w-]+|embed\/[\w-]+|live\/[\w-]+)|youtu\.be\/[\w-]+)/i,
  ]
  return patterns.some(p => p.test(url.trim()))
}

export function extractVideoId(url: string): string | null {
  const m =
    url.match(/[?&]v=([\w-]{11})/) ||
    url.match(/youtu\.be\/([\w-]{11})/) ||
    url.match(/shorts\/([\w-]{11})/) ||
    url.match(/embed\/([\w-]{11})/) ||
    url.match(/live\/([\w-]{11})/)
  return m ? m[1] : null
}

/**
 * Analyze a URL trying every available strategy in order until one succeeds.
 * Strategies: (proxy x client) matrix from settings + PO tokens.
 */
export async function analyzeUrl(
  url: string,
  settings: { cookies: string; proxies: { url: string }[]; clientOrder: string[]; usePoToken?: boolean }
): Promise<{ info: VideoInfo; strategy: string }> {
  if (settings.usePoToken !== false) {
    const { ensurePotServer } = await import('@/lib/pot')
    await ensurePotServer().catch(() => false)
  }

  const clients = settings.clientOrder?.length ? settings.clientOrder : ['tv', 'web_safari', 'mweb', 'web']
  const proxies = ['', ...(settings.proxies ?? []).map(p => p.url)]
  const errors: string[] = []

  for (const proxy of proxies) {
    for (const client of clients) {
      const strategy = `${client}${proxy ? ` via proxy` : ' direct'}`
      try {
        const args = [
          '-J', '--no-playlist', '--no-warnings', '--flat-playlist',
          ...(await buildBypassArgs({
            cookies: settings.cookies,
            proxy: proxy || undefined,
            client,
            usePoToken: settings.usePoToken,
          })),
          url,
        ]
        const { code, stdout, stderr } = await runYtDlp(args, 150000)
        if (code === 0 && stdout.trim().startsWith('{')) {
          return { info: parseInfoJson(stdout), strategy }
        }
        const errText = stderr || 'empty output'
        errors.push(`[${strategy}] ${errText.slice(0, 300)}`)
        // If bot check on this combination, immediately move to next strategy
        if (detectBotCheck(errText)) continue
        // Non-bot errors (e.g. video unavailable) usually apply to all strategies
        if (/video unavailable|private video|removed by the uploader/i.test(errText)) {
          throw new ExtractionError('This video is unavailable (private, removed, or region locked).')
        }
      } catch (e) {
        if (e instanceof ExtractionError) throw e
        errors.push(`[${strategy}] ${(e as Error).message.slice(0, 300)}`)
      }
    }
  }

  const joined = errors.join('\n')
  throw new ExtractionError(
    detectBotCheck(joined)
      ? 'YouTube is requiring verification for this server ("Sign in to confirm you are not a bot"). Add YouTube cookies in Settings to bypass, or configure a working proxy.'
      : `Extraction failed with all strategies.\n${joined.slice(0, 1200)}`,
    detectBotCheck(joined)
  )
}
