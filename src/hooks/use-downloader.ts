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
}

const HISTORY_KEY = "tubegrab.history.v1";

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

/* ------------------------------------------------------------------ */
/* Hook                                                                */
/* ------------------------------------------------------------------ */

export function useDownloader() {
  const { t } = useLang();

  const [url, setUrl] = useState("");
  const [phase, setPhase] = useState<"idle" | "loading" | "ready" | "error">("idle");
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
        });
        const json = await res.json();
        if (!res.ok || json.error) {
          setPhase("error");
          setErrorCode(json?.error?.code || "FETCH_FAILED");
          setErrorMsg(json?.error?.message || "Failed");
          return;
        }
        setInfo(json.info as PublicInfo);
        setPhase("ready");
      } catch {
        setPhase("error");
        setErrorCode("FETCH_FAILED");
        setErrorMsg("Network error");
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
      });
      toast.success(t("downloadComplete"), { description: `${item.filename} · ${formatBytes(received)}` });
    },
    [patchItem, pushHistory, sampleSpeed, t],
  );

  /* ---------------- job polling ---------------- */

  const pollJob = useCallback(
    async (jobId: string, signal: AbortSignal) => {
      for (;;) {
        if (signal.aborted) throw new DOMException("Aborted", "AbortError");
        await new Promise((r) => setTimeout(r, 700));
        const res = await fetch(`/api/jobs/${jobId}`, { signal });
        const json = await res.json();
        if (!res.ok || json.error) throw new Error(json?.error?.code || "NOT_FOUND");
        const job = json.job as {
          state: string;
          phase: string;
          progress: number;
          speed: string | null;
          receivedBytes: number;
          sizeBytes: number | null;
          error: string | null;
        };
        if (job.state === "ready") return job;
        if (job.state === "error") throw new Error(job.error || "INTERNAL");
        if (job.state === "cancelled") throw new DOMException("Cancelled", "AbortError");
        patchItem(jobId, {
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
      const isMp3 = fmt.container === "mp3";
      const label = isMp3
        ? `MP3 ${overrideBitrate ?? 320}`
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
      };
      setItems((prev) => [shell, ...prev].slice(0, 12));

      try {
        if (fmt.needsMerge || isMp3) {
          /* ---------- server job (merge / mp3) ---------- */
          const res = await fetch("/api/jobs", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              infoId: infoData.infoId,
              mode: isMp3 ? "mp3" : "merge",
              videoFormatId: fmt.needsMerge ? fmt.id : undefined,
              bitrate: isMp3 ? overrideBitrate ?? 320 : undefined,
              title: infoData.title,
              webpageUrl: infoData.webpageUrl,
            }),
            signal: ctrl.signal,
          });
          const json = await res.json();
          if (!res.ok || json.error) throw new Error(json?.error?.code || "INTERNAL");
          const job = json.job as { id: string; sizeBytes: number | null };
          patchItem(id, { jobId: job.id, state: "queued", total: job.sizeBytes || fmt.filesize || 0 }, true);
          await pollJob(job.id, ctrl.signal);
          const fileUrl = `/api/jobs/${job.id}/file`;
          await streamToDisk(
            id,
            (range) =>
              fetch(fileUrl, {
                signal: ctrl.signal,
                headers: range ? { Range: range } : undefined,
              }),
            { ...shell, directUrl: fileUrl },
            fmt.filesize || 0,
            ctrl.signal,
          );
        } else {
          /* ---------- instant pipe ---------- */
          const qs = new URLSearchParams({
            infoId: infoData.infoId,
            formatId: fmt.id,
            q: fmt.quality,
          });
          const dlUrl = `/api/download?${qs}`;
          await streamToDisk(
            id,
            (range) =>
              fetch(dlUrl, {
                signal: ctrl.signal,
                headers: range ? { Range: range } : undefined,
              }),
            { ...shell, directUrl: dlUrl },
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

  return {
    url,
    setUrl,
    phase,
    info,
    errorMsg,
    errorCode,
    items,
    history,
    fetchInfo,
    reset,
    startDownload,
    cancelItem,
    removeItem,
    clearFinished,
    clearHistory,
  };
}
