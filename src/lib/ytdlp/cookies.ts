import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

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

export async function loadCookiesText(): Promise<string | null> {
  try {
    const { getSettings } = await import('../settings')
    const s = await getSettings()
    return s.cookies && s.cookies.trim() ? s.cookies : null
  } catch {
    return null
  }
}
