// ---- Strategy rotation helpers ----------------------------------------------

import { detectBotCheck } from '@/lib/ytdlp'

export function buildAttemptOrder(clients: string[]): string[] {
  const preferred = ['tv', 'web_safari', 'mweb', 'web', 'ios', 'android']
  const ordered = clients.filter(c => preferred.includes(c))
  const rest = clients.filter(c => !preferred.includes(c))
  return [...(ordered.length ? ordered : preferred), ...rest]
}

export function summarizeError(err: string): string {
  const e = err.slice(0, 400)
  if (detectBotCheck(e))
    return 'YouTube requires verification for this server. Fix: add YouTube cookies in Settings (or a working proxy), then press Retry.'
  return e
}
