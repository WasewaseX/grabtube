'use client'

import { useState } from 'react'
import { Link2, Loader2, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

interface UrlBarProps {
  onAnalyze: (url: string) => Promise<void>
  loading: boolean
}

export function UrlBar({ onAnalyze, loading }: UrlBarProps) {
  const [url, setUrl] = useState('')

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault()
    if (!url.trim() || loading) return
    await onAnalyze(url.trim())
  }

  return (
    <form onSubmit={submit} className="flex flex-col sm:flex-row gap-2" role="search">
      <div className="relative flex-1">
        <Link2 className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" aria-hidden="true" />
        <Input
          value={url}
          onChange={e => setUrl(e.target.value)}
          placeholder="Paste a YouTube link — youtube.com/watch?v=... or youtu.be/..."
          className="h-12 pl-9 pr-4 bg-zinc-900 border-zinc-800 text-sm placeholder:text-zinc-600 focus-visible:ring-red-600/60"
          aria-label="YouTube video URL"
          autoComplete="off"
          spellCheck={false}
          inputMode="url"
        />
      </div>
      <Button
        type="submit"
        disabled={loading || !url.trim()}
        className="h-12 px-6 bg-red-600 hover:bg-red-500 text-white font-semibold min-w-[130px]"
      >
        {loading ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Analyzing
          </>
        ) : (
          <>
            <Search className="h-4 w-4" aria-hidden="true" /> Analyze
          </>
        )}
      </Button>
    </form>
  )
}
