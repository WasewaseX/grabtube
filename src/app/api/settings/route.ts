import { NextRequest, NextResponse } from 'next/server'
import { getSettings, saveSettings } from '@/lib/settings'

export const dynamic = 'force-dynamic'

function maskProxyUrl(u: string): string {
  return u.replace(/:\/\/([^:@/]+):([^@/]+)@/, '://$1:***@')
}

export async function GET() {
  const s = await getSettings()
  return NextResponse.json({
    cookies: s.cookies,
    hasCookies: Boolean(s.cookies && s.cookies.trim()),
    proxies: s.proxies.map(p => ({ ...p, url: maskProxyUrl(p.url) })),
    clientOrder: s.clientOrder,
    concurrentFragments: s.concurrentFragments,
    maxRetries: s.maxRetries,
    usePoToken: s.usePoToken,
  })
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      cookies?: string
      proxies?: string // newline separated proxy urls (raw, with credentials)
      clientOrder?: string[]
      concurrentFragments?: number
      maxRetries?: number
      usePoToken?: boolean
    }

    const patch: Parameters<typeof saveSettings>[0] = {}

    if (body.cookies !== undefined) patch.cookies = body.cookies
    if (body.proxies !== undefined) {
      patch.proxies = body.proxies
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean)
        .map(url => ({ url, healthy: true, fails: 0 }))
    }
    if (body.clientOrder !== undefined) patch.clientOrder = body.clientOrder
    if (body.concurrentFragments !== undefined)
      patch.concurrentFragments = Math.max(1, Math.min(16, Number(body.concurrentFragments) || 5))
    if (body.maxRetries !== undefined) patch.maxRetries = Math.max(1, Math.min(6, Number(body.maxRetries) || 3))
    if (body.usePoToken !== undefined) patch.usePoToken = Boolean(body.usePoToken)

    const saved = await saveSettings(patch)
    return NextResponse.json({
      ok: true,
      hasCookies: Boolean(saved.cookies && saved.cookies.trim()),
      proxyCount: saved.proxies.length,
    })
  } catch (e) {
    const err = e as Error
    return NextResponse.json({ error: err.message }, { status: 400 })
  }
}
