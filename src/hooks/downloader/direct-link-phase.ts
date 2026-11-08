import { formatBytes } from "@/lib/format-utils";
import type { PublicFormat, PublicInfo } from "@/lib/ytdlp";
import { toast } from "sonner";

import { buildDlLink, delay, isAudioConversion } from "./api-client";
import type { DownloaderDeps, DownloadItem } from "./types";

interface ResolveSpec {
  url: string;
  format: string;
  quality: string;
  bitrate?: number;
  title: string;
}

/** Context of a direct-link tracking row while the server fetches the file. */
interface DirectTrack {
  id: string;
  label: string;
  fmt: PublicFormat;
  infoData: PublicInfo;
  jobId: string;
  spec: ResolveSpec;
}

function buildResolveSpec(
  fmt: PublicFormat,
  infoData: PublicInfo,
  overrideBitrate?: number,
): ResolveSpec {
  const isConversion = isAudioConversion(fmt);
  return {
    url: infoData.webpageUrl,
    format: isConversion ? fmt.container : fmt.id,
    quality: fmt.quality || "",
    bitrate: isConversion && fmt.container === "mp3" ? overrideBitrate ?? 320 : undefined,
    title: infoData.title,
  };
}

/** The file is already stored: copy the stable token link to the clipboard. */
function copyReadyLink(json: { directUrl: string; sizeBytes?: number }): void {
  const abs = `${window.location.origin}${json.directUrl}`;
  void navigator.clipboard?.writeText(abs).catch(() => undefined);
  toast.success("Direct link copied", {
    description: `Stored on the YouWee server (${formatBytes(json.sizeBytes || 0)}) — downloads from here with full resume support. Paste it in IDM, aria2 or any browser.`,
  });
}

function buildTrackingRow(
  fmt: PublicFormat,
  infoData: PublicInfo,
  label: string,
  id: string,
  jobId?: string,
  overrideBitrate?: number,
): DownloadItem {
  return {
    id,
    title: infoData.title,
    label,
    filename: `${infoData.title.slice(0, 80)} (${label}).${fmt.container}`,
    ext: fmt.container,
    state: "queued",
    received: 0,
    total: fmt.filesize || 0,
    speed: 0,
    jobId,
    videoUrl: infoData.webpageUrl,
    thumb: infoData.thumbnail,
    directLink: buildDlLink(fmt, infoData, overrideBitrate),
  };
}

/** Poll the server job; record the stable link on the row once stored. */
async function awaitDirectCompletion(
  deps: DownloaderDeps,
  track: DirectTrack,
  signal: AbortSignal,
): Promise<void> {
  const { id, label, fmt, infoData } = track;
  const done = await deps.pollJob(id, track.jobId, signal);
  if (!done.directUrl) {
    deps.patch(id, { state: "done", total: done.sizeBytes ?? 0 }, true);
    return;
  }
  deps.patch(
    id,
    { state: "done", directLink: done.directUrl, directReady: true, total: done.sizeBytes ?? 0 },
    true,
  );
  deps.pushHistory({
    id: `${Date.now()}-${label}`,
    title: infoData.title,
    thumb: infoData.thumbnail || "",
    label,
    ext: fmt.container,
    size: done.sizeBytes ?? 0,
    at: Date.now(),
    videoUrl: infoData.webpageUrl,
    directUrl: done.directUrl,
  });
  toast.success("Direct link is ready", {
    description: "The file is stored on the server — grab it from the row below (Copy direct link).",
  });
}

/** Warm-up still resolving (no job yet) → re-post the spec to the resolver. */
async function awaitWarmupResolve(
  deps: DownloaderDeps,
  track: DirectTrack,
  signal: AbortSignal,
): Promise<void> {
  for (;;) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    await delay(2500);
    const res = await fetch("/api/dl-resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(track.spec),
      signal,
    });
    const json = await res.json();
    if (json.status === "ready" && json.directUrl) {
      deps.patch(
        track.id,
        { state: "done", directLink: json.directUrl, directReady: true, total: json.sizeBytes ?? 0 },
        true,
      );
      toast.success("Direct link is ready", {
        description: "The file is stored on the server — grab it from the row below (Copy direct link).",
      });
      return;
    }
    if (json.status === "failed") throw new Error(json.code || "INTERNAL");
  }
}

/**
 * The server has started fetching the file: add a tracking row to the
 * queue and follow it until the stable link shows up (or it fails).
 */
async function trackDirectJob(
  deps: DownloaderDeps,
  fmt: PublicFormat,
  infoData: PublicInfo,
  json: { jobId?: string },
  spec: ResolveSpec,
  overrideBitrate?: number,
): Promise<void> {
  const isConversion = isAudioConversion(fmt);
  const label = isConversion
    ? fmt.container.toUpperCase()
    : `${fmt.quality} · ${fmt.container.toUpperCase()}`;
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ctrl = new AbortController();
  deps.controllers.current.set(id, ctrl);
  const track: DirectTrack = { id, label, fmt, infoData, jobId: json.jobId || "", spec };
  deps.setItems((prev) =>
    [
      buildTrackingRow(fmt, infoData, label, id, json.jobId || undefined, overrideBitrate),
      ...prev,
    ].slice(0, 12),
  );
  toast.info("Fetching on the server first…", {
    description:
      "The file is being downloaded to YouWee's server at full speed. The direct link appears on the row below as soon as it's stored.",
  });
  try {
    if (json.jobId) {
      await awaitDirectCompletion(deps, track, ctrl.signal);
    } else {
      await awaitWarmupResolve(deps, track, ctrl.signal);
    }
  } catch (e) {
    const err = e as Error & { name?: string };
    if (err.name === "AbortError") {
      deps.patch(id, { state: "cancelled" }, true);
    } else {
      deps.patch(id, { state: "error", error: err.message }, true);
      deps.onError(err.message);
    }
  } finally {
    deps.controllers.current.delete(id);
  }
}

/**
 * "Direct link" hands out a link only once the file is ON THE SERVER: a
 * ready file copies the stable /api/file/<token> link instantly; otherwise
 * the server downloads it first and the stable link shows up on the
 * tracking row the moment the file is stored.
 */
export async function requestDirectLink(
  deps: DownloaderDeps,
  fmt: PublicFormat,
  infoData: PublicInfo,
  overrideBitrate?: number,
): Promise<void> {
  const spec = buildResolveSpec(fmt, infoData, overrideBitrate);
  try {
    const res = await fetch("/api/dl-resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(spec),
    });
    const json = await res.json();
    if (json.status === "ready" && json.directUrl) {
      copyReadyLink(json);
      return;
    }
    if (json.status === "busy") {
      await trackDirectJob(deps, fmt, infoData, json, spec, overrideBitrate);
      return;
    }
    deps.onError(json.code || "INTERNAL");
  } catch {
    deps.onNetworkError();
  }
}
