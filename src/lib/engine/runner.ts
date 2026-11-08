// ---- Main download routine with strategy rotation ---------------------------
//
// Rounds rotate client × proxy strategies; a canceled registry short-circuits
// the loop from any attempt (checked before and after each attempt).

import { mkdirSync } from 'fs'
import path from 'path'
import { db } from '@/lib/db'
import { detectBotCheck } from '@/lib/ytdlp'
import { getSettings, healthyProxies, markProxyResult } from '@/lib/settings'
import { ExtractionError, findFinalFile, runSingleAttempt } from './attempt'
import { SelectOptions } from './format'
import { activeJobs, ActiveJob } from './registry'
import { buildAttemptOrder, summarizeError } from './strategies'

export const DOWNLOAD_DIR = '/home/z/my-project/downloads'

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

async function markCanceled(jobId: string): Promise<void> {
  await db.download
    .update({ where: { id: jobId }, data: { status: 'canceled', stage: 'canceled' } })
    .catch(() => {})
}

async function prepareRun(jobId: string) {
  const job = await db.download.findUnique({ where: { id: jobId } })
  if (!job) return null

  const settings = await getSettings()
  if (settings.usePoToken) {
    const { ensurePotServer } = await import('@/lib/pot')
    await ensurePotServer().catch(() => false)
  }
  const proxies = healthyProxies(settings.proxies)
  const clients = buildAttemptOrder(settings.clientOrder?.length ? settings.clientOrder : [])
  const maxRounds = Math.max(1, Math.min(settings.maxRetries ?? 3, 6))

  const outDir = path.join(DOWNLOAD_DIR, jobId)
  mkdirSync(outDir, { recursive: true })

  const select: SelectOptions = {
    mode: job.mode === 'audio' ? 'audio' : 'video',
    quality: job.quality,
    codec: job.codec,
    container: job.container,
  }

  const registry: ActiveJob = { process: null, canceled: false }
  activeJobs.set(jobId, registry)

  const proxyOrder = ['', ...proxies.map(p => p.url)]

  await db.download.update({
    where: { id: jobId },
    data: { status: 'downloading', stage: 'extract', attempts: job.attempts + 1, error: null },
  })

  return { job, settings, clients, maxRounds, outDir, select, registry, proxyOrder }
}

type RunPlan = NonNullable<Awaited<ReturnType<typeof prepareRun>>>

interface AttemptOutcome {
  done: boolean
  canceled: boolean
  err: string
}

async function runStrategy(
  run: RunPlan,
  client: string,
  proxy: string,
  strategy: string,
): Promise<AttemptOutcome> {
  const { job, outDir, select, registry, settings } = run
  try {
    await runSingleAttempt(job.id, job.url, outDir, select, {
      client,
      proxy: proxy || undefined,
      cookies: settings.cookies,
      usePoToken: settings.usePoToken,
      concurrentFragments: settings.concurrentFragments,
    }, registry)

    const found = findFinalFile(outDir)
    if (!found) throw new ExtractionError('Download finished but output file was not found')

    await db.download.update({
      where: { id: job.id },
      data: {
        status: 'completed',
        stage: 'done',
        progress: 100,
        speed: null,
        eta: null,
        filename: found.filename,
        filepath: found.filepath,
        filesize: found.size,
        directUrl: `/api/file/${job.id}`,
        strategy,
        error: null,
      },
    })
    if (proxy) await markProxyResult(proxy, true)
    return { done: true, canceled: false, err: '' }
  } catch (e) {
    const err = (e as Error).message || String(e)
    return { done: false, canceled: registry.canceled, err }
  }
}

export async function startDownload(jobId: string): Promise<void> {
  const run = await prepareRun(jobId)
  if (!run) return

  let lastError = 'Download failed'

  try {
    for (let round = 0; round < run.maxRounds; round++) {
      for (const client of run.clients) {
        if (run.registry.canceled) {
          await markCanceled(jobId)
          return
        }
        const proxy = run.proxyOrder[round % run.proxyOrder.length]
        const strategy = `${client}${proxy ? ' via proxy' : ' direct'}`

        const outcome = await runStrategy(run, client, proxy, strategy)
        if (outcome.done) return
        if (outcome.canceled) {
          await markCanceled(jobId)
          return
        }

        lastError = outcome.err
        if (proxy) await markProxyResult(proxy, !detectBotCheck(outcome.err))
        await db.download
          .update({ where: { id: jobId }, data: { error: `${strategy}: ${outcome.err.slice(0, 500)}` } })
          .catch(() => {})
        await sleep(Math.min(1500 * 2 ** round, 12000))
      }
    }

    await db.download.update({
      where: { id: jobId },
      data: { status: 'failed', stage: 'failed', error: summarizeError(lastError) },
    })
  } finally {
    activeJobs.delete(jobId)
  }
}
