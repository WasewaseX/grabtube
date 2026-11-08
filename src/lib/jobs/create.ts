import { randomUUID } from "node:crypto";
import { statfsSync } from "node:fs";

import { DlError, getInfo } from "../ytdlp";
import { buildJobArgs } from "./args";
import { ensureCleanupTimer } from "./cleanup";
import { pump } from "./queue";
import { jobStore, jobsDir } from "./store";
import type { CreateJobInput, Job } from "./types";
import { ensureStallWatchdog } from "./watchdog";

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

/** Disk pre-flight: merge jobs buffer video+audio in tmp before muxing — a
 *  full disk otherwise surfaces as a cryptic ENOSPC error at 98% done. */
function ensureDiskHeadroom(): void {
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
}

export function createJob(input: CreateJobInput): Job {
  const entry = getInfo(input.infoId);
  if (!entry) throw new DlError("EXPIRED", "This video's session expired. Fetch it again.");
  ensureDiskHeadroom();

  const raw = entry.raw;
  const title = sanitizeFilename(input.title || raw.title || "video");
  const durationSec = input.duration || raw.duration || 0;
  const jobId = randomUUID();
  const built = buildJobArgs(input.mode, input, raw, jobId);

  const job: Job = {
    id: jobId,
    title,
    filename: `${title}.${built.ext}`,
    ext: built.ext,
    mime: mimeFor(built.ext),
    state: "queued",
    phase: "queue",
    progress: 0,
    speed: null,
    eta: null,
    receivedBytes: 0,
    sizeBytes: null,
    error: null,
    mode: input.mode,
    createdAt: Date.now(),
    filePath: null,
    proc: null,
    lastServeAt: null,
    engine: built.engine,
    durationSec,
  };

  const fullJob: Job = {
    ...job,
    dlKey: input.dlKey,
    webpageUrl: input.webpageUrl || raw.webpage_url,
    qualityLabel: input.qualityLabel,
    formatSpec: input.videoFormatId || input.audioFormat,
    argsBuilder: built.argsBuilder,
  };

  jobStore().set(fullJob.id, fullJob);
  ensureCleanupTimer();
  ensureStallWatchdog();
  // builder jobs resolve provider-CDN URLs (savenow) — those are not
  // IP-locked, and ffmpeg cannot speak socks5 anyway → direct egress
  fullJob.plainEgress = built.argsBuilder ? true : fullJob.plainEgress;
  // builder jobs resolve their argv lazily at pump time — a truthy empty
  // array here would spawn ffmpeg with no inputs (instant failure)
  fullJob.args = built.argsBuilder ? undefined : built.args;
  pump();

  return fullJob;
}
