import { spawn, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { getDenoPath, POT_SERVER_URL, toolEnv } from '@/lib/ytdlp'

const globalForPot = globalThis as unknown as {
  potStarting: boolean | undefined
  potChild: ChildProcess | undefined
}

export async function isPotServerUp(): Promise<boolean> {
  try {
    const res = await fetch(`${POT_SERVER_URL}/ping`, { signal: AbortSignal.timeout(2500) })
    return res.ok
  } catch {
    return false
  }
}

/**
 * Ensure the bgutil PO token server is running.
 * The Next.js process supervises it: if the deno child dies (server restart,
 * sandbox cleanup), the next analyze/download/health call revives it.
 *
 * HARDENED: a missing deno binary / missing server source emits an 'error'
 * event on the child — an unhandled one crashes the whole Next.js runtime
 * (that was the "engine couldn't fetch" crash). We attach a no-op handler
 * and verify by health-ping instead of trusting the spawn.
 */
export async function ensurePotServer(): Promise<boolean> {
  if (await isPotServerUp()) return true

  const deno = getDenoPath()
  const serverEntry = '/home/z/my-project/mini-services/pot-provider/server/src/main.ts'
  const denoIsReal = deno !== 'deno' || Boolean(firstExistingOnPath('deno'))
  if (!existsSync(serverEntry) || !denoIsReal) return false // fail soft, never crash

  if (globalForPot.potStarting) {
    // another call is already starting it — wait briefly then report
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 500))
      if (await isPotServerUp()) return true
    }
    return false
  }
  globalForPot.potStarting = true
  try {
    const child = spawn(
      deno,
      ['run', '--allow-net', '--allow-read', '--allow-write', '--allow-env', 'src/main.ts'],
      {
        cwd: '/home/z/my-project/mini-services/pot-provider/server',
        detached: true,
        stdio: 'ignore',
        env: toolEnv(),
      }
    )
    // CRITICAL: swallow spawn/exec errors (ENOENT, EACCES, signals).
    child.on('error', () => { /* verified via health-ping below */ })
    child.unref()
    globalForPot.potChild = child
    // first boot after a sandbox reset resolves deno deps cold (~1 min) —
    // the ping window must outlive that or the server gets orphaned "offline"
    for (let i = 0; i < 150; i++) {
      await new Promise(r => setTimeout(r, 500))
      if (await isPotServerUp()) return true
    }
    return false
  } catch {
    return false
  } finally {
    globalForPot.potStarting = false
  }
}

function firstExistingOnPath(bin: string): boolean {
  const dirs = (process.env.PATH ?? '').split(':')
  return dirs.some(d => d && existsSync(`${d}/${bin}`))
}
