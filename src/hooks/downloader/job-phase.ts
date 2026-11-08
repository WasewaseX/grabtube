import type { PublicFormat, PublicInfo } from "@/lib/ytdlp";

import { buildDlLink, delay, isAudioConversion } from "./api-client";
import { freshSample } from "./speed-sampler";
import type {
  DownloaderDeps,
  DownloadItem,
  ItemPatchFn,
  JobPoll,
  StreamTarget,
} from "./types";

interface JobRunArgs {
  fmt: PublicFormat;
  infoData: PublicInfo;
  shell: DownloadItem;
  id: string;
  overrideBitrate?: number;
  signal: AbortSignal;
}

/** Poll /api/jobs until the job is ready, errored or cancelled. */
export async function pollJobUntilDone(
  itemId: string,
  jobId: string,
  signal: AbortSignal,
  patch: ItemPatchFn,
): Promise<JobPoll> {
  for (;;) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    await delay(700);
    const res = await fetch(`/api/jobs/${jobId}`, { signal });
    const json = await res.json();
    if (!res.ok || json.error) throw new Error(json?.error?.code || "NOT_FOUND");
    let job = json.job as JobPoll;
    if (job.state === "ready") {
      // the finished file is registered in the store right after "ready"
      // — one extra poll picks up the stable token link if it raced us
      if (!job.directUrl) {
        await delay(900);
        try {
          const again = await fetch(`/api/jobs/${jobId}`, { signal });
          const j2 = await again.json();
          if (again.ok && j2?.job?.directUrl) job = j2.job as JobPoll;
        } catch {
          /* keep what we have */
        }
      }
      return job;
    }
    if (job.state === "error") throw new Error(job.error || "INTERNAL");
    if (job.state === "cancelled") throw new DOMException("Cancelled", "AbortError");
    patch(itemId, {
      state: job.state === "merging" ? "merging" : job.state === "downloading" ? "downloading" : "queued",
      received: job.receivedBytes,
      total: job.sizeBytes ?? 0,
    });
  }
}

/**
 * Build the fresh row (and its id) that appears at the top of the queue the
 * instant the user confirms a download.
 */
function buildJobShell(
  fmt: PublicFormat,
  infoData: PublicInfo,
  overrideBitrate?: number,
): { id: string; shell: DownloadItem } {
  const isConversion = isAudioConversion(fmt);
  const label = isConversion
    ? fmt.container === "mp3"
      ? `MP3 ${overrideBitrate ?? 320}`
      : fmt.container.toUpperCase()
    : `${fmt.quality} · ${fmt.container.toUpperCase()}`;
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const filename = `${infoData.title
    .slice(0, 80)
    .replace(/[\\/:*?"<>|]/g, " ")
    .trim()} (${label.replace(/[\\/:*?"<>|]/g, "-")}).${fmt.container}`;
  const shell: DownloadItem = {
    id,
    title: infoData.title,
    label,
    filename,
    ext: fmt.container,
    state: "starting",
    received: 0,
    total: fmt.filesize || 0,
    speed: 0,
    videoUrl: infoData.webpageUrl,
    thumb: infoData.thumbnail,
    directLink: buildDlLink(fmt, infoData, overrideBitrate),
  };
  return { id, shell };
}

/**
 * MIDDLEMAN FLOW — every download is a server job. The server (fast pipe +
 * WARP) pulls from YouTube FIRST; the browser or an external manager then
 * fetches the finished file from THIS app with Range/resume, so the user's
 * own connection never touches YouTube.
 */
async function runJobPipeline(deps: DownloaderDeps, args: JobRunArgs): Promise<void> {
  const { fmt, infoData, shell, id, overrideBitrate, signal } = args;
  const isMerge = fmt.needsMerge;
  const isConversion = isAudioConversion(fmt);
  const res = await fetch("/api/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      infoId: infoData.infoId,
      mode: isConversion ? "mp3" : isMerge ? "merge" : "file",
      videoFormatId: isConversion ? undefined : fmt.id,
      audioFormat: isConversion ? fmt.container : undefined,
      bitrate: isConversion ? overrideBitrate ?? 320 : undefined,
      title: infoData.title,
      webpageUrl: infoData.webpageUrl,
      quality: fmt.quality || "",
    }),
    signal,
  });
  const json = await res.json();
  if (!res.ok || json.error) throw new Error(json?.error?.code || "INTERNAL");
  const job = json.job as { id: string; sizeBytes: number | null };
  deps.patch(id, { jobId: job.id, state: "queued", total: job.sizeBytes || fmt.filesize || 0 }, true);
  const done = await deps.pollJob(id, job.id, signal);
  // the file is now STORED server-side → swap in the stable token link
  if (done.directUrl) {
    deps.patch(id, { directLink: done.directUrl, directReady: true }, true);
  }
  const fileUrl = `/api/jobs/${job.id}/file`;
  await deps.stream(
    id,
    (range) =>
      fetch(fileUrl, {
        signal,
        headers: range ? { Range: range } : undefined,
      }),
    { ...shell, directUrl: fileUrl, storedDirectUrl: done.directUrl ?? undefined },
    fmt.filesize || 0,
    signal,
  );
}

/** Create the job, poll it to completion, stream the stored file to disk. */
export async function startServerJobDownload(
  deps: DownloaderDeps,
  fmt: PublicFormat,
  infoData: PublicInfo,
  overrideBitrate?: number,
): Promise<void> {
  const { id, shell } = buildJobShell(fmt, infoData, overrideBitrate);
  const ctrl = new AbortController();
  deps.controllers.current.set(id, ctrl);
  deps.samplers.current.set(id, freshSample());
  deps.setItems((prev) => [shell, ...prev].slice(0, 12));
  try {
    await runJobPipeline(deps, { fmt, infoData, shell, id, overrideBitrate, signal: ctrl.signal });
  } catch (e) {
    const err = e as Error & { name?: string };
    if (err.name === "AbortError" || err.message === "Cancelled") {
      deps.patch(id, { state: "cancelled", speed: 0 }, true);
    } else {
      deps.patch(id, { state: "error", error: err.message || "INTERNAL", speed: 0 }, true);
      deps.onError(err.message);
    }
  } finally {
    deps.controllers.current.delete(id);
    deps.samplers.current.delete(id);
  }
}
