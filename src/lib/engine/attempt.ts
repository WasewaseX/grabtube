// ---- Bypass args (legacy pipeline shim) ------------------------------------
//
// The stress pipeline composes the anti-bot layer from the live ytdlp exports:
// player client, cookies file, per-attempt proxy and the PO-token provider.

import { spawn } from 'child_process'
import { readdirSync, statSync } from 'fs'
import path from 'path'
import { CLIENT_CHAIN, POT_SERVER_URL, getFfmpegPath, getYtDlpPath, writeCookiesFile } from '@/lib/ytdlp'
import { buildFormatString, buildOutputArgs, SelectOptions } from './format'
import { parseProgressLine, throttledJobUpdate } from './progress'
import type { ActiveJob } from './registry'

export class ExtractionError extends Error {}

interface BypassOptions {
  client: string
  cookies?: string
  proxy?: string
  usePoToken?: boolean
}

export interface AttemptOpts {
  client: string
  proxy?: string
  cookies?: string
  usePoToken?: boolean
  concurrentFragments?: number
}

function clientBypassArgs(client: string): string[] {
  // reuse the live rotation step for this client when one exists — it carries
  // the freshest visitor_data minted through the tunnel
  const step = CLIENT_CHAIN.find((s) => {
    if (s.length !== 2 || s[0] !== '--extractor-args') return false
    return /player_client=([^;]+)/.exec(s[1])?.[1] === client
  })
  if (step) return step
  if (!client || client === 'default') return []
  return ['--extractor-args', `youtube:player_client=${client}`]
}

async function buildBypassArgs(opts: BypassOptions): Promise<string[]> {
  const args: string[] = []
  if (opts.client) args.push(...clientBypassArgs(opts.client))
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
  // network hardening (same hardening the removed core helper applied)
  args.push(
    '--socket-timeout', '30',
    '--retries', '20',
    '--fragment-retries', '20',
    '--retry-sleep', 'linear=1:5',
    '--force-ipv4',
    '--no-check-certificates',
    '--extractor-retries', '3',
  )
  return args
}

export function findFinalFile(dir: string): { filename: string; filepath: string; size: number } | null {
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

// ---- Single attempt --------------------------------------------------------

export async function runSingleAttempt(
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
