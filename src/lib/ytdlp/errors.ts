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
  | 'DISK_FULL'
  | 'INTERNAL'
  | 'MIRROR_TIMEOUT'
  | 'MIRROR_FAILED'

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

export interface Classified {
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
