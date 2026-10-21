'use client'

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, ShieldAlert, History } from 'lucide-react'
import { Header } from '@/components/downloader/header'
import { UrlBar } from '@/components/downloader/url-bar'
import { VideoPanel } from '@/components/downloader/video-panel'
import { JobsList } from '@/components/downloader/jobs-list'
import { SettingsDialog } from '@/components/downloader/settings-dialog'
import { Button } from '@/components/ui/button'
import { useToast } from '@/hooks/use-toast'
import type { Job, VideoResult } from '@/lib/types'
import { isActiveStatus } from '@/lib/format'

export default function Home() {
  const { toast } = useToast()
  const [analyzing, setAnalyzing] = useState(false)
  const [starting, setStarting] = useState(false)
  const [video, setVideo] = useState<VideoResult | null>(null)
  const [error, setError] = useState<{ message: string; botCheck: boolean } | null>(null)
  const [jobs, setJobs] = useState<Job[] | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)

  // ---- job polling (client-only, hydration-safe) ----
  const hasActive = jobs ? jobs.some(j => isActiveStatus(j.status)) : false

  const refreshJobs = useCallback(async () => {
    try {
      const r = await fetch('/api/jobs', { cache: 'no-store' })
      const d = (await r.json()) as { jobs: Job[] }
      setJobs(d.jobs)
    } catch {
      /* transient */
    }
  }, [])

  useEffect(() => {
    void refreshJobs()
    const id = setInterval(() => {
      void refreshJobs()
    }, hasActive ? 1200 : 5000)
    return () => clearInterval(id)
  }, [refreshJobs, hasActive])

  // ---- analyze ----
  const handleAnalyze = useCallback(
    async (url: string) => {
      setAnalyzing(true)
      setError(null)
      try {
        const res = await fetch('/api/analyze', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url }),
        })
        const data = (await res.json()) as { video?: VideoResult; strategy?: string; error?: string }
        if (!res.ok || !data.video) {
          throw new Error(data.error ?? 'Analysis failed')
        }
        setVideo(data.video)
        toast({
          title: 'Video loaded',
          description: `Extracted via ${data.strategy}. Pick quality and codec, then press Download.`,
        })
      } catch (e) {
        const msg = (e as Error).message
        setError({ message: msg, botCheck: /not a bot|sign in|429/i.test(msg) })
        setVideo(null)
      } finally {
        setAnalyzing(false)
      }
    },
    [toast]
  )

  // ---- start download ----
  const handleDownload = useCallback(
    async (opts: { mode: 'video' | 'audio'; quality: string; codec: string; container: string }) => {
      if (!video) return
      setStarting(true)
      try {
        const res = await fetch('/api/download', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: video.url,
            title: video.title,
            thumbnail: video.thumbnail,
            duration: video.duration,
            channel: video.channel,
            ...opts,
          }),
        })
        const data = (await res.json()) as { job?: Job; error?: string }
        if (!res.ok || !data.job) throw new Error(data.error ?? 'Could not start download')
        toast({
          title: 'Download started',
          description: `${video.title.slice(0, 60)} — progress appears below. A direct link will be available when done.`,
        })
        await refreshJobs()
      } catch (e) {
        toast({ title: 'Download failed to start', description: (e as Error).message, variant: 'destructive' })
      } finally {
        setStarting(false)
      }
    },
    [video, toast, refreshJobs]
  )

  // ---- job actions ----
  const handleAction = useCallback(
    async (id: string, action: 'cancel' | 'retry' | 'delete') => {
      try {
        if (action === 'delete') {
          await fetch(`/api/jobs/${id}`, { method: 'DELETE' })
        } else {
          await fetch(`/api/jobs/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action }),
          })
        }
        await refreshJobs()
      } catch {
        toast({ title: 'Action failed', variant: 'destructive' })
      }
    },
    [refreshJobs, toast]
  )

  const activeCount = jobs ? jobs.filter(j => isActiveStatus(j.status)).length : 0
  const completedCount = jobs ? jobs.filter(j => j.status === 'completed').length : 0

  return (
    <div className="min-h-screen flex flex-col bg-zinc-950">
      <Header onOpenSettings={() => setSettingsOpen(true)} />

      <main className="flex-1 mx-auto w-full max-w-5xl px-4 py-6 md:py-8 space-y-6">
        {/* hero + url bar */}
        <section aria-label="Download a video">
          <div className="mb-4">
            <h2 className="text-xl md:text-2xl font-bold tracking-tight">
              Download YouTube videos <span className="text-red-500">fast</span>
            </h2>
            <p className="text-sm text-zinc-500 mt-1">
              Every quality and codec · resumable engine · IDM / aria2 / wget compatible direct links
            </p>
          </div>
          <UrlBar onAnalyze={handleAnalyze} loading={analyzing} />

          {error ? (
            <div
              className={`mt-4 rounded-lg border p-3.5 text-sm ${
                error.botCheck
                  ? 'border-amber-500/30 bg-amber-950/20 text-amber-200'
                  : 'border-red-500/30 bg-red-950/20 text-red-200'
              }`}
              role="alert"
            >
              <div className="flex items-start gap-2.5">
                {error.botCheck ? (
                  <ShieldAlert className="h-4.5 w-4.5 mt-0.5 shrink-0" aria-hidden="true" />
                ) : (
                  <AlertTriangle className="h-4.5 w-4.5 mt-0.5 shrink-0" aria-hidden="true" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{error.botCheck ? 'YouTube verification block detected' : 'Could not analyze this link'}</p>
                  <p className="mt-0.5 text-xs opacity-90 leading-relaxed whitespace-pre-wrap">{error.message}</p>
                  {error.botCheck ? (
                    <Button
                      size="sm"
                      onClick={() => setSettingsOpen(true)}
                      className="mt-2 h-8 bg-amber-500 hover:bg-amber-400 text-black font-semibold"
                    >
                      Add YouTube cookies to bypass
                    </Button>
                  ) : null}
                </div>
              </div>
            </div>
          ) : null}

          {video ? (
            <div className="mt-5">
              <VideoPanel video={video} onDownload={handleDownload} starting={starting} />
            </div>
          ) : null}
        </section>

        {/* downloads */}
        <section aria-label="Downloads">
          <div className="flex items-center justify-between mb-3">
            <h3 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-zinc-400">
              <History className="h-4 w-4" aria-hidden="true" />
              Downloads
              {activeCount > 0 ? (
                <span className="rounded-full bg-red-600/20 px-2 py-0.5 text-[10px] font-bold text-red-400 border border-red-500/30">
                  {activeCount} ACTIVE
                </span>
              ) : null}
              {completedCount > 0 ? (
                <span className="rounded-full bg-emerald-600/15 px-2 py-0.5 text-[10px] font-bold text-emerald-400 border border-emerald-500/30">
                  {completedCount} READY
                </span>
              ) : null}
            </h3>
          </div>
          <JobsList jobs={jobs} onAction={handleAction} />
        </section>
      </main>

      <footer className="mt-auto border-t border-zinc-800 bg-zinc-950">
        <div className="mx-auto max-w-5xl px-4 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] flex flex-col sm:flex-row items-center justify-between gap-2 text-[11px] text-zinc-600">
          <p>
            GrabTube — powered by yt-dlp + ffmpeg + deno PO-token provider, running server-side.
          </p>
          <p>
            Direct links support <span className="text-zinc-400 font-medium">Range/resume</span> — paste them into
            IDM, aria2c or wget -c.
          </p>
        </div>
      </footer>

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} onSaved={refreshJobs} />
    </div>
  )
}
