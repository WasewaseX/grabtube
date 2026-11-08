import { DlError, TERMINAL_CODES, classifyStderr, type Classified } from './errors'
import { MIN_HEALTHY_FORMATS, CLIENT_CHAIN, refreshClientChain } from './clients'
import { baseArgs, infoArgs } from './args'
import { loadCookiesText } from './cookies'
import type { RawInfo, YtRawFormat } from './model'
import { putInfo } from './store'
import { runYtDlp } from './run'
import { extractVideoId, isYouTubeUrl } from './url'
import { ensureVisitorData, mintVisitorData, persistVisitorData } from './visitor'

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

/** Live streams and empty format lists are terminal, wherever they surface. */
function assertDownloadable(raw: RawInfo): void {
  if (raw.is_live) throw new DlError('LIVE', 'Live streams cannot be downloaded.')
  if (raw.formats.length === 0) throw new DlError('NO_FORMATS', 'No downloadable formats found.')
}

async function fetchNonYouTube(clean: string, cookies: string | null): Promise<RawInfo> {
  const { code, stdout, stderr } = await runYtDlp(
    ['-J', ...baseArgs(), ...(cookies ? ['--cookies', cookies] : []), clean],
    150000,
  )
  if (code !== 0 || !stdout.trim().startsWith('{')) {
    const c = classifyStderr(stderr)
    throw new DlError(c.code, c.message, c.hint)
  }
  const raw = await parseRaw(stdout, clean)
  assertDownloadable(raw)
  return raw
}

/**
 * Rotate through the player-client chain: step 0 patient, later steps fail
 * fast. Keeps the richest degraded response — 1-format info beats no info.
 */
async function runClientChain(clean: string, cookies: string | null): Promise<RawInfo> {
  let visitor = await ensureVisitorData()
  refreshClientChain(visitor)
  let rotatedVisitor = false
  const errors: Classified[] = []
  const MAX_STEPS = 4
  const INFO_DEADLINE = Date.now() + 200_000 // overall budget for the client chain
  let bestRaw: RawInfo | null = null

  for (let i = 0; i < Math.min(MAX_STEPS, CLIENT_CHAIN.length); i++) {
    if (Date.now() > INFO_DEADLINE) break // budget spent → let providers answer
    const step = CLIENT_CHAIN[i]
    const patient = i === 0
    const { code, stdout, stderr } = await runYtDlp(
      [
        '-J',
        ...(patient ? baseArgs() : infoArgs()),
        ...step,
        ...(cookies ? ['--cookies', cookies] : []),
        clean,
      ],
      patient ? 75000 : 40000,
    )
    if (code === 0 && stdout.trim().startsWith('{')) {
      const raw = await parseRaw(stdout, clean)
      if (raw.is_live) throw new DlError('LIVE', 'Live streams cannot be downloaded.')
      if (raw.formats.length === 0) {
        errors.push({ code: 'NO_FORMATS', message: 'Player returned no media formats.' })
        continue
      }
      if (raw.formats.length >= MIN_HEALTHY_FORMATS) {
        return raw
      }
      // degraded (e.g. mweb single-format responses) — remember and rotate on
      if (!bestRaw || raw.formats.length > bestRaw.formats.length) bestRaw = raw
      errors.push({ code: 'NO_FORMATS', message: 'Player returned a degraded format list.' })
      continue
    }
    const c = classifyStderr(stderr || 'empty output')
    if (TERMINAL_CODES.has(c.code)) throw new DlError(c.code, c.message, c.hint)
    errors.push(c)
    // IP-level bot walls answer the same on every player client — rotating
    // clients/visitor ids cannot fix a flagged egress IP. Break out AT ONCE
    // so the mirror layers (Piped/Invidious/savenow) answer; the fetch-queue
    // re-attempts yt-dlp on later cycles when the tunnel phase rotates.
    if (c.code === 'BOT_CHECK' || c.code === 'RATE_LIMITED') break
    // bot wall → rotate visitor identity exactly once and keep rotating clients
    if (!rotatedVisitor) {
      rotatedVisitor = true
      const minted = await mintVisitorData()
      if (minted && minted !== visitor) {
        visitor = minted
        persistVisitorData(minted)
        refreshClientChain(visitor)
      }
    }
  }

  if (bestRaw && bestRaw.formats.length > 0) {
    return bestRaw
  }
  const worst = errors.find((e) => e.code === 'BOT_CHECK') ?? errors[0] ?? { code: 'FETCH_FAILED' as const, message: 'Extraction failed.' }
  throw new DlError(worst.code, worst.message, worst.hint)
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

  const { ensurePotServer } = await import('../pot')
  void ensurePotServer().catch(() => undefined)

  const cookies = await loadCookiesText()
  const raw = isYouTubeUrl(clean) ? await runClientChain(clean, cookies) : await fetchNonYouTube(clean, cookies)
  const infoId = putInfo(raw)
  return { infoId, raw }
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
