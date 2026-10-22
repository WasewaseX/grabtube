/**
 * Server-side download jobs — the MIDDLEMAN engine.
 *
 * The server (fast datacenter pipe + WARP egress) always downloads from
 * YouTube FIRST, at full speed. The user's browser/downloader then pulls the
 * finished file from this server with Range/resume support — YouTube is never
 * involved in the user's own connection (crucial for slow/censored networks).
 *
 *  • merge / mp3    – yt-dlp downloads the selected tracks (optionally merging
 *                     with ffmpeg) and reports --newline progress.
 *  • file           – yt-dlp downloads ONE format (muxed video or native
 *                     audio) server-side. Used for "instant" formats so the
 *                     user never live-streams from YouTube through the app.
 *  • urlmerge       – ffmpeg pulls the video+audio direct URLs itself and
 *                     stream-copies them into one container. Used when the
 *                     format list came from a proxy provider (Piped/Invidious).
 *  • urlaudio       – ffmpeg pulls an audio direct URL and converts to MP3.
 *  • urlfile        – ffmpeg pulls a single direct URL and remuxes to the
 *                     target container (proxy-source instant formats).
 *
 * Jobs write to a temp file while emitting live progress, then the client
 * streams the finished file from /api/jobs/[id]/file. Finished files are kept
 * for hours (touch-extended while actively being downloaded) so slow
 * connections can pause/resume and external managers can re-hit the link.
 */
import { spawn, type ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import { existsSync, mkdirSync, statSync, rmSync, statfsSync, renameSync, copyFileSync } from "fs";
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
import { ffmpegProxyEnv, probeAll } from "./proxy";
import { registerStoredFile } from "./store";

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
  mode: "merge" | "mp3" | "urlmerge" | "urlaudio" | "file" | "urlfile";
  createdAt: number;
  filePath: string | null;
  proc: ChildProcess | null;
  /** last time a client pulled (or resumed) this job's file — keeps the
   *  cleanup away from files an external manager is still downloading */
  lastServeAt: number | null;
  args?: string[]; // pending spawn args for queued jobs
  engine: "ytdlp" | "ffmpeg";
  durationSec: number; // for ffmpeg progress math
  /** StoredFile lookupKey — set for direct-link jobs; finished files are
   *  registered in the store (persistent, disk-only serving via token) */
  dlKey?: string;
  webpageUrl?: string;
  qualityLabel?: string;
  formatSpec?: string;
  /** set once the finished file is registered in the store → /api/file/<token> */
  directToken?: string;
  /** transient-failure auto-retries used (self-healing, like real download
   *  managers: tunnel stalls / bot blips re-queue instead of dying) */
  retries?: number;
  /** args of the last spawn — kept so a retry can re-queue identically
   *  (yt-dlp then RESUMES the .part file instead of restarting) */
  lastArgs?: string[];
  /** last time the transfer made byte progress — the stall watchdog kills
   *  wedged processes (frozen sockets that never time out) so the retry
   *  resumes from the .part file */
  lastProgressAt?: number;
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
/** finished files stay grabbable for 6h — direct links keep working long
 *  after the download started (slow networks, IDM queued overnight…) */
const JOBS_TTL_MS = 6 * 60 * 60 * 1000;
/** a file served within this window is considered actively downloading */
const ACTIVE_SERVE_MS = 10 * 60 * 1000;
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

/* ---------------- stall watchdog ---------------- */

/**
 * WEDGE KILLER — the one failure mode yt-dlp cannot self-heal: through a
 * lossy tunnel a fragment socket occasionally freezes in a read that never
 * trips the socket timeout (data trickles byte-wise). The process then sits
 * "downloading" forever with a frozen .part file. Real download managers
 * solve this with a stall watchdog: no byte progress for N minutes → kill
 * the process → the close handler re-queues the job (transient) and the
 * retry RESUMES from the .part file. Bytes already fetched are never lost.
 */
const STALL_KILL_MS = 4 * 60 * 1000; // no byte movement for 4 min → wedge
const HARD_CAP_MS = 60 * 60 * 1000; // 1h without finishing → re-queue

function ensureStallWatchdog(): void {
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

declare global {
  var __tgJobsWatchdog: NodeJS.Timeout | undefined;
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
  mode: "merge" | "mp3" | "urlmerge" | "urlaudio" | "file" | "urlfile";
  videoFormatId?: string; // composite "videoId|audioId|container" for merge; single itag for file
  bitrate?: number;
  /** target container for audio-conversion jobs (mp3/m4a/opus/flac/wav) */
  audioFormat?: string;
  webpageUrl?: string;
  title?: string;
  duration?: number;
  /** direct stream URLs for urlmerge / urlaudio modes */
  urls?: { video?: string; audio?: string };
  /** StoredFile lookupKey — direct-link jobs register their finished file */
  dlKey?: string;
  qualityLabel?: string;
  formatSpec?: string;
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

  // disk pre-flight: merge jobs buffer video+audio in tmp before muxing — a
  // full disk otherwise surfaces as a cryptic ENOSPC error at 98% done
  try {
    const s = statfsSync(jobsDir());
    const freeBytes = s.bsize * s.bavail;
    if (freeBytes < 1.2 * 1024 * 1024 * 1024) {
      throw new DlError(
        "DISK_FULL",
        "Server disk is almost full — clear finished downloads (or old job files) and try again.",
      );
    }
  } catch (e) {
    if (e instanceof DlError) throw e;
    /* statfs unavailable — skip the guard */
  }

  const raw = entry.raw;
  const title = sanitizeFilename(input.title || raw.title || "video");
  const durationSec = input.duration || raw.duration || 0;

  const jobId = randomUUID();
  let ext: string;
  let args: string[];
  let engine: Job["engine"];
  let mode = input.mode;

  if (mode === "mp3") {
    // mode "mp3" covers every audio conversion target (mp3/m4a/opus/flac/wav)
    const target = ["mp3", "m4a", "opus", "flac", "wav"].includes(input.audioFormat ?? "")
      ? (input.audioFormat as string)
      : "mp3";
    ext = target;
    engine = "ytdlp";
    const bitrate = [320, 192, 128].includes(input.bitrate || 0) ? input.bitrate : 320;
    args = [
      ...baseArgs(),
      // same client chain as extraction, or the job re-resolves on a different
      // player client and the selection breaks (format roulette)
      ...CLIENT_CHAIN[0],
      "--no-playlist",
      "--newline",
      "-N",
      "8",
      "-f",
      "bestaudio/best",
      "-x",
      "--audio-format",
      target,
      // lossless/pcm targets ignore quality; mp3 uses the chosen bitrate,
      // everything else re-encodes at the best sensible preset (0)
      "--audio-quality",
      target === "mp3" ? `${bitrate}K` : "0",
      "-o",
      path.join(jobsDir(), `${jobId}.%(ext)s`),
      input.webpageUrl || raw.webpage_url,
    ];
  } else if (mode === "file") {
    // single-format server-side download (muxed video / native audio) —
    // "instant" formats go through this too so the user NEVER live-streams
    // from YouTube through the app; they always pull a local, resumable file
    const fmtId = (input.videoFormatId || "").split("|")[0];
    if (!fmtId) throw new DlError("INVALID_URL", "Missing format id.");
    const stored = raw.formats.find((f) => f.format_id === fmtId);
    ext = (stored?.ext || "mp4").toLowerCase();
    engine = "ytdlp";
    args = [
      ...baseArgs(),
      ...CLIENT_CHAIN[0],
      "--no-playlist",
      "--newline",
      "-N",
      "8",
      "-f",
      `${fmtId}/best`,
      "-o",
      path.join(jobsDir(), `${jobId}.%(ext)s`),
      input.webpageUrl || raw.webpage_url,
    ];
  } else if (mode === "urlfile") {
    // proxy-provider single stream → ffmpeg remux into the target container
    if (!input.urls?.video) throw new DlError("INVALID_URL", "Missing stream URL.");
    const fmtId = (input.videoFormatId || "").split("|")[0];
    const stored = raw.formats.find((f) => f.format_id === fmtId);
    ext = (stored?.ext || "mp4").toLowerCase();
    engine = "ffmpeg";
    const out = path.join(jobsDir(), `${randomUUID()}.${ext}`);
    const isMp4 = ext === "mp4";
    args = [
      "-y",
      "-i",
      input.urls.video,
      "-c",
      "copy",
      ...(isMp4 ? ["-movflags", "+faststart"] : []),
      "-progress",
      "pipe:1",
      out,
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
      "-N",
      "8",
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
    lastServeAt: null,
    engine,
    durationSec,
  };

  const fullJob: Job = {
    ...job,
    dlKey: input.dlKey,
    webpageUrl: input.webpageUrl || raw.webpage_url,
    qualityLabel: input.qualityLabel,
    formatSpec: input.videoFormatId || input.audioFormat,
  };

  jobStore().set(fullJob.id, fullJob);
  ensureCleanupTimer();
  ensureStallWatchdog();
  fullJob.args = args;
  pump();

  return fullJob;
}

/**
 * Direct-link jobs: persist the finished file into the StoredFile registry
 * (async, non-blocking). Once registered, /api/file/<token> serves the LOCAL
 * file forever (until eviction) — that token is pinned onto the job so poll
 * clients pick it up.
 *
 * The finished file is FIRST moved out of /tmp (tmp cleaners would break
 * every stored link at once) into the durable downloads/ directory — the
 * "database" the direct links point at. Only then is it registered.
 */
function persistentDownloadsPath(filename: string): string {
  const dir = "/home/z/my-project/downloads";
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  } catch {
    return path.join(jobsDir(), filename); // fall back to the tmp location
  }
  let target = path.join(dir, filename);
  const ext = path.extname(filename);
  const base = filename.slice(0, filename.length - ext.length);
  for (let i = 2; existsSync(target); i++) {
    target = path.join(dir, `${base} (${i})${ext}`);
  }
  return target;
}

function moveIntoDownloads(job: Job): void {
  if (!job.filePath || !existsSync(job.filePath)) return;
  const target = persistentDownloadsPath(job.filename);
  if (target === job.filePath) return;
  try {
    try {
      renameSync(job.filePath, target); // fast path: same filesystem
    } catch {
      // cross-device (different mount) → copy + delete
      copyFileSync(job.filePath, target);
      rmSync(job.filePath, { force: true });
    }
    job.filePath = target;
  } catch {
    /* move failed — register the tmp file anyway; self-heal re-fetches */
  }
}

function registerFinishedFile(job: Job): void {
  if (!job.dlKey || !job.filePath) return;
  moveIntoDownloads(job);
  void registerStoredFile({
    lookupKey: job.dlKey,
    filePath: job.filePath,
    filename: job.filename,
    mime: job.mime,
    kind: job.mode === "mp3" ? "audio" : "video",
    quality: job.qualityLabel,
    title: job.title,
    webpageUrl: job.webpageUrl,
    formatSpec: job.formatSpec,
  }).then((info) => {
    if (info) {
      job.directToken = info.token;
      console.log(`[jobs] file registered → /api/file/${info.token} (${job.filename})`);
    }
  });
}

/* ---------------- self-healing retry ---------------- */

/**
 * Re-queue a job that died from a TRANSIENT error. The egress lane is
 * re-probed first (a recovered tunnel gets picked for the retry) and yt-dlp
 * resumes the .part file it already wrote — no bytes re-downloaded.
 * Terminal errors (private video, age gate, bad URL…) never retry.
 */
function scheduleJobRetry(job: Job, errCode: string): boolean {
  if (TERMINAL_JOB_CODES.has(errCode)) return false;
  if ((job.retries ?? 0) >= MAX_JOB_RETRIES) return false;
  if (!job.lastArgs || job.lastArgs.length === 0) return false;
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

/* ---------------- progress parsing ---------------- */

async function attachYtdlpOutput(job: Job, proc: ChildProcess): Promise<void> {
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
        job.filePath = found;
        job.sizeBytes = statSync(found).size;
        job.state = "ready";
        job.phase = "done";
        job.progress = 1;
        job.speed = null;
        job.eta = null;
        registerFinishedFile(job);
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

async function attachFfmpegOutput(job: Job, proc: ChildProcess): Promise<void> {
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
        job.filePath = found;
        job.sizeBytes = statSync(found).size;
        job.state = "ready";
        job.phase = "done";
        job.progress = 1;
        job.speed = null;
        job.eta = null;
        registerFinishedFile(job);
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
 * Touch the job's serve timestamp. Files are NO LONGER deleted shortly after
 * serving — external download managers on slow networks may take hours and
 * resume with Range requests; deleting under them breaks the transfer.
 * The TTL cleaner removes files hours later (extend-aware, see cleanup).
 */
export function markServed(id: string): void {
  const job = jobStore().get(id);
  if (job) job.lastServeAt = Date.now();
}
