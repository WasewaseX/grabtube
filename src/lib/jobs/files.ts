import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";

import { registerStoredFile } from "../store";
import { jobsDir } from "./store";
import type { Job } from "./types";

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

/**
 * Direct-link jobs: register the finished file in the StoredFile registry so
 * /api/file/<token> serves the local file (moved out of /tmp) until eviction.
 */
export function registerFinishedFile(job: Job): void {
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
