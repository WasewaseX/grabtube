import { spawn } from "node:child_process";

import { ffmpegProxyEnv, probeAll } from "../proxy";
import { DlError, getEngine, toolEnv } from "../ytdlp";
import { jobStore } from "./store";
import type { Job } from "./types";
import { attachFfmpegOutput, attachYtdlpOutput } from "./output";

const MAX_CONCURRENT_JOBS = 2;
/** auto-retries for TRANSIENT failures (tunnel stall, bot-check blip, 5xx).
 *  Terminal errors (private/unavailable/age….) never retry. */
const MAX_JOB_RETRIES = 3;
const TERMINAL_JOB_CODES = new Set([
  "PRIVATE",
  "UNAVAILABLE",
  "LIVE",
  "AGE_RESTRICTED",
  "UNSUPPORTED_URL",
  "INVALID_URL",
  "EXPIRED",
  "DISK_FULL",
  "NO_FORMATS",
  "GEO_BLOCKED",
  "CANCELLED",
]);

function activeCount(): number {
  let active = 0;
  for (const job of jobStore().values()) {
    if (job.state === "downloading" || job.state === "merging") active++;
  }
  return active;
}

export function pump(): void {
  const store = jobStore();
  let active = activeCount();
  for (const job of store.values()) {
    if (active >= MAX_CONCURRENT_JOBS) break;
    if (job.state !== "queued") continue;
    if (job.args) {
      const args = job.args;
      job.args = undefined;
      active++;
      if (job.engine === "ffmpeg") spawnFfmpegJob(job, args);
      else spawnYtdlpJob(job, args);
    } else if (job.argsBuilder && !job.resolving) {
      // lazy URL resolution (community-mirror formats) — async pre-spawn step
      job.resolving = true;
      job.lastProgressAt = Date.now();
      void job
        .argsBuilder()
        .then((built) => {
          job.resolving = false;
          if (built && built.length > 0) {
            job.args = built;
          } else {
            job.state = "error";
            job.error = "MIRROR_FAILED";
            console.error(`[jobs] job ${job.id} mirror resolution returned nothing`);
          }
        })
        .catch((e: unknown) => {
          job.resolving = false;
          const code = e instanceof DlError ? e.code : "MIRROR_FAILED";
          if (scheduleJobRetry(job, code)) return;
          job.state = "error";
          job.error = code;
          console.error(`[jobs] job ${job.id} mirror resolution failed: ${code}`);
        })
        .finally(() => pump());
      active++;
    }
  }
}

function spawnYtdlpJob(job: Job, args: string[]): void {
  const engine = getEngine();
  job.lastArgs = args;
  job.lastProgressAt = Date.now();
  const proc = spawn(engine.cmd, [...engine.baseArgs, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    // deno (JS-challenge solver) + venv binaries must be on PATH or YouTube
    // answers with an image-only format list
    env: toolEnv(),
  });
  job.proc = proc;
  job.state = "downloading";
  job.phase = "download";
  void attachYtdlpOutput(job, proc);
}

function spawnFfmpegJob(job: Job, args: string[]): void {
  job.lastArgs = args;
  job.lastProgressAt = Date.now();
  const proc = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    // tunnel ffmpeg's https inputs through the active egress lane
    // (googlevideo URLs are IP-locked to the lane that minted them);
    // provider-CDN inputs (savenow) are NOT ip-locked → direct egress
    env: job.plainEgress ? { ...process.env } : { ...process.env, ...ffmpegProxyEnv() },
  });
  job.proc = proc;
  job.state = "downloading";
  job.phase = "download";
  void attachFfmpegOutput(job, proc);
}

/**
 * Re-queue a job that died from a TRANSIENT error: re-probe the egress lane
 * and let yt-dlp RESUME the .part file. Terminal errors never retry.
 */
export function scheduleJobRetry(job: Job, errCode: string): boolean {
  if (TERMINAL_JOB_CODES.has(errCode)) return false;
  if ((job.retries ?? 0) >= MAX_JOB_RETRIES) return false;
  // builder jobs re-resolve lazily — they don't need lastArgs
  if ((!job.lastArgs || job.lastArgs.length === 0) && !job.argsBuilder) return false;
  job.retries = (job.retries ?? 0) + 1;
  job.state = "queued";
  job.phase = "queue";
  job.progress = 0;
  job.error = null;
  job.speed = null;
  job.eta = null;
  job.createdAt = Date.now(); // reset the TTL clock for the new attempt
  console.log(
    `[jobs] job ${job.id} transient failure (${errCode}) — retry ${job.retries}/${MAX_JOB_RETRIES}`,
  );
  const delay = 4_000 * job.retries;
  setTimeout(() => {
    // re-probe lanes so a recovered tunnel is active before the retry spawns
    void probeAll().finally(() => {
      job.args = job.lastArgs;
      pump();
    });
  }, delay);
  return true;
}
