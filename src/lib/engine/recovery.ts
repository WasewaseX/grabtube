// ---- Recovery on server boot ------------------------------------------------

import { db } from '@/lib/db'
import { activeJobs } from './registry'

const globalForRecovery = globalThis as unknown as { recovered: boolean | undefined }
export async function recoverInterruptedJobs(): Promise<void> {
  if (globalForRecovery.recovered) return
  globalForRecovery.recovered = true
  try {
    const stuck = await db.download.findMany({
      where: { status: { in: ['downloading', 'processing'] } },
    })
    for (const job of stuck) {
      if (!activeJobs.has(job.id)) {
        await db.download.update({
          where: { id: job.id },
          data: {
            status: 'failed',
            stage: 'failed',
            error: 'Interrupted by server restart. Press Retry to resume (partial files are kept).',
          },
        })
      }
    }
  } catch {
    /* ignore */
  }
}
