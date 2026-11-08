// ---- Active job registry ---------------------------------------------------

import { ChildProcess } from 'child_process'

export interface ActiveJob {
  process: ChildProcess | null
  canceled: boolean
}

const globalForEngine = globalThis as unknown as {
  activeJobs: Map<string, ActiveJob> | undefined
}
export const activeJobs: Map<string, ActiveJob> = globalForEngine.activeJobs ?? new Map()
globalForEngine.activeJobs = activeJobs

export function isJobActive(jobId: string): boolean {
  return activeJobs.has(jobId)
}

export function cancelDownload(jobId: string): boolean {
  const reg = activeJobs.get(jobId)
  if (reg) {
    reg.canceled = true
    try {
      reg.process?.kill('SIGKILL')
    } catch {
      /* ignore */
    }
    activeJobs.delete(jobId)
    return true
  }
  return false
}
