/**
 * yt-dlp engine core: tool discovery, hardened execution, extraction with
 * anti-bot layers, the shared info store and the public (UI-facing) format
 * model used by the whole app.
 *
 * Anti-bot layers (in order):
 *   1. egress lane manager (proxy.ts) — Cloudflare WARP consumer tunnel first
 *   2. player-client rotation (CLIENT_CHAIN)
 *   3. visitor_data injection (minted through the tunnel, cached, rotated)
 *   4. bgutil PO-token provider (pot.ts supervised deno server)
 *   5. remote JS-challenge components (deno) — solves the n-transform
 *   6. user cookies.txt (Settings) — permanent fix for hard-flagged IPs
 *   7. community proxy APIs (providers.ts) — Piped/Invidious fleet fallback
 */
import { spawn, execFile } from 'child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import path from 'path'
import os from 'os'
import { randomUUID } from 'crypto'
import { ytDlpProxy } from './proxy'

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

const PROJECT_ROOT = '/home/z/my-project'

const YT_DLP_CANDIDATES = [
  path.join(PROJECT_ROOT, 'tools/venv/bin/yt-dlp'), // project-local (survives home resets)
  '/home/z/.venv/bin/yt-dlp',
  '/usr/local/bin/yt-dlp',
  '/usr/bin/yt-dlp',
  path.join(os.homedir(), '.venv/bin/yt-dlp'),
  path.join(os.homedir(), '.local/bin/yt-dlp'),
]

const FFMPEG_CANDIDATES = ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/home/linuxbrew/.linuxbrew/bin/ffmpeg']

const DENO_CANDIDATES = [
  path.join(PROJECT_ROOT, 'tools/deno/bin/deno'), // project-local (survives home resets)
  '/home/z/.deno/bin/deno',
  path.join(os.homedir(), '.deno/bin/deno'),
  '/usr/local/bin/deno',
]

let ytDlpPath: string | null = null
let ffmpegPath: string | null = null
let denoPath: string | null = null
let ffmpegPresent: boolean | null = null

// re-resolve if the cached binary vanished (e.g. sandbox home resets)
export function getYtDlpPath(): string {
  if (!ytDlpPath || !existsSync(ytDlpPath)) ytDlpPath = firstExisting(YT_DLP_CANDIDATES) ?? 'yt-dlp'
  return ytDlpPath
}

export function getFfmpegPath(): string {
  if (!ffmpegPath || !existsSync(ffmpegPath)) ffmpegPath = firstExisting(FFMPEG_CANDIDATES) ?? 'ffmpeg'
  return ffmpegPath
}

export function hasFfmpeg(): boolean {
  if (ffmpegPresent === null || !existsSync(getFfmpegPath())) {
    ffmpegPresent = Boolean(firstExisting(FFMPEG_CANDIDATES))
  }
  return ffmpegPresent
}

export function getDenoPath(): string {
  if (!denoPath || !existsSync(denoPath)) denoPath = firstExisting(DENO_CANDIDATES) ?? 'deno'
  return denoPath
}

export const POT_SERVER_URL = 'http://127.0.0.1:4416'

/** Spawn env that ALWAYS exposes the project-local deno + venv binaries —
 *  yt-dlp 2026+ needs a JS runtime (EJS) and refuses to work without one. */
export function toolEnv(): NodeJS.ProcessEnv {
  const denoDir = path.dirname(path.dirname(getDenoPath())) // …/tools/deno
  const venvDir = path.dirname(path.dirname(getYtDlpPath())) // …/tools/venv
  const extra = [path.join(denoDir, 'bin'), path.join(venvDir, 'bin')]
  return {
    ...process.env,
    PATH: `${extra.join(':')}:${process.env.PATH ?? ''}`,
    SSL_CERT_FILE: process.env.SSL_CERT_FILE ?? '/etc/ssl/certs/ca-certificates.crt',
  }
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
      { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env: toolEnv() },
      (err, stdout, stderr) => {
        if (err && typeof (err as NodeJS.ErrnoException).code === 'undefined' && !stdout && !stderr) {
          return reject(err)
        }
        resolve({ code: err ? 1 : 0, stdout: stdout ?? '', stderr: stderr ?? '' })
      }
    )
  })
}

// ---- Errors ----------------------------------------------------------------

export type DlErrorCode =
  | 'INVALID_URL'
  | 'PRIVATE'
  | 'UNAVAILABLE'
  | 'AGE_RESTRICTED'
  | 'LIVE'
  | 'NO_FORMATS'
  | 'UNSUPPORTED_URL'
  | 'BOT_CHECK'
  | 'RATE_LIMITED'
  | 'GEO_BLOCKED'
  | 'TIMEOUT'
  | 'FETCH_FAILED'
  | 'EXPIRED'
  | 'NOT_FOUND'
  | 'NO_FFMPEG'
  | 'INTERNAL'

export class DlError extends Error {
  code: DlErrorCode
  hint?: string
  constructor(code: DlErrorCode, message: string, hint?: string) {
    super(message)
    this.code = code
    this.hint = hint
  }
}

/** Terminal video states — no point rotating clients or trying providers. */
export const TERMINAL_CODES: ReadonlySet<DlErrorCode> = new Set([
  'PRIVATE',
  'UNAVAILABLE',
  'AGE_RESTRICTED',
  'LIVE',
  'UNSUPPORTED_URL',
  'GEO_BLOCKED',
  'INVALID_URL',
])

interface Classified {
  code: DlErrorCode
  message: string
  hint?: string
}

const RULES: Array<{ code: DlErrorCode; re: RegExp; message: string; hint?: string }> = [
  {
    code: 'BOT_CHECK',
    re: /sign in to confirm|not a bot|page needs to be reloaded|login required/i,
    message: 'YouTube demanded a bot-check for this egress.',
  },
  {
    code: 'RATE_LIMITED',
    re: /HTTP Error 429|Too Many Requests|429:/i,
    message: 'YouTube is rate-limiting this route.',
  },
  { code: 'PRIVATE', re: /private video|members-only|join this channel/i, message: 'This video is private.' },
  {
    code: 'UNAVAILABLE',
    re: /video unavailable|removed by the uploader|no longer available/i,
    message: 'This video is unavailable or was removed.',
  },
  {
    code: 'AGE_RESTRICTED',
    re: /confirm your age|age.restricted|inappropriate for some users/i,
    message: 'Age-restricted video — cookies required.',
  },
  {
    code: 'GEO_BLOCKED',
    re: /not available in your country|geo.?restrict|blocked it in your country/i,
    message: 'This video is blocked for the server region.',
  },
  { code: 'LIVE', re: /live event will begin|is live|premieres in/i, message: 'Live streams cannot be downloaded.' },
  { code: 'UNSUPPORTED_URL', re: /unsupported url|no video formats found/i, message: 'This URL is not supported.' },
  { code: 'TIMEOUT', re: /timed out|ETIMEDOUT|timeout/i, message: 'The request timed out.' },
  {
    code: 'NO_FORMATS',
    re: /requested format is not available|only images are available/i,
    message: 'No downloadable formats found.',
  },
]

export function classifyStderr(stderr: string): Classified {
  for (const r of RULES) {
    if (r.re.test(stderr)) return { code: r.code, message: r.message, hint: r.hint }
  }
  return { code: 'FETCH_FAILED', message: 'Extraction failed.' }
}

export function detectBotCheck(stderr: string): boolean {
  return /sign in to confirm|not a bot|page needs to be reloaded|HTTP Error 429|Too Many Requests/i.test(stderr)
}

// ---- Raw model (yt-dlp JSON / provider adapters share this shape) ----------

export interface YtRawFormat {
  format_id: string
  ext?: string
  url?: string
  vcodec?: string
  acodec?: string
  height?: number
  width?: number
  fps?: number
  tbr?: number
  abr?: number
  asr?: number
  filesize?: number
  filesize_approx?: number
  protocol?: string
  format_note?: string
  dynamic_range?: string
  container?: string
}

export interface RawInfo {
  id: string
  title: string
  uploader?: string
  channel?: string
  duration?: number
  view_count?: number
  thumbnail?: string
  webpage_url: string
  is_live?: boolean
  live_status?: string
  extractor_key?: string
  formats: YtRawFormat[]
}

// ---- Public model (UI-facing) ----------------------------------------------

export interface PublicFormat {
  id: string // format id, or composite "videoId|audioId|container" for merges
  kind: 'video' | 'audio'
  quality: string
  container: string
  vcodec?: string
  acodec?: string
  fps?: number
  filesize?: number
  approx?: boolean
  hasAudio?: boolean
  instant: boolean
  needsMerge: boolean
  hdr?: boolean
  recommended?: boolean
}

export interface PublicInfo {
  infoId: string
  title: string
  author: string
  views: number
  duration: number
  thumbnail: string
  webpageUrl: string
  source: string // "youtube" | "other" | provider label
  videoFormats: PublicFormat[]
  audioFormats: PublicFormat[]
  mp3Options: number[]
}

// ---- Info store ------------------------------------------------------------

interface StoreEntry {
  raw: RawInfo
  at: number
}

declare global {
  var __tgInfoStore: Map<string, StoreEntry> | undefined
}

function infoStore(): Map<string, StoreEntry> {
  if (!globalThis.__tgInfoStore) globalThis.__tgInfoStore = new Map()
  return globalThis.__tgInfoStore
}

const INFO_TTL_MS = 6 * 60 * 60 * 1000
const INFO_MAX = 60

function pruneStore(): void {
  const store = infoStore()
  const now = Date.now()
  for (const [k, v] of store) {
    if (now - v.at > INFO_TTL_MS) store.delete(k)
  }
  while (store.size > INFO_MAX) {
    const oldest = [...store.entries()].sort((a, b) => a[1].at - b[1].at)[0]
    if (!oldest) break
    store.delete(oldest[0])
  }
}

export function putInfo(raw: RawInfo): string {
  const id = randomUUID()
  const store = infoStore()
  store.set(id, { raw, at: Date.now() })
  pruneStore()
  return id
}

export function getInfo(infoId: string): StoreEntry | null {
  const e = infoStore().get(infoId)
  if (!e) return null
  if (Date.now() - e.at > INFO_TTL_MS) {
    infoStore().delete(infoId)
    return null
  }
  return e
}

// ---- Cookies ---------------------------------------------------------------

export async function writeCookiesFile(cookies: string): Promise<string | null> {
  if (!cookies || !cookies.trim()) return null
  const dir = '/tmp/ytdl-cookies'
  try {
    mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `cookies-${process.pid}.txt`)
    writeFileSync(file, cookies, { mode: 0o600 })
    return file
  } catch {
    return null
  }
}

// ---- Visitor data ----------------------------------------------------------

const DATA_DIR = path.join(PROJECT_ROOT, 'data')
const VISITOR_FILE = path.join(DATA_DIR, 'visitor_data.txt')

declare global {
  var __tgVisitorData: string | null | undefined
  var __tgVisitorAt: number | undefined
}

const VISITOR_TTL_MS = 4 * 60 * 60 * 1000

function cachedVisitorData(): string | null {
  if (globalThis.__tgVisitorData && Date.now() - (globalThis.__tgVisitorAt ?? 0) < VISITOR_TTL_MS) {
    return globalThis.__tgVisitorData
  }
  try {
    if (existsSync(VISITOR_FILE)) {
      const v = readFileSync(VISITOR_FILE, 'utf8').trim()
      if (v) {
        globalThis.__tgVisitorData = v
        globalThis.__tgVisitorAt = Date.now()
        return v
      }
    }
  } catch {
    /* ignore */
  }
  return null
}

function persistVisitorData(v: string): void {
  globalThis.__tgVisitorData = v
  globalThis.__tgVisitorAt = Date.now()
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    writeFileSync(VISITOR_FILE, v, 'utf8')
  } catch {
    /* ignore */
  }
}

/** Mint a fresh visitor_data through the ACTIVE egress lane. */
async function mintVisitorData(): Promise<string | null> {
  try {
    const { proxiedFetch } = await import('./proxy')
    const res = await proxiedFetch('https://www.youtube.com/', {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    })
    const html = await res.text()
    const m =
      html.match(/"visitorData":"((?:[^"\\]|\\.)*)"/) ||
      html.match(/"VISITOR_DATA":"((?:[^"\\]|\\.)*)"/)
    if (!m) return null
    const v = JSON.parse(`"${m[1]}"`) as string
    return v || null
  } catch {
    return null
  }
}

async function ensureVisitorData(): Promise<string | null> {
  const cached = cachedVisitorData()
  if (cached) return cached
  const minted = await mintVisitorData()
  if (minted) persistVisitorData(minted)
  return minted ?? null
}

// ---- Player-client chain ---------------------------------------------------

const CLIENT_ORDER = ['mweb', 'tv', 'web_safari', 'web', 'ios']

/** Rotation steps; [0] is used by server-side jobs (jobs.ts) so it must always
 *  carry the freshest visitor_data. Mutated in place by refreshClientChain. */
export const CLIENT_CHAIN: string[][] = CLIENT_ORDER.map((c) => [
  '--extractor-args',
  `youtube:player_client=${c}`,
])

export function refreshClientChain(visitorData: string | null): void {
  for (let i = 0; i < CLIENT_ORDER.length; i++) {
    const val = visitorData
      ? `youtube:player_client=${CLIENT_ORDER[i]};visitor_data=${visitorData}`
      : `youtube:player_client=${CLIENT_ORDER[i]}`
    CLIENT_CHAIN[i] = ['--extractor-args', val]
  }
}

// ---- Base args -------------------------------------------------------------

/** Hardened base args shared by every spawn (analysis, jobs, URL resolving). */
export function baseArgs(): string[] {
  const args = [
    '--socket-timeout', '20',
    '--retries', '15',
    '--fragment-retries', '15',
    '--extractor-retries', '2',
    '--force-ipv4',
    '--no-check-certificates',
    '--no-playlist',
    // deno-solved JS challenges (n-transform) — without this YouTube omits
    // every media format and returns "only images are available"
    '--remote-components', 'ejs:github',
    '--extractor-args', `youtubepot-bgutilhttp:base_url=${POT_SERVER_URL}`,
  ]
  const proxy = ytDlpProxy()
  if (proxy) args.push('--proxy', proxy)
  return args
}

/** Engine descriptor for server-side jobs. */
export function getEngine(): { cmd: string; baseArgs: string[] } {
  return { cmd: getYtDlpPath(), baseArgs: baseArgs() }
}

// ---- Extraction ------------------------------------------------------------

function isYouTubeUrl(url: string): boolean {
  return /^(https?:\/\/)?(www\.|m\.|music\.)?(youtube\.com|youtu\.be|youtube-nocookie\.com)\//i.test(url.trim())
}

export function isValidYouTubeUrl(url: string): boolean {
  return isYouTubeUrl(url)
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

async function parseRaw(stdout: string, url: string): Promise<RawInfo> {
  const data = JSON.parse(stdout) as Record<string, unknown>
  const formats = ((data.formats as YtRawFormat[]) ?? []).filter((f) => {
    if (!f.format_id) return false
    if ((f.ext ?? '') === 'mhtml') return false
    if (/storyboard/i.test(f.format_note ?? '')) return false
    return true
  })
  return {
    id: String(data.id ?? extractVideoId(url) ?? ''),
    title: String(data.title ?? 'Untitled'),
    uploader: (data.uploader as string) || (data.channel as string) || undefined,
    channel: (data.channel as string) || undefined,
    duration: (data.duration as number) || undefined,
    view_count: (data.view_count as number) || undefined,
    thumbnail: (data.thumbnail as string) || undefined,
    webpage_url: String(data.webpage_url ?? url),
    is_live: Boolean(data.is_live),
    live_status: (data.live_status as string) || undefined,
    extractor_key: String(data.extractor_key ?? data.extractor ?? 'Generic'),
    formats,
  }
}

/**
 * Full extraction through the current engine stack.
 * Throws DlError with a classified code; extract.ts decides the fallback.
 */
export async function fetchInfo(url: string): Promise<{ infoId: string; raw: RawInfo }> {
  const clean = url.trim()
  if (!/^https?:\/\//i.test(clean)) {
    throw new DlError('INVALID_URL', 'That does not look like a valid video URL.')
  }

  const { ensurePotServer } = await import('./pot')
  void ensurePotServer().catch(() => undefined)

  const cookies = await loadCookiesText()

  if (!isYouTubeUrl(clean)) {
    const { code, stdout, stderr } = await runYtDlp(
      ['-J', ...baseArgs(), ...(cookies ? ['--cookies', cookies] : []), clean],
      150000,
    )
    if (code !== 0 || !stdout.trim().startsWith('{')) {
      const c = classifyStderr(stderr)
      throw new DlError(c.code, c.message, c.hint)
    }
    const raw = await parseRaw(stdout, clean)
    if (raw.is_live) throw new DlError('LIVE', 'Live streams cannot be downloaded.')
    if (raw.formats.length === 0) throw new DlError('NO_FORMATS', 'No downloadable formats found.')
    const infoId = putInfo(raw)
    return { infoId, raw }
  }

  let visitor = await ensureVisitorData()
  refreshClientChain(visitor)
  let rotatedVisitor = false
  const errors: Classified[] = []
  const MAX_STEPS = 4

  for (let i = 0; i < Math.min(MAX_STEPS, CLIENT_CHAIN.length); i++) {
    const step = CLIENT_CHAIN[i]
    const { code, stdout, stderr } = await runYtDlp(
      ['-J', ...baseArgs(), ...step, ...(cookies ? ['--cookies', cookies] : []), clean],
      90000,
    )
    if (code === 0 && stdout.trim().startsWith('{')) {
      const raw = await parseRaw(stdout, clean)
      if (raw.is_live) throw new DlError('LIVE', 'Live streams cannot be downloaded.')
      if (raw.formats.length > 0) {
        const infoId = putInfo(raw)
        return { infoId, raw }
      }
      errors.push({ code: 'NO_FORMATS', message: 'Player returned no media formats.' })
      continue
    }
    const c = classifyStderr(stderr || 'empty output')
    if (TERMINAL_CODES.has(c.code)) throw new DlError(c.code, c.message, c.hint)
    errors.push(c)
    // bot wall → rotate visitor identity exactly once and keep rotating clients
    if ((c.code === 'BOT_CHECK' || c.code === 'RATE_LIMITED') && !rotatedVisitor) {
      rotatedVisitor = true
      const minted = await mintVisitorData()
      if (minted && minted !== visitor) {
        visitor = minted
        persistVisitorData(minted)
        refreshClientChain(visitor)
      }
    }
  }

  const worst = errors.find((e) => e.code === 'BOT_CHECK') ?? errors[0] ?? { code: 'FETCH_FAILED' as const, message: 'Extraction failed.' }
  throw new DlError(worst.code, worst.message, worst.hint)
}

async function loadCookiesText(): Promise<string | null> {
  try {
    const { getSettings } = await import('./settings')
    const s = await getSettings()
    return s.cookies && s.cookies.trim() ? s.cookies : null
  } catch {
    return null
  }
}

/** Resolve a FRESH direct media URL for a format selector (IDM re-mints). */
export async function resolveFormatUrl(webpageUrl: string, selector: string): Promise<string | null> {
  try {
    const cookies = await loadCookiesText()
    const { code, stdout } = await runYtDlp(
      [
        ...baseArgs(),
        ...(cookies ? ['--cookies', cookies] : []),
        ...CLIENT_CHAIN[0],
        '-f',
        selector,
        '--get-url',
        webpageUrl,
      ],
      90000,
    )
    if (code !== 0) return null
    const line = stdout
      .split('\n')
      .map((l) => l.trim())
      .find((l) => /^https?:\/\//.test(l))
    return line ?? null
  } catch {
    return null
  }
}

// ---- Public model mapping --------------------------------------------------

function codecLabel(c?: string): string | undefined {
  if (!c || c === 'none') return undefined
  const s = c.toLowerCase()
  if (s.startsWith('avc1') || s.startsWith('avc3') || s.includes('h264') || s.includes('h.264')) return 'H.264'
  if (s.startsWith('vp9') || s.includes('vp09')) return 'VP9'
  if (s.startsWith('vp8')) return 'VP8'
  if (s.startsWith('av01')) return 'AV1'
  if (s.startsWith('mp4a') || s.includes('aac')) return 'AAC'
  if (s.includes('opus')) return 'Opus'
  if (s.includes('vorbis')) return 'Vorbis'
  if (s.includes('ec-3') || s.includes('eac3')) return 'E-AC3'
  if (s.includes('ac-3')) return 'AC3'
  return c.split('.')[0].toUpperCase()
}

function fmtSize(f: YtRawFormat): number | undefined {
  return f.filesize || f.filesize_approx || undefined
}

function videoQuality(f: YtRawFormat): string {
  const h = f.height
  if (!h) return f.format_note || f.format_id
  const fps = f.fps && f.fps > 30 ? f.fps : 0
  return `${h}p${fps || ''}`
}

function audioQuality(f: YtRawFormat): string {
  const k = Math.round(f.abr || f.tbr || 0)
  return k > 0 ? `${k}k` : f.format_note || f.format_id
}

function isStreamable(f: YtRawFormat): boolean {
  const proto = (f.protocol ?? '').toLowerCase()
  return proto === 'https' || proto === 'http' || proto === ''
}

function pickAudio(formats: YtRawFormat[], container: string): YtRawFormat | null {
  const audios = formats.filter((f) => f.vcodec === 'none' && f.acodec && f.acodec !== 'none')
  if (audios.length === 0) return null
  const family = /webm|mkv/.test(container) ? ['opus', 'vorbis'] : ['mp4a', 'aac']
  const scored = audios
    .map((f) => {
      const s = (f.acodec ?? '').toLowerCase()
      const fam = family.some((x) => s.includes(x)) ? 1 : 0
      return { f, score: fam * 1000 + (f.abr ?? f.tbr ?? 0) }
    })
    .sort((a, b) => b.score - a.score)
  return scored[0].f
}

export function toPublicInfo(infoId: string, raw: RawInfo): PublicInfo {
  const isYT = /youtube/i.test(raw.extractor_key ?? '') || isYouTubeUrl(raw.webpage_url)
  const source = /:piped/i.test(raw.extractor_key ?? '')
    ? 'Piped'
    : /:invidious/i.test(raw.extractor_key ?? '')
      ? 'Invidious'
      : isYT
        ? 'youtube'
        : 'other'

  const thumbProxy = (u?: string): string => {
    if (!u || !/^https?:\/\//.test(u)) return ''
    return `/api/thumb?url=${encodeURIComponent(u)}`
  }

  const instant: PublicFormat[] = []
  const videoOnly: Array<{ f: YtRawFormat; fmt: PublicFormat }> = []
  const audio: PublicFormat[] = []

  for (const f of raw.formats) {
    const hasV = f.vcodec && f.vcodec !== 'none'
    const hasA = f.acodec && f.acodec !== 'none'
    const ext = (f.ext ?? 'mp4').toLowerCase()
    const size = fmtSize(f)

    if (hasV && hasA) {
      // muxed — instant single-stream
      if (!isStreamable(f)) continue
      instant.push({
        id: f.format_id,
        kind: 'video',
        quality: videoQuality(f),
        container: ext === 'webm' ? 'webm' : 'mp4',
        vcodec: codecLabel(f.vcodec),
        acodec: codecLabel(f.acodec),
        fps: f.fps,
        filesize: size,
        approx: !f.filesize,
        hasAudio: true,
        instant: true,
        needsMerge: false,
        hdr: /hdr/i.test(f.dynamic_range ?? ''),
        recommended: true,
      })
    } else if (hasV) {
      const container = ext === 'webm' ? 'webm' : 'mp4'
      const fmt: PublicFormat = {
        id: f.format_id, // replaced by composite below
        kind: 'video',
        quality: videoQuality(f),
        container,
        vcodec: codecLabel(f.vcodec),
        fps: f.fps,
        filesize: size,
        approx: !f.filesize,
        hasAudio: false,
        instant: false,
        needsMerge: true,
        hdr: /hdr/i.test(f.dynamic_range ?? ''),
      }
      videoOnly.push({ f, fmt })
    } else if (hasA) {
      if (!isStreamable(f)) continue
      audio.push({
        id: f.format_id,
        kind: 'audio',
        quality: audioQuality(f),
        container: ext === 'webm' ? 'webm' : ext === 'm4a' ? 'm4a' : ext,
        acodec: codecLabel(f.acodec),
        filesize: size,
        approx: !f.filesize,
        hasAudio: true,
        instant: true,
        needsMerge: false,
      })
    }
  }

  // composite merges: pair each video-only track with its best audio partner
  const composites: PublicFormat[] = videoOnly.map(({ f, fmt }) => {
    const a = pickAudio(raw.formats, fmt.container)
    const id = a ? `${f.format_id}|${a.format_id}|${fmt.container}` : f.format_id
    const total = (fmt.filesize ?? 0) + (a ? fmtSize(a) ?? 0 : 0)
    return {
      ...fmt,
      id,
      filesize: total > 0 ? total : fmt.filesize,
      approx: !f.filesize || !a?.filesize,
    }
  })

  const rankVideo = (f: PublicFormat): number => {
    const h = parseInt(f.quality, 10) || 0
    return h * 100 + (f.fps ?? 0) * 2 + (f.container === 'mp4' ? 1 : 0)
  }
  instant.sort((a, b) => rankVideo(b) - rankVideo(a))
  composites.sort((a, b) => rankVideo(b) - rankVideo(a))
  audio.sort((a, b) => (parseInt(b.quality, 10) || 0) - (parseInt(a.quality, 10) || 0))

  return {
    infoId,
    title: raw.title,
    author: raw.uploader || raw.channel || '',
    views: raw.view_count ?? 0,
    duration: raw.duration ?? 0,
    thumbnail: thumbProxy(raw.thumbnail),
    webpageUrl: raw.webpage_url,
    source,
    videoFormats: [...composites, ...instant],
    audioFormats: audio,
    mp3Options: hasFfmpeg() ? [320, 192, 128] : [],
  }
}
