import { randomUUID } from 'node:crypto'

import type { RawInfo } from './model'

interface StoreEntry {
  raw: RawInfo
  at: number
}

declare global {
  var __tgInfoStore: Map<string, StoreEntry> | undefined
}

function infoStore(): Map<string, StoreEntry> {
  if (!globalThis.__tgInfoStore) globalThis.__tgInfoStore = new Map()
  return globalThis.__tgInfoStore
}

const INFO_TTL_MS = 6 * 60 * 60 * 1000
const INFO_MAX = 60

function pruneStore(): void {
  const store = infoStore()
  const now = Date.now()
  for (const [k, v] of store) {
    if (now - v.at > INFO_TTL_MS) store.delete(k)
  }
  while (store.size > INFO_MAX) {
    const oldest = [...store.entries()].sort((a, b) => a[1].at - b[1].at)[0]
    if (!oldest) break
    store.delete(oldest[0])
  }
}

export function putInfo(raw: RawInfo): string {
  const id = randomUUID()
  const store = infoStore()
  store.set(id, { raw, at: Date.now() })
  pruneStore()
  return id
}

export function getInfo(infoId: string): StoreEntry | null {
  const e = infoStore().get(infoId)
  if (!e) return null
  if (Date.now() - e.at > INFO_TTL_MS) {
    infoStore().delete(infoId)
    return null
  }
  return e
}
