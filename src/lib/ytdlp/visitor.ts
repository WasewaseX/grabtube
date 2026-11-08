import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { PROJECT_ROOT } from './tools'

const DATA_DIR = path.join(PROJECT_ROOT, 'data')
const VISITOR_FILE = path.join(DATA_DIR, 'visitor_data.txt')

const VISITOR_TTL_MS = 4 * 60 * 60 * 1000

declare global {
  var __tgVisitorData: string | null | undefined
  var __tgVisitorAt: number | undefined
}

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

export function persistVisitorData(v: string): void {
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
export async function mintVisitorData(): Promise<string | null> {
  try {
    const { proxiedFetch } = await import('../proxy')
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

export async function ensureVisitorData(): Promise<string | null> {
  const cached = cachedVisitorData()
  if (cached) return cached
  const minted = await mintVisitorData()
  if (minted) persistVisitorData(minted)
  return minted ?? null
}
