import { spawn } from 'child_process'
import { getDenoPath, POT_SERVER_URL } from '@/lib/ytdlp'

const globalForPot = globalThis as unknown as { potStarting: boolean | undefined }

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
 */
export async function ensurePotServer(): Promise<boolean> {
  if (await isPotServerUp()) return true
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
    const deno = getDenoPath()
    const child = spawn(
      deno,
      ['run', '--allow-net', '--allow-read', '--allow-write', '--allow-env', 'src/main.ts'],
      {
        cwd: '/home/z/my-project/mini-services/pot-provider/server',
        detached: true,
        stdio: 'ignore',
      }
    )
    child.unref()
    for (let i = 0; i < 20; i++) {
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
