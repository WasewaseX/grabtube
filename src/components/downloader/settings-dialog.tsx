'use client'

import { useEffect, useState } from 'react'
import { Cookie, Globe, ShieldCheck, Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { useToast } from '@/hooks/use-toast'

interface SettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}

export function SettingsDialog({ open, onOpenChange, onSaved }: SettingsDialogProps) {
  const { toast } = useToast()
  const [cookies, setCookies] = useState('')
  const [hasCookies, setHasCookies] = useState(false)
  const [proxies, setProxies] = useState('')
  const [clientOrder, setClientOrder] = useState('tv, web_safari, mweb, web, ios, android')
  const [concurrentFragments, setConcurrentFragments] = useState('5')
  const [maxRetries, setMaxRetries] = useState('3')
  const [usePoToken, setUsePoToken] = useState(true)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setLoading(true)
    fetch('/api/settings')
      .then(r => r.json())
      .then((d: { hasCookies?: boolean; cookies?: string; proxies?: { url: string }[]; clientOrder?: string[]; concurrentFragments?: number; maxRetries?: number; usePoToken?: boolean }) => {
        setHasCookies(!!d.hasCookies)
        setCookies('')
        setProxies((d.proxies ?? []).map(p => p.url).join('\n'))
        if (d.clientOrder?.length) setClientOrder(d.clientOrder.join(', '))
        if (d.concurrentFragments) setConcurrentFragments(String(d.concurrentFragments))
        if (d.maxRetries) setMaxRetries(String(d.maxRetries))
        setUsePoToken(d.usePoToken !== false)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [open])

  const save = async () => {
    setSaving(true)
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(cookies.trim() ? { cookies } : {}),
          proxies,
          clientOrder: clientOrder.split(',').map(s => s.trim()).filter(Boolean),
          concurrentFragments: Number(concurrentFragments) || 5,
          maxRetries: Number(maxRetries) || 3,
          usePoToken,
        }),
      })
      const data = (await res.json()) as { ok?: boolean; error?: string }
      if (!res.ok || data.error) throw new Error(data.error ?? 'Save failed')
      toast({ title: 'Settings saved', description: 'New settings apply to the next analysis and download.' })
      onSaved()
      onOpenChange(false)
    } catch (e) {
      toast({ title: 'Could not save settings', description: (e as Error).message, variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-zinc-900 border-zinc-800 max-w-2xl max-h-[85vh] overflow-y-auto sc-downloader-list">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-emerald-400" aria-hidden="true" /> Anti-bot &amp; network settings
          </DialogTitle>
          <DialogDescription className="text-zinc-400 text-xs">
            YouTube blocks datacenter IPs with &quot;Sign in to confirm you&apos;re not a bot&quot;. Cookies are the
            most reliable bypass. Proxies add a second layer with automatic rotation and health checks.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-zinc-500" aria-hidden="true" />
          </div>
        ) : (
          <div className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="cookies" className="flex items-center gap-2 text-sm">
                <Cookie className="h-4 w-4 text-amber-400" aria-hidden="true" /> YouTube cookies
                <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${hasCookies ? 'bg-emerald-500/15 text-emerald-400' : 'bg-zinc-800 text-zinc-500'}`}>
                  {hasCookies ? 'ACTIVE' : 'NOT SET'}
                </span>
              </Label>
              <Textarea
                id="cookies"
                value={cookies}
                onChange={e => setCookies(e.target.value)}
                placeholder={hasCookies ? 'Saved. Paste new cookies here to replace them (leave empty to keep).' : 'Paste cookies.txt contents here (Netscape format)...'}
                rows={6}
                className="bg-zinc-950 border-zinc-800 font-mono text-[11px]"
                spellCheck={false}
              />
              <p className="text-[11px] text-zinc-500">
                Export with a browser extension like &quot;Get cookies.txt LOCALLY&quot; while logged into YouTube (a
                throwaway account is recommended), then paste the full file contents here.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="proxies" className="flex items-center gap-2 text-sm">
                <Globe className="h-4 w-4 text-sky-400" aria-hidden="true" /> Proxy rotation list
              </Label>
              <Textarea
                id="proxies"
                value={proxies}
                onChange={e => setProxies(e.target.value)}
                placeholder={'One proxy per line, e.g.\nhttp://user:pass@host:port\nsocks5://host:port'}
                rows={4}
                className="bg-zinc-950 border-zinc-800 font-mono text-[11px]"
                spellCheck={false}
              />
              <p className="text-[11px] text-zinc-500">
                Proxies rotate automatically; failing proxies are quarantined after repeated bot-checks and
                re-tested later. Empty = direct connection.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="clients" className="text-sm">Player client fallback order</Label>
                <Input
                  id="clients"
                  value={clientOrder}
                  onChange={e => setClientOrder(e.target.value)}
                  className="bg-zinc-950 border-zinc-800 font-mono text-[11px]"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="frags" className="text-sm">Parallel fragments</Label>
                  <Input
                    id="frags"
                    type="number"
                    min={1}
                    max={16}
                    value={concurrentFragments}
                    onChange={e => setConcurrentFragments(e.target.value)}
                    className="bg-zinc-950 border-zinc-800"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="retries" className="text-sm">Max retry rounds</Label>
                  <Input
                    id="retries"
                    type="number"
                    min={1}
                    max={6}
                    value={maxRetries}
                    onChange={e => setMaxRetries(e.target.value)}
                    className="bg-zinc-950 border-zinc-800"
                  />
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2.5">
              <div>
                <p className="text-sm font-medium">PO token provider (bgutil)</p>
                <p className="text-[11px] text-zinc-500">
                  Deno service generating YouTube PO tokens — helps web clients pass verification.
                </p>
              </div>
              <Switch checked={usePoToken} onCheckedChange={setUsePoToken} aria-label="Toggle PO token provider" />
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => onOpenChange(false)} className="border-zinc-700">
                Cancel
              </Button>
              <Button onClick={save} disabled={saving} className="bg-red-600 hover:bg-red-500 text-white min-w-24">
                {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : 'Save settings'}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
