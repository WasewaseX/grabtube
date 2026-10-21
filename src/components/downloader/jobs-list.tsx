'use client'

import { Download, Copy, RotateCcw, Trash2, X, Check, Music } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area'
import type { Job } from '@/lib/types'
import {
  formatBytes,
  formatWhen,
  qualityLabel,
  codecLabel,
  STATUS_META,
  isActiveStatus,
} from '@/lib/format'

interface JobsListProps {
  jobs: Job[] | null
  onAction: (id: string, action: 'cancel' | 'retry' | 'delete') => Promise<void>
}

function DirectLinkButton({ job }: { job: Job }) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    const link = `${window.location.origin}${job.directUrl}`
    try {
      await navigator.clipboard.writeText(link)
    } catch {
      // clipboard API can be blocked — fallback for older contexts
      const ta = document.createElement('textarea')
      ta.value = link
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <Button
      size="sm"
      variant="outline"
      onClick={copy}
      className="h-8 border-zinc-700 hover:bg-zinc-800 gap-1.5 text-xs"
      title="Copy direct link for IDM / aria2 / wget — supports resume and multi-threading"
    >
      {copied ? (
        <>
          <Check className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" /> Copied
        </>
      ) : (
        <>
          <Copy className="h-3.5 w-3.5" aria-hidden="true" /> Direct link
        </>
      )}
    </Button>
  )
}

export function JobsList({ jobs, onAction }: JobsListProps) {
  if (jobs === null) {
    return (
      <div className="space-y-2">
        {[0, 1].map(i => (
          <div key={i} className="h-20 rounded-lg bg-zinc-900/50 border border-zinc-800/60 animate-pulse" />
        ))}
      </div>
    )
  }

  if (jobs.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-zinc-800 py-10 text-center text-sm text-zinc-600">
        No downloads yet. Paste a YouTube link above to get started.
      </div>
    )
  }

  return (
    <ScrollArea className="max-h-[560px] pr-2 sc-downloader-list">
      <div className="space-y-2.5">
        {jobs.map(job => {
          const meta = STATUS_META[job.status] ?? STATUS_META.pending
          const active = isActiveStatus(job.status)
          const typeLabel =
            job.mode === 'audio'
              ? `Audio · ${job.container.toUpperCase()}`
              : `${qualityLabel(job.quality)} · ${codecLabel(job.codec)} · ${job.container.toUpperCase()}`
          return (
            <div
              key={job.id}
              className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 md:p-4 transition-colors hover:border-zinc-700"
            >
              <div className="flex items-start gap-3">
                <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded bg-zinc-800">
                  {job.mode === 'audio' ? (
                    <Music className="h-4 w-4 text-zinc-400" aria-hidden="true" />
                  ) : (
                    <Download className="h-4 w-4 text-zinc-400" aria-hidden="true" />
                  )}
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-2">
                    <p className="truncate text-sm font-medium" title={job.title}>
                      {job.title}
                    </p>
                    <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${meta.cls}`}>
                      {meta.label}
                    </span>
                  </div>

                  <p className="mt-0.5 truncate text-[11px] text-zinc-500">
                    {typeLabel} · {formatBytes(job.filesize)} · {formatWhen(job.createdAt)}
                    {job.attempts > 1 ? ` · attempt ${job.attempts}` : ''}
                    {job.strategy ? ` · ${job.strategy}` : ''}
                  </p>

                  {active ? (
                    <div className="mt-2 space-y-1.5">
                      <Progress
                        value={job.progress}
                        className="h-2 bg-zinc-800 [&>div]:bg-red-500 [&>div]:transition-all"
                        aria-label={`Download progress ${Math.round(job.progress)}%`}
                      />
                      <div className="flex items-center justify-between text-[11px] text-zinc-500">
                        <span>
                          {job.stage === 'extract'
                            ? 'Resolving streams...'
                            : job.stage === 'merge'
                              ? 'Merging video + audio...'
                              : job.stage === 'extract_audio'
                                ? 'Converting audio...'
                                : job.stage === 'finalize'
                                  ? 'Finalizing...'
                                  : `${Math.round(job.progress)}%`}
                        </span>
                        <span>
                          {job.speed ? `${job.speed}` : ''} {job.eta ? `· ETA ${job.eta}` : ''}
                        </span>
                      </div>
                    </div>
                  ) : null}

                  {job.status === 'failed' && job.error ? (
                    <p className="mt-2 rounded border border-red-500/20 bg-red-950/30 px-2 py-1.5 text-[11px] leading-snug text-red-300 line-clamp-3">
                      {job.error}
                    </p>
                  ) : null}

                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {job.status === 'completed' && job.directUrl ? (
                      <>
                        <DirectLinkButton job={job} />
                        <a
                          href={job.directUrl}
                          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-zinc-700 px-3 text-xs font-medium hover:bg-zinc-800"
                        >
                          <Download className="h-3.5 w-3.5" aria-hidden="true" /> Save file
                        </a>
                      </>
                    ) : null}
                    {job.status === 'downloading' ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => onAction(job.id, 'cancel')}
                        className="h-8 border-zinc-700 hover:bg-zinc-800 gap-1.5 text-xs"
                      >
                        <X className="h-3.5 w-3.5" aria-hidden="true" /> Cancel
                      </Button>
                    ) : null}
                    {(job.status === 'failed' || job.status === 'canceled') ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => onAction(job.id, 'retry')}
                        className="h-8 border-zinc-700 hover:bg-zinc-800 gap-1.5 text-xs"
                      >
                        <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" /> Retry
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => onAction(job.id, 'delete')}
                      className="h-8 text-zinc-500 hover:text-red-400 hover:bg-red-950/30 gap-1.5 text-xs"
                      aria-label={`Delete download ${job.title}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" /> Delete
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          )
        })}
      </div>
      <ScrollBar orientation="horizontal" />
    </ScrollArea>
  )
}
