import path from 'node:path'

import { ytDlpProxy } from '../proxy'
import { POT_SERVER_URL, PROJECT_ROOT, getYtDlpPath } from './tools'

const POT_SERVER_HOME = path.join(PROJECT_ROOT, 'mini-services/pot-provider/server')

function potArgs(): string[] {
  return [
    // deno-solved JS challenges (n-transform) — without this YouTube omits
    // every media format and returns "only images are available"
    '--remote-components', 'ejs:github',
    '--extractor-args', `youtubepot-bgutilscript:server_home=${POT_SERVER_HOME}`,
    '--extractor-args', `youtubepot-bgutilhttp:base_url=${POT_SERVER_URL}`,
  ]
}

/** Hardened base args shared by every spawn (analysis, jobs, URL resolving). */
export function baseArgs(): string[] {
  const args = [
    '--socket-timeout', '20',
    '--retries', '15',
    '--fragment-retries', '15',
    '--extractor-retries', '3',
    '--force-ipv4',
    '--no-check-certificates',
    '--no-playlist',
    // PO tokens: the script-deno provider needs no HTTP at all, so it works
    // even when the --proxy lane is a SOCKS tunnel (the HTTP provider's
    // localhost /ping blackholes inside yt-dlp's SOCKS networking).
    ...potArgs(),
  ]
  const proxy = ytDlpProxy()
  if (proxy) args.push('--proxy', proxy)
  return args
}

/**
 * Snappy variant for INTERACTIVE info fetches (/api/info): tight timeouts
 * bail a wedged client step quickly so the chain rotates to a healthy one.
 */
export function infoArgs(): string[] {
  return [
    '--socket-timeout', '12',
    '--retries', '3',
    '--fragment-retries', '5',
    '--extractor-retries', '1',
    '--force-ipv4',
    '--no-check-certificates',
    '--no-playlist',
    ...potArgs(),
  ]
}

/** Engine descriptor for server-side jobs. */
export function getEngine(): { cmd: string; baseArgs: string[] } {
  return { cmd: getYtDlpPath(), baseArgs: baseArgs() }
}
