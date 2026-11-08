import { jobStore } from "./store";

/**
 * WEDGE KILLER — yt-dlp cannot self-heal a fragment socket frozen in a read
 * that never trips its timeout: kill it; the retry RESUMES the .part file.
 */
const STALL_KILL_MS = 4 * 60 * 1000; // no byte movement for 4 min → wedge
const HARD_CAP_MS = 60 * 60 * 1000; // 1h without finishing → re-queue

declare global {
  var __tgJobsWatchdog: NodeJS.Timeout | undefined;
}

export function ensureStallWatchdog(): void {
  if (globalThis.__tgJobsWatchdog) return;
  globalThis.__tgJobsWatchdog = setInterval(() => {
    const now = Date.now();
    for (const job of jobStore().values()) {
      if (job.state !== "downloading" && job.state !== "merging") continue;
      const started = job.lastProgressAt ?? job.createdAt;
      const stalled = now - started > STALL_KILL_MS && (job.progress > 0 || job.receivedBytes > 0);
      const overCap = now - started > HARD_CAP_MS;
      if (!stalled && !overCap) continue;
      console.log(
        `[jobs] job ${job.id} watchdog: ${stalled ? "stalled" : "over cap"} — killing for resume-retry`,
      );
      job.lastProgressAt = now; // avoid double-fire while the close event lands
      try {
        job.proc?.kill("SIGKILL");
      } catch {
        /* noop */
      }
    }
  }, 30_000);
  globalThis.__tgJobsWatchdog.unref();
}
