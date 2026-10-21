import { db } from '@/lib/db'

export interface ProxyEntry {
  url: string
  label?: string
  healthy?: boolean
  lastChecked?: number
  fails?: number
}

export interface AppSettings {
  cookies: string // cookies.txt content (Netscape format)
  proxies: ProxyEntry[]
  clientOrder: string[] // youtube player client fallback chain
  concurrentFragments: number
  maxRetries: number
  usePoToken: boolean
}

const DEFAULTS: AppSettings = {
  cookies: '',
  proxies: [],
  clientOrder: ['tv', 'web_safari', 'mweb', 'web', 'ios', 'android'],
  concurrentFragments: 5,
  maxRetries: 3,
  usePoToken: true,
}

export async function getSettings(): Promise<AppSettings> {
  try {
    const rows = await db.setting.findMany()
    const map = new Map(rows.map(r => [r.key, r.value]))
    return {
      cookies: map.get('cookies') ?? DEFAULTS.cookies,
      proxies: safeParse<ProxyEntry[]>(map.get('proxies'), DEFAULTS.proxies),
      clientOrder: safeParse<string[]>(map.get('clientOrder'), DEFAULTS.clientOrder),
      concurrentFragments: safeParse<number>(map.get('concurrentFragments'), DEFAULTS.concurrentFragments),
      maxRetries: safeParse<number>(map.get('maxRetries'), DEFAULTS.maxRetries),
      usePoToken: safeParse<boolean>(map.get('usePoToken'), DEFAULTS.usePoToken),
    }
  } catch {
    return { ...DEFAULTS }
  }
}

export async function saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const entries: Array<[string, string]> = []
  if (patch.cookies !== undefined) entries.push(['cookies', patch.cookies])
  if (patch.proxies !== undefined) entries.push(['proxies', JSON.stringify(patch.proxies)])
  if (patch.clientOrder !== undefined) entries.push(['clientOrder', JSON.stringify(patch.clientOrder)])
  if (patch.concurrentFragments !== undefined)
    entries.push(['concurrentFragments', String(patch.concurrentFragments)])
  if (patch.maxRetries !== undefined) entries.push(['maxRetries', String(patch.maxRetries)])
  if (patch.usePoToken !== undefined) entries.push(['usePoToken', String(patch.usePoToken)])

  for (const [key, value] of entries) {
    await db.setting.upsert({
      where: { key },
      update: { value },
      create: { key, value },
    })
  }
  return getSettings()
}

export async function markProxyResult(proxyUrl: string, ok: boolean) {
  const settings = await getSettings()
  const proxies = settings.proxies.map(p =>
    p.url === proxyUrl
      ? {
          ...p,
          fails: ok ? 0 : (p.fails ?? 0) + 1,
          healthy: ok ? true : (p.fails ?? 0) + 1 < 3,
          lastChecked: Date.now(),
        }
      : p
  )
  await saveSettings({ proxies })
}

export function healthyProxies(proxies: ProxyEntry[]): ProxyEntry[] {
  return (proxies ?? []).filter(p => p.healthy !== false)
}

function safeParse<T>(raw: string | undefined, fallback: T): T {
  if (raw === undefined || raw === null || raw === '') return fallback
  try {
    const v = JSON.parse(raw)
    return v === null || v === undefined ? fallback : (v as T)
  } catch {
    // plain string values (e.g. "5") for numeric settings
    if (typeof fallback === 'number' && !isNaN(Number(raw))) return Number(raw) as unknown as T
    if (typeof fallback === 'boolean') return (raw === 'true') as unknown as T
    return fallback
  }
}
