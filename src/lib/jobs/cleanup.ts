import { existsSync, rmSync } from "node:fs";

import { jobStore } from "./store";

/** finished files stay grabbable for 6h — direct links keep working long
 *  after the download started (slow networks, IDM queued overnight…) */
const JOBS_TTL_MS = 6 * 60 * 60 * 1000;
/** a file served within this window is considered actively downloading */
const ACTIVE_SERVE_MS = 10 * 60 * 1000;

export function ensureCleanupTimer(): void {
  if (globalThis.__tgJobsCleanup) return;
  globalThis.__tgJobsCleanup = setInterval(() => {
    const store = jobStore();
    const now = Date.now();
    for (const [id, job] of store) {
      const expired = now - job.createdAt > JOBS_TTL_MS;
      const dead =
        (job.state === "cancelled" || job.state === "error") && now - job.createdAt > 10 * 60 * 1000;
      // actively downloading server-side → never touch (a 2160p merge can
      // legitimately run past an hour; killing it corrupts the transfer)
      const running =
        (job.state === "downloading" || job.state === "merging") &&
        now - job.createdAt < 3 * 60 * 60 * 1000;
      // an external manager is mid-download of the finished file → keep it
      const servedRecently = job.lastServeAt != null && now - job.lastServeAt < ACTIVE_SERVE_MS;
      if ((expired && !running && !servedRecently) || dead) {
        if (job.proc) {
          try {
            job.proc.kill("SIGKILL");
          } catch {
            /* noop */
          }
        }
        // registered files (direct links) are owned by the store's eviction —
        // deleting them here would break links that are still being used
        if (job.filePath && existsSync(job.filePath) && !job.dlKey) {
          try {
            rmSync(job.filePath, { force: true });
          } catch {
            /* noop */
          }
        }
        store.delete(id);
      }
    }
  }, 60_000);
  globalThis.__tgJobsCleanup.unref();
}
