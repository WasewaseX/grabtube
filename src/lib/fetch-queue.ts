/**
 * Background extraction queue — cobalt-style session model.
 *
 * The egress tunnel to YouTube's innertube API degrades in multi-minute
 * phases; a blocking extraction request either eats the gateway timeout or
 * surfaces a premature error. Real web downloaders (cobalt's session flow)
 * solve this by ACKNOWLEDGING instantly and retrying server-side.
 *
 *   POST /api/info   → fast path 200 when cached; else race 25 s:
 *                      success → 200, else 202 {pending} + loop continues
 *   GET  /api/info?u → job snapshot: 200 done / 202 pending / 4xx-5xx failed
 *
 * The queue retries transient failures (bot-check phases, timeouts) on a
 * backoff schedule for up to 15 minutes — one good tunnel phase is enough.
 * Terminal states (private / live / age-restricted / bad URL) stop at once.
 */
import { DlError, hasFfmpeg, type PublicInfo } from "./ytdlp";
import { extract } from "./extract";
import { probeAll } from "./proxy";

export interface FetchJob {
  url: string;
  state: "running" | "done" | "failed";
  info?: PublicInfo;
  mp3?: boolean;
  error?: { code: string; message: string; hint?: string };
  attempts: number;
  startedAt: number;
  deadline: number;
  terminal: boolean;
  /** resolves when the job leaves "running" (done or terminal failure) —
   *  transient failures inside the retry loop do NOT fire it */
  settled?: Promise<void>;
  notify?: () => void;
}

const JOB_TTL_MS = 4 * 60 * 60 * 1000; // done results stay valid 4 h
const RETRY_BUDGET_MS = 15 * 60 * 1000; // keep retrying transient failures
const MAX_ATTEMPTS = 24;

declare global {
  var __tgFetchQueue: Map<string, FetchJob> | undefined;
}

function queue(): Map<string, FetchJob> {
  if (!globalThis.__tgFetchQueue) globalThis.__tgFetchQueue = new Map();
  return globalThis.__tgFetchQueue;
}

export function canonicalUrl(raw: string): string {
  const u = raw.trim();
  // keep youtu.be/shorts forms distinct — extract() handles them as-is
  return u;
}

/** Terminal extraction errors — retrying can never change the outcome. */
const TERMINAL_CODES = new Set([
  "INVALID_URL",
  "PRIVATE",
  "UNAVAILABLE",
  "LIVE",
  "AGE_RESTRICTED",
  "UNSUPPORTED_URL",
  "NO_FORMATS",
  "GEO_BLOCKED",
]);

function sweep(): void {
  const now = Date.now();
  for (const [k, j] of queue()) {
    if (j.state === "done" && now - j.startedAt > JOB_TTL_MS) queue().delete(k);
    if (j.state === "failed" && j.terminal && now - j.startedAt > JOB_TTL_MS) queue().delete(k);
    if (j.state === "failed" && !j.terminal && now - j.deadline > 10 * 60_000) queue().delete(k);
  }
}

async function runLoop(job: FetchJob): Promise<void> {
  while (Date.now() < job.deadline && job.attempts < MAX_ATTEMPTS) {
    job.attempts++;
    try {
      const { info } = await extract(job.url);
      job.state = "done";
      job.info = info;
      job.mp3 = hasFfmpeg();
      job.notify?.();
      return;
    } catch (e) {
      const code = e instanceof DlError ? e.code : "FETCH_FAILED";
      const message = e instanceof DlError ? e.message : "Extraction failed.";
      const hint = e instanceof DlError ? e.hint : undefined;
      if (TERMINAL_CODES.has(code)) {
        job.state = "failed";
        job.terminal = true;
        job.error = { code, message, hint };
        job.notify?.();
        return;
      }
      // transient (BOT_CHECK / RATE_LIMITED / TIMEOUT / FETCH_FAILED) —
      // re-probe lanes so a recovered tunnel is picked for the next attempt
      job.error = { code, message, hint };
      if (code === "BOT_CHECK" || code === "RATE_LIMITED") {
        await probeAll().catch(() => undefined);
      }
      // progressive backoff: 8s → 15s → 25s (cap)
      const wait = Math.min(8_000 + job.attempts * 3_000, 25_000);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  job.state = "failed";
  job.terminal = false;
  if (!job.error) job.error = { code: "TIMEOUT", message: "The engine could not reach YouTube in time." };
  job.notify?.();
}

/** Start (or attach to) the background fetch for this URL. */
export function startFetch(url: string): FetchJob {
  sweep();
  const key = canonicalUrl(url);
  const existing = queue().get(key);
  if (existing && existing.state !== "failed") return existing;
  if (existing && existing.state === "failed" && !existing.terminal && Date.now() < existing.deadline) {
    // still inside its retry budget → revive the loop
    existing.state = "running";
    void runLoop(existing);
    return existing;
  }
  const job: FetchJob = {
    url: key,
    state: "running",
    attempts: 0,
    startedAt: Date.now(),
    deadline: Date.now() + RETRY_BUDGET_MS,
    terminal: false,
  };
  job.settled = new Promise<void>((res) => {
    job.notify = res;
  });
  queue().set(key, job);
  void runLoop(job);
  return job;
}

export function pollFetch(url: string): FetchJob | null {
  sweep();
  return queue().get(canonicalUrl(url)) ?? null;
}

/** Snapshot without volatile fields. */
export function jobSnapshot(job: FetchJob): {
  state: FetchJob["state"];
  attempts: number;
  elapsedMs: number;
  info?: PublicInfo;
  mp3?: boolean;
  error?: FetchJob["error"];
} {
  return {
    state: job.state,
    attempts: job.attempts,
    elapsedMs: Date.now() - job.startedAt,
    info: job.info,
    mp3: job.mp3,
    error: job.error,
  };
}
