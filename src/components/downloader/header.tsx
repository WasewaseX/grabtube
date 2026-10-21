'use client'

import { useEffect, useState } from 'react'
import { Settings2, Activity } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { HealthInfo } from '@/lib/types'

interface HeaderProps {
  onOpenSettings: () => void
}

function Dot({ ok }: { ok: boolean }) {
  return (
    <span
      className={`inline-block h-2 w-2 rounded-full ${ok ? 'bg-emerald-400' : 'bg-red-400'}`}
      aria-hidden="true"
    />
  )
}

export function Header({ onOpenSettings }: HeaderProps) {
  const [health, setHealth] = useState<HealthInfo | null>(null)

  useEffect(() => {
    let stop = false
    const load = async () => {
      try {
        const r = await fetch('/api/health')
        const d = (await r.json()) as HealthInfo
        if (!stop) setHealth(d)
      } catch {
        /* offline */
      }
    }
    load()
    const id = setInterval(load, 30000)
    return () => {
      stop = true
      clearInterval(id)
    }
  }, [])

  return (
    <header className="border-b border-zinc-800 bg-zinc-950/80 backdrop-blur sticky top-0 z-40">
      <div className="mx-auto max-w-5xl px-4 py-3 flex items-center gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-red-600 shadow-lg shadow-red-950/40">
            <svg viewBox="0 0 24 24" className="h-5 w-5 text-white" fill="currentColor" aria-hidden="true">
              <path d="M12 3a1 1 0 0 1 1 1v9.17l2.59-2.58a1 1 0 1 1 1.41 1.41l-4.29 4.3a1 1 0 0 1-1.42 0l-4.29-4.3a1 1 0 0 1-1.41-1.41L11 13.17V4a1 1 0 0 1 1-1Z" />
              <path d="M4 17a1 1 0 0 1 1 1v1h14v-1a1 1 0 1 1 2 0v2a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-2a1 1 0 0 1 1-1Z" />
            </svg>
          </div>
          <div className="min-w-0">
            <h1 className="text-base font-bold leading-tight truncate">GrabTube</h1>
            <p className="text-[11px] text-zinc-500 leading-tight hidden sm:block">
              Fast YouTube downloader — resumable, IDM-ready
            </p>
          </div>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <div
            className="hidden md:flex items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-1.5 text-[11px] text-zinc-400"
            title="Server toolchain status"
          >
            <Activity className="h-3.5 w-3.5 text-zinc-500" aria-hidden="true" />
            <span className="flex items-center gap-1.5">
              <Dot ok={!!health && health.ytDlp !== 'not found'} /> yt-dlp {health ? health.ytDlp : '...'}
            </span>
            <span className="flex items-center gap-1.5">
              <Dot ok={!!health && health.ffmpeg !== 'not found'} /> ffmpeg {health && health.ffmpeg !== 'not found' ? health.ffmpeg : ''}
            </span>
            <span className="flex items-center gap-1.5">
              <Dot ok={!!health && health.deno !== 'not found'} /> deno {health && health.deno !== 'not found' ? health.deno : ''}
            </span>
            <span className="flex items-center gap-1.5">
              <Dot ok={!!health && health.potServer.startsWith('online')} /> PO token {health ? health.potServer : '...'}
            </span>
          </div>
          <Button variant="outline" size="icon" onClick={onOpenSettings} aria-label="Open settings"
            className="border-zinc-800 hover:bg-zinc-800">
            <Settings2 className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </header>
  )
}
