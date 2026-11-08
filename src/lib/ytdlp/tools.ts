import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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

export const PROJECT_ROOT = '/home/z/my-project'

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
