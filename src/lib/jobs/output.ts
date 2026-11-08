import type { ChildProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";

import { classifyStderr } from "../ytdlp";
import { jobsDir } from "./store";
import type { Job } from "./types";
import { pump, scheduleJobRetry } from "./queue";
import { registerFinishedFile } from "./files";

/** Shared "download finished" transition — identical for yt-dlp and ffmpeg. */
function markJobReady(job: Job, filePath: string): void {
  job.filePath = filePath;
  job.sizeBytes = statSync(filePath).size;
  job.state = "ready";
  job.phase = "done";
  job.progress = 1;
  job.speed = null;
  job.eta = null;
  registerFinishedFile(job);
}

export async function attachYtdlpOutput(job: Job, proc: ChildProcess): Promise<void> {
  let stderr = "";

  proc.stdout?.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) {
      const pct = line.match(/\[download\]\s+([\d.]+)%/);
      if (pct) {
        job.state = "downloading";
        job.phase = "download";
        job.lastProgressAt = Date.now();
        job.progress = Math.min(0.97, parseFloat(pct[1]) / 100);
        const spd = line.match(/at\s+([\d.]+\w*\/s)/);
        if (spd) job.speed = spd[1];
        const eta = line.match(/ETA\s+([\d:]+)/);
        if (eta) job.eta = eta[1];
      }
      if (line.includes("[Merger]") || line.includes("[ExtractAudio]")) {
        job.state = "merging";
        job.phase = "merge";
        job.progress = 0.985;
      }
    }
  });

  proc.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
    if (stderr.length > 32_000) stderr = stderr.slice(-16_000);
  });

  proc.on("error", () => {
    if (job.state === "cancelled") return;
    job.state = "error";
    job.error = "INTERNAL";
    pump();
  });

  proc.on("close", (code) => {
    if (job.state === "cancelled") return;
    if (code === 0) {
      const candidates = [job.ext, "mp4", "webm", "mkv", "m4a", "mp3"].map((e) =>
        path.join(jobsDir(), `${job.id}.${e}`),
      );
      // yt-dlp output templates used a random uuid (not job.id) → scan by ext
      const found = candidates.find((c) => existsSync(c));
      if (found) {
        markJobReady(job, found);
      } else {
        job.state = "error";
        job.error = "INTERNAL";
      }
    } else {
      const err = classifyStderr(stderr);
      if (scheduleJobRetry(job, err.code)) {
        pump();
        return;
      }
      job.state = "error";
      job.error = err.code;
      console.error(`[jobs] yt-dlp job ${job.id} failed (${err.code}): ${stderr.slice(-400).replace(/\n/g, " | ")}`);
    }
    pump();
  });
}

export async function attachFfmpegOutput(job: Job, proc: ChildProcess): Promise<void> {
  let stderr = "";

  proc.stdout?.on("data", (chunk: Buffer) => {
    // ffmpeg -progress pipe:1 emits key=value lines
    for (const line of chunk.toString().split("\n")) {
      const m = line.match(/out_time_us=(\d+)/) || line.match(/out_time_ms=(\d+)/);
      if (m && job.durationSec > 0) {
        const done = parseInt(m[1], 10) / 1_000_000;
        job.lastProgressAt = Date.now();
        job.progress = Math.min(0.98, done / job.durationSec);
        job.state = job.progress >= 0.98 ? "merging" : "downloading";
        job.phase = job.progress >= 0.98 ? "merge" : "download";
      }
      const spd = line.match(/speed=\s*([\d.]+)x/);
      if (spd) {
        const x = parseFloat(spd[1]);
        if (x > 0) job.speed = `${x.toFixed(1)}×`;
      }
      const sz = line.match(/total_size=(\d+)/);
      if (sz) job.receivedBytes = parseInt(sz[1], 10);
      const rem = line.match(/out_time=(\S+)/);
      if (rem && job.durationSec > 0) {
        const parts = rem[1].split(":").map(parseFloat);
        const done = parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : 0;
        const left = Math.max(0, Math.round(job.durationSec - done));
        job.eta = left >= 1 ? `${left}s` : "0s";
      }
    }
  });

  proc.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
    if (stderr.length > 32_000) stderr = stderr.slice(-16_000);
  });

  proc.on("error", () => {
    if (job.state === "cancelled") return;
    job.state = "error";
    job.error = "INTERNAL";
    pump();
  });

  proc.on("close", (code) => {
    if (job.state === "cancelled") return;
    if (code === 0) {
      const found = path.join(jobsDir(), `${job.id}.${job.ext}`);
      if (existsSync(found)) {
        markJobReady(job, found);
      } else {
        job.state = "error";
        job.error = "INTERNAL";
      }
    } else {
      const errCode = /403|401/.test(stderr) ? "EXPIRED" : "FETCH_FAILED";
      if (scheduleJobRetry(job, errCode)) {
        pump();
        return;
      }
      job.state = "error";
      job.error = errCode;
    }
    pump();
  });
}
