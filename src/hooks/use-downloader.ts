"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import type { PublicFormat, PublicInfo } from "@/lib/ytdlp";
import { formatBytes } from "@/lib/format-utils";
import { errorKey } from "@/lib/i18n";
import { useLang } from "./use-lang";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

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

const HISTORY_KEY = "tubegrab.history.v1";

/**
 * Honest status ladder for the extraction poll. The server cycles through
 * yt-dlp → Piped/Invidious mirrors → the community-mirror backend on every
 * attempt; the copy reflects what actually happens at each stage instead of
 * a vague "busy" line.
 */
function pendingStatus(attempts: number, elapsedMs: number): string {
  if (attempts <= 1) return "Connecting to YouTube…";
  if (attempts <= 3) return `YouTube is throttling this route — retrying (attempt ${attempts})…`;
  if (elapsedMs > 180_000)
    return `Still working — the mirror farm is preparing your file (attempt ${attempts})…`;
  return `YouTube blocked us — community mirrors engaged (attempt ${attempts})…`;
}

/* ------------------------------------------------------------------ */
/* File-system access helpers                                          */
/* ------------------------------------------------------------------ */

type SavePicker = (opts: {
  suggestedName: string;
  types: Array<{ description: string; accept: Record<string, string[]> }>;
}) => Promise<FileSystemFileHandle>;

async function openWritable(
  filename: string,
  mime: string,
  ext: string,
): Promise<FileSystemWritableFileStream | null> {
  const w = window as unknown as { showSaveFilePicker?: SavePicker };
  // automation/headless environments can't render the native picker → blob path
  const automated = typeof navigator !== "undefined" && navigator.webdriver === true;
  if (!w.showSaveFilePicker || automated) return null;
  try {
    const handle = await w.showSaveFilePicker({
      suggestedName: filename,
      types: [{ description: `${ext.toUpperCase()} file`, accept: { [mime]: [`.${ext}`] } }],
    });
    return await handle.createWritable();
  } catch (e) {
    const name = (e as DOMException)?.name;
    if (name === "AbortError") throw e; // user cancelled → abort whole download
    return null; // permission/iframe issue → blob fallback
  }
}

function mimeForExt(ext: string): string {
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

/**
 * Build the /api/dl resolve link for a selection (pre-store fallback).
 * When a download manager (or browser) hits it, the SERVER downloads the
 * file fully first (answering 503 + Retry-After meanwhile), then serves the
 * finished file with Range/resume — the client never touches YouTube.
 */
export function buildDlLink(
  fmt: PublicFormat,
  info: PublicInfo,
  bitrate?: number,
): string {
  const isConversion =
    fmt.kind === "audio" &&
    (fmt.id === "convert" || ["mp3", "flac", "wav"].includes(fmt.container));
  const f = isConversion ? fmt.container : fmt.id;
  const qs = new URLSearchParams({
    u: info.webpageUrl,
    f,
    q: fmt.quality || "",
    t: info.title || "",
  });
  if (isConversion && fmt.container === "mp3") qs.set("b", String(bitrate ?? 320));
  return `/api/dl?${qs.toString()}`;
}

/* ------------------------------------------------------------------ */
/* Hook                                                                */
/* ------------------------------------------------------------------ */

export function useDownloader() {
  const { t } = useLang();

  const [url, setUrl] = useState("");
  const [phase, setPhase] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [pendingNote, setPendingNote] = useState<string | null>(null);
  const [info, setInfo] = useState<PublicInfo | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [items, setItems] = useState<DownloadItem[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);

  const controllers = useRef(new Map<string, AbortController>());
  const samplers = useRef(
    new Map<string, { lastT: number; lastB: number; ema: number; lastRender: number }>(),
  );

  // Load persisted history AFTER hydration — reading localStorage during render
  // makes the first client render differ from the server HTML (hydration error).
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(HISTORY_KEY);
      if (raw) setHistory(JSON.parse(raw) as HistoryEntry[]);
    } catch {
      /* ignore */
    }
  }, []);

  const pushHistory = useCallback((entry: HistoryEntry) => {
    setHistory((prev) => {
      const next = [entry, ...prev].slice(0, 20);
      try {
        window.localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  const clearHistory = useCallback(() => {
    setHistory([]);
    try {
      window.localStorage.removeItem(HISTORY_KEY);
    } catch {
      /* ignore */
    }
  }, []);

  const patchItem = useCallback((id: string, patch: Partial<DownloadItem>, force = false) => {
    setItems((prev) => {
      const idx = prev.findIndex((it) => it.id === id);
      if (idx === -1) return prev;
      const next = [...prev];
      next[idx] = { ...next[idx], ...patch };
      return next;
    });
    void force;
  }, []);

  /* ---------------- info fetching ---------------- */

  const fetchInfo = useCallback(
    async (rawUrl: string) => {
      const clean = rawUrl.trim();
      if (!clean) return;
      setPhase("loading");
      setErrorMsg(null);
      setErrorCode(null);
      try {
        const res = await fetch("/api/info", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: clean }),
          // the server answers within ~26 s: either the result or a 202
          // "pending" that its background retry loop now owns
          signal: AbortSignal.timeout(30_000),
        });
        if (res.status === 202) {
          // cobalt-style session: the server keeps retrying through tunnel
          // phases — poll until done / failed / user gives up
          const deadline = Date.now() + 12 * 60_000;
          while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 4_000));
            const pr = await fetch(`/api/info?u=${encodeURIComponent(clean)}`, {
              signal: AbortSignal.timeout(10_000),
            }).catch(() => null);
            if (!pr) {
              setPendingNote("Reconnecting…");
              continue;
            }
            if (pr.status === 200) {
              const json = await pr.json();
              if (json?.info) {
                setInfo(json.info as PublicInfo);
                setPhase("ready");
                setPendingNote(null);
                return;
              }
              continue;
            }
            if (pr.status === 202) {
              const j = await pr.json().catch(() => null);
              const n = j?.attempts ?? 0;
              const elapsed = j?.elapsedMs ?? 0;
              setPendingNote(pendingStatus(n, elapsed));
              continue;
            }
            const j = await pr.json().catch(() => null);
            setPhase("error");
            setPendingNote(null);
            setErrorCode(j?.error?.code || "FETCH_FAILED");
            setErrorMsg(j?.error?.message || "Failed");
            return;
          }
          setPhase("error");
          setPendingNote(null);
          setErrorCode("TIMEOUT");
          setErrorMsg("The engine could not reach YouTube in time — try again in a few minutes.");
          return;
        }
        const json = await res.json();
        if (!res.ok || json.error) {
          setPhase("error");
          setPendingNote(null);
          setErrorCode(json?.error?.code || "FETCH_FAILED");
          setErrorMsg(json?.error?.message || "Failed");
          return;
        }
        setInfo(json.info as PublicInfo);
        setPendingNote(null);
        setPhase("ready");
      } catch (e) {
        setPhase("error");
        setPendingNote(null);
        setErrorCode("FETCH_FAILED");
        const aborted = e instanceof DOMException && e.name === "TimeoutError";
        setErrorMsg(
          aborted
            ? "The engine took too long — the tunnel is congested. Try again in a minute."
            : "Network error",
        );
      }
    },
    [],
  );

  const reset = useCallback(() => {
    setUrl("");
    setInfo(null);
    setPhase("idle");
    setErrorMsg(null);
    setErrorCode(null);
    setPendingNote(null);
  }, []);

  /* ---------------- sampler ---------------- */

  const sampleSpeed = useCallback((id: string, received: number): number => {
    const now = performance.now();
    const s = samplers.current.get(id) ?? { lastT: now, lastB: received, ema: 0, lastRender: 0 };
    const dt = (now - s.lastT) / 1000;
    if (dt >= 0.4) {
      const inst = (received - s.lastB) / dt;
      s.ema = s.ema === 0 ? inst : s.ema * 0.7 + inst * 0.3;
      s.lastT = now;
      s.lastB = received;
    }
    samplers.current.set(id, s);
    return s.ema;
  }, []);

  /* ---------------- core streaming save (auto-resume) ---------------- */

  const streamToDisk = useCallback(
    async (
      itemId: string,
      open: (range?: string) => Promise<Response>,
      item: {
        filename: string;
        ext: string;
        label: string;
        title: string;
        videoUrl?: string;
        thumb?: string;
        directUrl?: string; // native-download fallback for browsers without the File System Access API
        storedDirectUrl?: string; // stable /api/file/<token> link once the file is stored server-side
      },
      expectedTotal: number,
      signal: AbortSignal,
    ) => {
      // Slow/flaky networks: a dropped connection or a hiccup on the server no
      // longer kills the transfer — we re-request with `Range: bytes=<n>-` and
      // continue into the SAME file, up to 15 times.
      const MAX_RESUMES = 15;
      let received = 0; // absolute offset across resumes
      let total = expectedTotal || 0;
      let writer: FileSystemWritableFileStream | null = null;
      let writerReady = false;
      const chunks: Uint8Array[] = []; // blob fallback path
      let resumes = 0;
      const mime = mimeForExt(item.ext);
      const backoff = () => new Promise((r) => setTimeout(r, 700 + resumes * 500));

      for (;;) {
        /* ---- (re)open the response ---- */
        let res: Response;
        try {
          res = await open(received > 0 ? `bytes=${received}-` : undefined);
        } catch {
          if (signal.aborted) throw new DOMException("Aborted", "AbortError");
          if (received === 0 || resumes >= MAX_RESUMES) throw new Error("FETCH_FAILED");
          resumes++;
          await backoff();
          continue;
        }

        if (!res.ok && res.status !== 206) {
          let code = "FETCH_FAILED";
          try {
            const j = await res.json();
            code = j?.error?.code || code;
          } catch {
            /* ignore */
          }
          // fatal: nothing to resume from, or the source is gone for good
          if (
            received === 0 ||
            code === "NOT_FOUND" ||
            code === "EXPIRED" ||
            code === "USE_JOB" ||
            code === "NO_FORMATS" ||
            res.status === 416
          ) {
            throw new Error(code);
          }
          if (resumes >= MAX_RESUMES) throw new Error(code);
          resumes++;
          await backoff();
          continue;
        }

        if (!res.body) {
          if (received === 0) throw new Error("FETCH_FAILED");
          resumes++;
          await backoff();
          continue;
        }

        /* ---- size bookkeeping ---- */
        const clen = Number(res.headers.get("content-length")) || 0;
        const crange = res.headers.get("content-range");
        if (crange) {
          const m = crange.match(/\/(\d+)/);
          if (m) total = parseInt(m[1], 10);
        } else if (received === 0 && clen > 0) {
          total = clen;
        }

        if (!writerReady) {
          writerReady = true;
          try {
            writer = await openWritable(item.filename, mime, item.ext);
          } catch {
            // user dismissed the save dialog → cancel silently
            patchItem(itemId, { state: "cancelled" });
            return;
          }
        }

        patchItem(itemId, { state: "downloading", total, received });

        /* ---- pump the current stream ---- */
        const reader = res.body.getReader();
        let streamError: unknown = null;
        let lastUi = 0;
        try {
          for (;;) {
            if (signal.aborted) throw new DOMException("Aborted", "AbortError");
            const { done, value } = await reader.read();
            if (done) break;
            received += value.length;
            if (writer) {
              await writer.write(value);
            } else {
              chunks.push(value);
            }
            const speed = sampleSpeed(itemId, received);
            const now = performance.now();
            if (now - lastUi > 140) {
              lastUi = now;
              patchItem(itemId, { received, speed, total: total || Math.max(total, received) });
            }
          }
        } catch (e) {
          streamError = e;
        } finally {
          try {
            reader.releaseLock();
          } catch {
            /* ignore */
          }
          try {
            await reader.cancel();
          } catch {
            /* ignore */
          }
        }

        if (streamError && signal.aborted) {
          try {
            await writer?.abort();
          } catch {
            /* ignore */
          }
          throw new DOMException("Aborted", "AbortError");
        }

        // clean EOF with the full size delivered → done; clean EOF but short →
        // treat exactly like a broken stream and resume
        const complete = !streamError && (total === 0 || received >= total);
        if (complete) break;

        resumes++;
        if (resumes > MAX_RESUMES) {
          try {
            await writer?.abort();
          } catch {
            /* ignore */
          }
          throw (streamError as Error) || new Error("INCOMPLETE");
        }
        console.log(`[download] auto-resume at ${received}/${total || "?"} (attempt ${resumes})`);
        patchItem(itemId, { speed: 0 });
        await backoff();
      }

      if (writer) {
        await writer.close();
      } else if (item.directUrl) {
        // No File System Access API (Firefox/Safari) — do NOT buffer the file
        // in RAM as a blob. Hand the transfer to the browser's native download
        // manager via Content-Disposition (streams to disk, supports pause on
        // most browsers, zero memory blowup on multi-hundred-MB files).
        patchItem(itemId, { state: "saving" }, true);
        const a = document.createElement("a");
        a.href = item.directUrl;
        a.download = item.filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
      } else {
        patchItem(itemId, { state: "saving" }, true);
        const blob = new Blob(chunks as BlobPart[], { type: mime });
        const objUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = objUrl;
        a.download = item.filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(objUrl), 60_000);
      }

      patchItem(itemId, { state: "done", received, total: total || received, speed: 0 }, true);
      pushHistory({
        id: `${Date.now()}-${item.label}`,
        title: item.title,
        thumb: item.thumb || "",
        label: item.label,
        ext: item.ext,
        size: received,
        at: Date.now(),
        videoUrl: item.videoUrl || "",
        directUrl: item.storedDirectUrl,
      });
      toast.success(t("downloadComplete"), { description: `${item.filename} · ${formatBytes(received)}` });
    },
    [patchItem, pushHistory, sampleSpeed, t],
  );

  /* ---------------- job polling ---------------- */

  interface JobPoll {
    state: string;
    phase: string;
    progress: number;
    speed: string | null;
    receivedBytes: number;
    sizeBytes: number | null;
    error: string | null;
    directUrl?: string | null;
  }

  const pollJob = useCallback(
    async (itemId: string, jobId: string, signal: AbortSignal): Promise<JobPoll> => {
      for (;;) {
        if (signal.aborted) throw new DOMException("Aborted", "AbortError");
        await new Promise((r) => setTimeout(r, 700));
        const res = await fetch(`/api/jobs/${jobId}`, { signal });
        const json = await res.json();
        if (!res.ok || json.error) throw new Error(json?.error?.code || "NOT_FOUND");
        let job = json.job as JobPoll;
        if (job.state === "ready") {
          // the finished file is registered in the store right after "ready"
          // — one extra poll picks up the stable token link if it raced us
          if (!job.directUrl) {
            await new Promise((r) => setTimeout(r, 900));
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
        patchItem(itemId, {
          state: job.state === "merging" ? "merging" : job.state === "downloading" ? "downloading" : "queued",
          received: job.receivedBytes,
          total: job.sizeBytes ?? 0,
        });
      }
    },
    [patchItem],
  );

  /* ---------------- start downloads ---------------- */

  const startDownload = useCallback(
    async (fmt: PublicFormat, infoData: PublicInfo, overrideBitrate?: number) => {
      // audio conversions: mp3/flac/wav always re-encode; m4a/opus only when no
      // native stream of that container exists (fmt.id === "convert")
      const isConversion =
        fmt.kind === "audio" &&
        (fmt.id === "convert" || ["mp3", "flac", "wav"].includes(fmt.container));
      const label = isConversion
        ? fmt.container === "mp3"
          ? `MP3 ${overrideBitrate ?? 320}`
          : fmt.container.toUpperCase()
        : fmt.kind === "video"
          ? `${fmt.quality} · ${fmt.container.toUpperCase()}`
          : `${fmt.quality} · ${fmt.container.toUpperCase()}`;
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const filename = `${infoData.title.slice(0, 80).replace(/[\\/:*?"<>|]/g, " ").trim()} (${label.replace(/[\\/:*?"<>|]/g, "-")}).${fmt.container}`;
      const ctrl = new AbortController();
      controllers.current.set(id, ctrl);
      samplers.current.set(id, { lastT: performance.now(), lastB: 0, ema: 0, lastRender: 0 });

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
      setItems((prev) => [shell, ...prev].slice(0, 12));

      try {
        /* ================================================================
         * MIDDLEMAN FLOW — every download is a server job. The server
         * (fast pipe + WARP) pulls from YouTube FIRST; the user's browser
         * or external manager then fetches the finished file from THIS
         * app with Range/resume. The user's own connection never touches
         * YouTube, which is what makes this reliable on slow/censored
         * networks (Iran etc.).
         * ================================================================ */
        {
          const isMerge = fmt.needsMerge;
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
            signal: ctrl.signal,
          });
          const json = await res.json();
          if (!res.ok || json.error) throw new Error(json?.error?.code || "INTERNAL");
          const job = json.job as { id: string; sizeBytes: number | null };
          patchItem(id, { jobId: job.id, state: "queued", total: job.sizeBytes || fmt.filesize || 0 }, true);
          const done = await pollJob(id, job.id, ctrl.signal);
          // the file is now STORED server-side → swap in the stable token link
          if (done.directUrl) {
            patchItem(id, { directLink: done.directUrl, directReady: true }, true);
          }
          const fileUrl = `/api/jobs/${job.id}/file`;
          await streamToDisk(
            id,
            (range) =>
              fetch(fileUrl, {
                signal: ctrl.signal,
                headers: range ? { Range: range } : undefined,
              }),
            { ...shell, directUrl: fileUrl, storedDirectUrl: done.directUrl ?? undefined },
            fmt.filesize || 0,
            ctrl.signal,
          );
        }
      } catch (e) {
        const err = e as Error & { name?: string };
        if (err.name === "AbortError" || err.message === "Cancelled") {
          patchItem(id, { state: "cancelled", speed: 0 }, true);
        } else {
          patchItem(id, { state: "error", error: err.message || "INTERNAL", speed: 0 }, true);
          toast.error(t("downloadFailed"), { description: t(errorKey(err.message)) });
        }
      } finally {
        controllers.current.delete(id);
        samplers.current.delete(id);
      }
    },
    [patchItem, pollJob, streamToDisk, t],
  );

  const cancelItem = useCallback(
    (item: DownloadItem) => {
      const ctrl = controllers.current.get(item.id);
      ctrl?.abort();
      controllers.current.delete(item.id);
      if (item.jobId) {
        void fetch(`/api/jobs/${item.jobId}`, { method: "DELETE" }).catch(() => undefined);
      }
      patchItem(item.id, { state: "cancelled", speed: 0 }, true);
    },
    [patchItem],
  );

  const removeItem = useCallback(
    (id: string) => {
      setItems((prev) => prev.filter((it) => it.id !== id));
    },
    [],
  );

  const clearFinished = useCallback(() => {
    setItems((prev) => prev.filter((it) => it.state !== "done" && it.state !== "cancelled" && it.state !== "error"));
  }, []);

  /* ---------------- direct link (fetch-first) ---------------- */

  /**
   * "🔗 Direct link" — the file must be ON THE SERVER before a link is
   * handed out. Ready file → copy the stable /api/file/<token> link
   * instantly. Otherwise the server starts downloading it first and a
   * tracking row appears in Downloads; the stable link shows up on that
   * row (Copy direct link) the moment the file is stored.
   */
  const getDirectLink = useCallback(
    async (fmt: PublicFormat, infoData: PublicInfo, overrideBitrate?: number) => {
      const isConversion =
        fmt.kind === "audio" &&
        (fmt.id === "convert" || ["mp3", "flac", "wav"].includes(fmt.container));
      const spec = {
        url: infoData.webpageUrl,
        format: isConversion ? fmt.container : fmt.id,
        quality: fmt.quality || "",
        bitrate: isConversion && fmt.container === "mp3" ? overrideBitrate ?? 320 : undefined,
        title: infoData.title,
      };
      try {
        const res = await fetch("/api/dl-resolve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(spec),
        });
        const json = await res.json();
        if (json.status === "ready" && json.directUrl) {
          const abs = `${window.location.origin}${json.directUrl}`;
          void navigator.clipboard?.writeText(abs).catch(() => undefined);
          toast.success("Direct link copied", {
            description: `Stored on the YouWee server (${formatBytes(json.sizeBytes || 0)}) — downloads from here with full resume support. Paste it in IDM, aria2 or any browser.`,
          });
          return;
        }
        if (json.status === "busy") {
          const label = isConversion
            ? fmt.container.toUpperCase()
            : fmt.kind === "video"
              ? `${fmt.quality} · ${fmt.container.toUpperCase()}`
              : `${fmt.quality} · ${fmt.container.toUpperCase()}`;
          const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          const ctrl = new AbortController();
          controllers.current.set(id, ctrl);
          setItems((prev) =>
            [
              {
                id,
                title: infoData.title,
                label,
                filename: `${infoData.title.slice(0, 80)} (${label}).${fmt.container}`,
                ext: fmt.container,
                state: "queued" as ItemState,
                received: 0,
                total: fmt.filesize || 0,
                speed: 0,
                jobId: json.jobId || undefined,
                videoUrl: infoData.webpageUrl,
                thumb: infoData.thumbnail,
                directLink: buildDlLink(fmt, infoData, overrideBitrate),
              },
              ...prev,
            ].slice(0, 12),
          );
          toast.info("Fetching on the server first…", {
            description: "The file is being downloaded to YouWee's server at full speed. The direct link appears on the row below as soon as it's stored.",
          });
          try {
            if (json.jobId) {
              const done = await pollJob(id, json.jobId, ctrl.signal);
              if (done.directUrl) {
                patchItem(id, { state: "done", directLink: done.directUrl, directReady: true, total: done.sizeBytes ?? 0 }, true);
                pushHistory({
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
              } else {
                patchItem(id, { state: "done", total: done.sizeBytes ?? 0 }, true);
              }
            } else {
              // warm-up still resolving (no job yet) → poll the resolver
              for (;;) {
                if (ctrl.signal.aborted) throw new DOMException("Aborted", "AbortError");
                await new Promise((r) => setTimeout(r, 2500));
                const r2 = await fetch("/api/dl-resolve", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(spec),
                  signal: ctrl.signal,
                });
                const j2 = await r2.json();
                if (j2.status === "ready" && j2.directUrl) {
                  patchItem(id, { state: "done", directLink: j2.directUrl, directReady: true, total: j2.sizeBytes ?? 0 }, true);
                  toast.success("Direct link is ready", {
                    description: "The file is stored on the server — grab it from the row below (Copy direct link).",
                  });
                  break;
                }
                if (j2.status === "failed") throw new Error(j2.code || "INTERNAL");
              }
            }
          } catch (e) {
            const err = e as Error & { name?: string };
            if (err.name === "AbortError") patchItem(id, { state: "cancelled" }, true);
            else {
              patchItem(id, { state: "error", error: err.message }, true);
              toast.error(t("downloadFailed"), { description: t(errorKey(err.message)) });
            }
          } finally {
            controllers.current.delete(id);
          }
          return;
        }
        toast.error(t("downloadFailed"), { description: t(errorKey(json.code || "INTERNAL")) });
      } catch {
        toast.error(t("downloadFailed"), { description: "Network error" });
      }
    },
    [patchItem, pollJob, pushHistory, t],
  );

  return {
    url,
    setUrl,
    phase,
    pendingNote,
    info,
    errorMsg,
    errorCode,
    items,
    history,
    fetchInfo,
    reset,
    startDownload,
    getDirectLink,
    cancelItem,
    removeItem,
    clearFinished,
    clearHistory,
  };
}
