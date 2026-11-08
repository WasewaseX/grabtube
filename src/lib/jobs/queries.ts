import { existsSync, rmSync } from "node:fs";

import { pump } from "./queue";
import { jobStore } from "./store";
import type { Job } from "./types";

export function publicJob(job: Job) {
  return {
    id: job.id,
    title: job.title,
    filename: job.filename,
    ext: job.ext,
    state: job.state,
    phase: job.phase,
    progress: job.progress,
    speed: job.speed,
    eta: job.eta,
    receivedBytes: job.receivedBytes,
    sizeBytes: job.sizeBytes,
    error: job.error,
    mode: job.mode,
    directUrl: job.directToken ? `/api/file/${job.directToken}` : null,
  };
}

export function cancelJob(id: string): boolean {
  const job = jobStore().get(id);
  if (!job) return false;
  if (job.proc) {
    try {
      job.proc.kill("SIGKILL");
    } catch {
      /* noop */
    }
  }
  job.state = "cancelled";
  if (job.filePath && existsSync(job.filePath)) {
    try {
      rmSync(job.filePath, { force: true });
    } catch {
      /* noop */
    }
  }
  pump();
  return true;
}

export function jobFilePath(id: string): { path: string; job: Job } | null {
  const job = jobStore().get(id);
  if (!job || job.state !== "ready" || !job.filePath || !existsSync(job.filePath)) return null;
  return { path: job.filePath, job };
}

/**
 * Touch the job's serve timestamp — files are NOT deleted after serving;
 * external managers resume with Range for hours (TTL cleaner runs later).
 */
export function markServed(id: string): void {
  const job = jobStore().get(id);
  if (job) job.lastServeAt = Date.now();
}
