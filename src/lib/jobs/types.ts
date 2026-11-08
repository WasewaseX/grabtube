import type { ChildProcess } from "node:child_process";

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
  /** lazy spawn-args builder — provider formats whose real URL only exists
   *  after an async resolution step (savenow community mirror) resolve at
   *  pump time instead of creation time */
  argsBuilder?: () => Promise<string[] | null>;
  /** resolver/spawn currently running for a builder job (anti double-fire) */
  resolving?: boolean;
  /** true when every input URL is provider-hosted (savenow CDN) — no WARP
   *  proxying needed for ffmpeg; direct egress is faster and not IP-locked */
  plainEgress?: boolean;
}

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
