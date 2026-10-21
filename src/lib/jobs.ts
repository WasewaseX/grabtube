/**
 * Server-side download jobs.
 *
 *  • merge / mp3    – yt-dlp downloads the selected tracks (optionally merging
 *                     with ffmpeg) and reports --newline progress.
 *  • urlmerge       – ffmpeg pulls the video+audio direct URLs itself and
 *                     stream-copies them into one container. Used when the
 *                     format list came from a proxy provider (Piped/Invidious).
 *  • urlaudio       – ffmpeg pulls an audio direct URL and converts to MP3.
 *
 * Jobs write to a temp file while emitting live progress, then the client
 * streams the finished file from /api/jobs/[id]/file.
 */
import { spawn, type ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import { existsSync, mkdirSync, statSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import {
  DlError,
  baseArgs,
  getEngine,
  getInfo,
  classifyStderr,
  CLIENT_CHAIN,
  toolEnv,
} from "./ytdlp";
import { ffmpegProxyEnv } from "./proxy";

export type JobState = "queued" | "downloading" | "merging" | "ready" | "error" | "cancelled";

export interface Job {
  id: string;
  title: string;
  filename: string;
  ext: string;
  mime: string;
  state: JobState;
  phase: "queue" | "download" | "merge" | "done";
  progress: number; // 0..1
  speed: string | null;
  eta: string | null;
  receivedBytes: number;
  sizeBytes: number | null;
  error: string | null;
  mode: "merge" | "mp3" | "urlmerge" | "urlaudio";
  createdAt: number;
  filePath: string | null;
  proc: ChildProcess | null;
  args?: string[]; // pending spawn args for queued jobs
  engine: "ytdlp" | "ffmpeg";
  durationSec: number; // for ffmpeg progress math
}

declare global {
  var __tgJobs: Map<string, Job> | undefined;
  var __tgJobsCleanup: NodeJS.Timeout | undefined;
}

export function jobStore(): Map<string, Job> {
  if (!globalThis.__tgJobs) globalThis.__tgJobs = new Map();
  return globalThis.__tgJobs;
}

const MAX_CONCURRENT_JOBS = 2;
const JOBS_TTL_MS = 45 * 60 * 1000;

export function jobsDir(): string {
  const dir = path.join(tmpdir(), "tubegrab-jobs");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/* ---------------- cleanup ---------------- */
export function ensureCleanupTimer(): void {
  if (globalThis.__tgJobsCleanup) return;
  globalThis.__tgJobsCleanup = setInterval(() => {
    const store = jobStore();
    const now = Date.now();
    for (const [id, job] of store) {
      const expired = now - job.createdAt > JOBS_TTL_MS;
      const dead =
        (job.state === "cancelled" || job.state === "error") && now - job.createdAt > 10 * 60 * 1000;
      if (expired || dead) {
        if (job.proc) {
          try {
            job.proc.kill("SIGKILL");
          } catch {
            /* noop */
          }
        }
        if (job.filePath && existsSync(job.filePath)) {
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

/* ---------------- concurrency pump ---------------- */
function activeCount(): number {
  let active = 0;
  for (const job of jobStore().values()) {
    if (job.state === "downloading" || job.state === "merging") active++;
  }
  return active;
}

function pump(): void {
  const store = jobStore();
  let active = activeCount();
  for (const job of store.values()) {
    if (active >= MAX_CONCURRENT_JOBS) break;
    if (job.state === "queued" && job.args) {
      const args = job.args;
      job.args = undefined;
      active++;
      if (job.engine === "ffmpeg") spawnFfmpegJob(job, args);
      else spawnYtdlpJob(job, args);
    }
  }
}

function spawnYtdlpJob(job: Job, args: string[]): void {
  const engine = getEngine();
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
  const proc = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    // tunnel ffmpeg's https inputs through the active egress lane
    // (googlevideo URLs are IP-locked to the lane that minted them)
    env: { ...process.env, ...ffmpegProxyEnv() },
  });
  job.proc = proc;
  job.state = "downloading";
  job.phase = "download";
  void attachFfmpegOutput(job, proc);
}

/* ---------------- creation ---------------- */

export interface CreateJobInput {
  infoId: string;
  mode: "merge" | "mp3" | "urlmerge" | "urlaudio";
  videoFormatId?: string; // composite "videoId|audioId|container" for merge
  bitrate?: number;
  webpageUrl?: string;
  title?: string;
  duration?: number;
  /** direct stream URLs for urlmerge / urlaudio modes */
  urls?: { video?: string; audio?: string };
}

export function sanitizeFilename(name: string): string {
  return (
    name
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 90) || "video"
  );
}

function mimeFor(ext: string): string {
  switch (ext) {
    case "mp4":
      return "video/mp4";
    case "webm":
      return "video/webm";
    case "mkv":
      return "video/x-matroska";
    case "m4a":
      return "audio/mp4";
    case "mp3":
      return "audio/mpeg";
    default:
      return "application/octet-stream";
  }
}

export function createJob(input: CreateJobInput): Job {
  const entry = getInfo(input.infoId);
  if (!entry) throw new DlError("EXPIRED", "This video's session expired. Fetch it again.");

  const raw = entry.raw;
  const title = sanitizeFilename(input.title || raw.title || "video");
  const durationSec = input.duration || raw.duration || 0;

  const jobId = randomUUID();
  let ext: string;
  let args: string[];
  let engine: Job["engine"];
  let mode = input.mode;

  if (mode === "mp3") {
    ext = "mp3";
    engine = "ytdlp";
    const bitrate = [320, 192, 128].includes(input.bitrate || 0) ? input.bitrate : 192;
    args = [
      ...baseArgs(),
      // same client chain as extraction, or the job re-resolves on a different
      // player client and the selection breaks (format roulette)
      ...CLIENT_CHAIN[0],
      "--no-playlist",
      "--newline",
      "-f",
      "bestaudio/best",
      "-x",
      "--audio-format",
      "mp3",
      "--audio-quality",
      `${bitrate}K`,
      "-o",
      path.join(jobsDir(), `${jobId}.%(ext)s`),
      input.webpageUrl || raw.webpage_url,
    ];
  } else if (mode === "urlaudio") {
    if (!input.urls?.audio) throw new DlError("INVALID_URL", "Missing audio stream URL.");
    ext = "mp3";
    engine = "ffmpeg";
    const bitrate = [320, 192, 128].includes(input.bitrate || 0) ? input.bitrate : 192;
    const out = path.join(jobsDir(), `${randomUUID()}.mp3`);
    args = ["-y", "-i", input.urls.audio, "-vn", "-c:a", "libmp3lame", "-b:a", `${bitrate}K`, "-progress", "pipe:1", out];
  } else if (mode === "urlmerge") {
    if (!input.urls?.video || !input.urls?.audio)
      throw new DlError("INVALID_URL", "Missing stream URLs for merge.");
    const [vId, aId, container] = (input.videoFormatId || "").split("|");
    ext = ["mp4", "webm", "mkv"].includes(container) ? container : "mkv";
    engine = "ffmpeg";
    const out = path.join(jobsDir(), `${randomUUID()}.${ext}`);
    const isMp4 = ext === "mp4";
    args = [
      "-y",
      "-i",
      input.urls.video,
      "-i",
      input.urls.audio,
      "-c",
      "copy",
      ...(isMp4 ? ["-movflags", "+faststart"] : []),
      "-progress",
      "pipe:1",
      out,
    ];
    void vId;
    void aId;
  } else {
    /* mode === "merge" (yt-dlp) */
    const [vId, aId, container] = (input.videoFormatId || "").split("|");
    if (!vId || !aId || !container) throw new DlError("INVALID_URL", "Bad merge request.");
    ext = ["mp4", "webm", "mkv"].includes(container) ? container : "mkv";
    engine = "ytdlp";
    const tmpPath = path.join(jobsDir(), `${jobId}.%(ext)s`);
    // resilient selector: the exact itags first, then quality-matched
    // fallbacks — yt-dlp's client roulette means the same itag may not exist
    // on the client that answers the job's own re-resolve
    const vf = raw.formats.find((f) => f.format_id === vId);
    const h = vf?.height;
    const fps = vf?.fps;
    const qualityFallback = h
      ? `bestvideo[height<=${h}${fps ? `][fps<=${fps}` : ""}]+bestaudio/bestvideo[height<=${h}]+bestaudio`
      : "bestvideo+bestaudio";
    args = [
      ...baseArgs(),
      ...CLIENT_CHAIN[0],
      "--no-playlist",
      "--newline",
      "-f",
      `${vId}+${aId}/${qualityFallback}/bestvideo+bestaudio/best`,
      "--merge-output-format",
      ext,
      "-o",
      tmpPath,
      input.webpageUrl || raw.webpage_url,
    ];
  }

  const job: Job = {
    id: jobId,
    title,
    filename: `${title}.${ext}`,
    ext,
    mime: mimeFor(ext),
    state: "queued",
    phase: "queue",
    progress: 0,
    speed: null,
    eta: null,
    receivedBytes: 0,
    sizeBytes: null,
    error: null,
    mode,
    createdAt: Date.now(),
    filePath: null,
    proc: null,
    engine,
    durationSec,
  };

  jobStore().set(job.id, job);
  ensureCleanupTimer();
  job.args = args;
  pump();

  return job;
}

/* ---------------- progress parsing ---------------- */

async function attachYtdlpOutput(job: Job, proc: ChildProcess): Promise<void> {
  let stderr = "";

  proc.stdout?.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) {
      const pct = line.match(/\[download\]\s+([\d.]+)%/);
      if (pct) {
        job.state = "downloading";
        job.phase = "download";
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
        job.filePath = found;
        job.sizeBytes = statSync(found).size;
        job.state = "ready";
        job.phase = "done";
        job.progress = 1;
        job.speed = null;
        job.eta = null;
      } else {
        job.state = "error";
        job.error = "INTERNAL";
      }
    } else {
      const err = classifyStderr(stderr);
      job.state = "error";
      job.error = err.code;
      console.error(`[jobs] yt-dlp job ${job.id} failed (${err.code}): ${stderr.slice(-400).replace(/\n/g, " | ")}`);
    }
    pump();
  });
}

async function attachFfmpegOutput(job: Job, proc: ChildProcess): Promise<void> {
  let stderr = "";

  proc.stdout?.on("data", (chunk: Buffer) => {
    // ffmpeg -progress pipe:1 emits key=value lines
    for (const line of chunk.toString().split("\n")) {
      const m = line.match(/out_time_us=(\d+)/) || line.match(/out_time_ms=(\d+)/);
      if (m && job.durationSec > 0) {
        const done = parseInt(m[1], 10) / 1_000_000;
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
        job.filePath = found;
        job.sizeBytes = statSync(found).size;
        job.state = "ready";
        job.phase = "done";
        job.progress = 1;
        job.speed = null;
        job.eta = null;
      } else {
        job.state = "error";
        job.error = "INTERNAL";
      }
    } else {
      job.state = "error";
      job.error = /403|401/.test(stderr) ? "EXPIRED" : "FETCH_FAILED";
    }
    pump();
  });
}

/* ---------------- queries ---------------- */

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

export function markServed(id: string): void {
  const job = jobStore().get(id);
  if (!job) return;
  setTimeout(() => {
    if (job.filePath && existsSync(job.filePath)) {
      try {
        rmSync(job.filePath, { force: true });
      } catch {
        /* noop */
      }
    }
    jobStore().delete(id);
  }, 90_000);
}
