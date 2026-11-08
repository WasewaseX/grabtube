import type { RefObject } from "react";
import type { PublicFormat, PublicInfo } from "@/lib/ytdlp";

export type ItemState =
  | "starting"
  | "queued"
  | "downloading"
  | "merging"
  | "saving"
  | "done"
  | "error"
  | "cancelled";

export interface DownloadItem {
  id: string;
  title: string;
  label: string;
  filename: string;
  ext: string;
  state: ItemState;
  received: number;
  total: number;
  speed: number; // bytes/sec
  error?: string;
  jobId?: string;
  /** direct link for external download managers. Once the server-side file
   *  is fully downloaded & stored this is the STABLE /api/file/<token> link
   *  (serves the stored file with resume support, never YouTube); before
   *  that it is the /api/dl resolve link (fetch-first → 503 until stored). */
  directLink?: string;
  /** true once directLink points at the stable stored-file token */
  directReady?: boolean;
  videoUrl?: string; // for history
  thumb?: string;
}

export interface HistoryEntry {
  id: string;
  title: string;
  thumb: string;
  label: string;
  ext: string;
  size: number;
  at: number;
  videoUrl: string;
  /** stable stored-file link (/api/file/<token>) while it exists */
  directUrl?: string;
}

/** UI lifecycle of the extraction phase (url → info card). */
export type InfoPhase = "idle" | "loading" | "ready" | "error";

/** Patch one download row by id; `force` hints bypassing render throttles. */
export type ItemPatchFn = (id: string, patch: Partial<DownloadItem>, force?: boolean) => void;

/** Prepend/replace rows in the download queue. */
export type ItemsSetter = (updater: (prev: DownloadItem[]) => DownloadItem[]) => void;

/** Progress snapshot of a server job, as returned by /api/jobs polling. */
export interface JobPoll {
  state: string;
  phase: string;
  progress: number;
  speed: string | null;
  receivedBytes: number;
  sizeBytes: number | null;
  error: string | null;
  directUrl?: string | null;
}

/** Long-poll one server job until ready/error/cancelled. */
export type JobPollFn = (itemId: string, jobId: string, signal: AbortSignal) => Promise<JobPoll>;

/** Stream one stored file to disk with auto-resume. */
export type StreamFn = (
  itemId: string,
  open: (range?: string) => Promise<Response>,
  item: StreamTarget,
  expectedTotal: number,
  signal: AbortSignal,
) => Promise<void>;

/** Kick off a server download or a direct-link request. */
export type DownloadStartFn = (
  fmt: PublicFormat,
  infoData: PublicInfo,
  overrideBitrate?: number,
) => Promise<void>;

/** What streamToDisk needs to know about the file it is writing. */
export interface StreamTarget {
  filename: string;
  ext: string;
  label: string;
  title: string;
  videoUrl?: string;
  thumb?: string;
  /** native-download fallback for browsers without the File System Access API */
  directUrl?: string;
  /** stable /api/file/<token> link once the file is stored server-side */
  storedDirectUrl?: string;
}

/** Rolling EMA speed sample kept per download row. */
export interface SpeedSample {
  lastT: number;
  lastB: number;
  ema: number;
  lastRender: number;
}

/** Everything a download phase needs from the owning hook instance. */
export interface DownloaderDeps {
  patch: ItemPatchFn;
  setItems: ItemsSetter;
  pollJob: JobPollFn;
  stream: StreamFn;
  pushHistory: (entry: HistoryEntry) => void;
  /** abort controllers per download row (ref read at call time) */
  controllers: RefObject<Map<string, AbortController>>;
  /** speed samples per download row (ref read at call time) */
  samplers: RefObject<Map<string, SpeedSample>>;
  /** toast.error(t("downloadFailed"), { description: t(errorKey(message)) }) */
  onError: (message: string) => void;
  /** toast.error(t("downloadFailed"), { description: "Network error" }) */
  onNetworkError: () => void;
}
