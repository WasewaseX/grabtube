import { delay } from "./api-client";
import { mimeForExt, openWritable, triggerBrowserDownload } from "./file-save";
import type { HistoryEntry, ItemPatchFn, StreamTarget } from "./types";

const MAX_RESUMES = 15;

export interface StreamJob {
  itemId: string;
  open: (range?: string) => Promise<Response>;
  item: StreamTarget;
  expectedTotal: number;
  signal: AbortSignal;
}

/** Hooks the streaming saver needs back into the owning hook instance. */
export interface StreamIo {
  patch: ItemPatchFn;
  pushHistory: (entry: HistoryEntry) => void;
  sampleSpeed: (id: string, received: number) => number;
  /** success toast, e.g. t("downloadComplete") plus filename and size */
  onSaved: (filename: string, received: number) => void;
}

/** Mutable per-transfer state shared by the resume loop and the finale. */
interface StreamState {
  received: number; // absolute offset across resumes
  total: number;
  resumes: number;
  writer: FileSystemWritableFileStream | null;
  writerReady: boolean;
  chunks: Uint8Array[]; // blob fallback path
  mime: string;
}

async function readErrorCode(res: Response): Promise<string> {
  try {
    const j = await res.json();
    return j?.error?.code || "FETCH_FAILED";
  } catch {
    return "FETCH_FAILED";
  }
}

function isFatalResumeFailure(code: string, status: number, received: number): boolean {
  return (
    received === 0 ||
    code === "NOT_FOUND" ||
    code === "EXPIRED" ||
    code === "USE_JOB" ||
    code === "NO_FORMATS" ||
    status === 416
  );
}

function resolveTotal(headers: Headers, received: number, total: number): number {
  const crange = headers.get("content-range");
  if (crange) {
    const m = crange.match(/\/(\d+)/);
    if (m) return parseInt(m[1], 10);
  } else if (received === 0) {
    const clen = Number(headers.get("content-length")) || 0;
    if (clen > 0) return clen;
  }
  return total;
}

async function abortWriter(writer: FileSystemWritableFileStream | null): Promise<void> {
  try {
    await writer?.abort();
  } catch {
    /* ignore */
  }
}

/**
 * Pump one response body into the writer (or the blob chunks), updating the
 * row with throttled progress. Returns the stream error, if any.
 */
async function pumpStream(
  itemId: string,
  reader: ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>>,
  signal: AbortSignal,
  st: StreamState,
  io: StreamIo,
): Promise<unknown> {
  let lastUi = 0;
  let streamError: unknown = null;
  try {
    for (;;) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      const { done, value } = await reader.read();
      if (done) break;
      st.received += value.length;
      if (st.writer) {
        await st.writer.write(value);
      } else {
        st.chunks.push(value);
      }
      const speed = io.sampleSpeed(itemId, st.received);
      const now = performance.now();
      if (now - lastUi > 140) {
        lastUi = now;
        io.patch(itemId, { received: st.received, speed, total: st.total || Math.max(st.total, st.received) });
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
  return streamError;
}

/**
 * Slow/flaky networks: a dropped connection or a hiccup on the server no
 * longer kills the transfer — re-request with `Range: bytes=<n>-` and
 * continue into the SAME file, up to MAX_RESUMES times.
 */
async function downloadLoop(
  job: StreamJob,
  st: StreamState,
  backoff: () => Promise<void>,
  io: StreamIo,
): Promise<"completed" | "cancelled"> {
  const { itemId, open, item, signal } = job;
  for (;;) {
    let res: Response;
    try {
      res = await open(st.received > 0 ? `bytes=${st.received}-` : undefined);
    } catch {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      if (st.received === 0 || st.resumes >= MAX_RESUMES) throw new Error("FETCH_FAILED");
      st.resumes++;
      await backoff();
      continue;
    }

    if (!res.ok && res.status !== 206) {
      const code = await readErrorCode(res);
      if (isFatalResumeFailure(code, res.status, st.received)) throw new Error(code);
      if (st.resumes >= MAX_RESUMES) throw new Error(code);
      st.resumes++;
      await backoff();
      continue;
    }

    if (!res.body) {
      if (st.received === 0) throw new Error("FETCH_FAILED");
      st.resumes++;
      await backoff();
      continue;
    }

    st.total = resolveTotal(res.headers, st.received, st.total);

    if (!st.writerReady) {
      st.writerReady = true;
      try {
        st.writer = await openWritable(item.filename, st.mime, item.ext);
      } catch {
        // user dismissed the save dialog → cancel silently
        io.patch(itemId, { state: "cancelled" });
        return "cancelled";
      }
    }

    io.patch(itemId, { state: "downloading", total: st.total, received: st.received });

    const reader = res.body.getReader();
    const streamError = await pumpStream(itemId, reader, signal, st, io);

    if (streamError && signal.aborted) {
      await abortWriter(st.writer);
      throw new DOMException("Aborted", "AbortError");
    }

    // clean EOF with the full size delivered → done; clean EOF but short →
    // treat exactly like a broken stream and resume
    const complete = !streamError && (st.total === 0 || st.received >= st.total);
    if (complete) return "completed";

    st.resumes++;
    if (st.resumes > MAX_RESUMES) {
      await abortWriter(st.writer);
      throw (streamError as Error) || new Error("INCOMPLETE");
    }
    console.log(`[download] auto-resume at ${st.received}/${st.total || "?"} (attempt ${st.resumes})`);
    io.patch(itemId, { speed: 0 });
    await backoff();
  }
}

/** Close the writer (or hand off to the browser), mark done, record history. */
async function finalizeStream(job: StreamJob, st: StreamState, io: StreamIo): Promise<void> {
  const { itemId, item } = job;
  if (st.writer) {
    await st.writer.close();
  } else if (item.directUrl) {
    // No File System Access API (Firefox/Safari) — do NOT buffer the file in
    // RAM as a blob; hand the transfer to the browser's native download
    // manager (streams to disk, zero memory blowup on huge files).
    io.patch(itemId, { state: "saving" }, true);
    triggerBrowserDownload(item.directUrl, item.filename);
  } else {
    io.patch(itemId, { state: "saving" }, true);
    const blob = new Blob(st.chunks as BlobPart[], { type: st.mime });
    const objUrl = URL.createObjectURL(blob);
    triggerBrowserDownload(objUrl, item.filename);
    setTimeout(() => URL.revokeObjectURL(objUrl), 60_000);
  }

  io.patch(itemId, { state: "done", received: st.received, total: st.total || st.received, speed: 0 }, true);
  io.pushHistory({
    id: `${Date.now()}-${item.label}`,
    title: item.title,
    thumb: item.thumb || "",
    label: item.label,
    ext: item.ext,
    size: st.received,
    at: Date.now(),
    videoUrl: item.videoUrl || "",
    directUrl: item.storedDirectUrl,
  });
  io.onSaved(item.filename, st.received);
}

/**
 * Core streaming save with auto-resume: writes the file via the File System
 * Access API when available, else falls back to a native or blob download.
 */
export async function streamToDisk(job: StreamJob, io: StreamIo): Promise<void> {
  const st: StreamState = {
    received: 0,
    total: job.expectedTotal || 0,
    resumes: 0,
    writer: null,
    writerReady: false,
    chunks: [],
    mime: mimeForExt(job.item.ext),
  };
  const backoff = () => delay(700 + st.resumes * 500);
  const outcome = await downloadLoop(job, st, backoff, io);
  if (outcome === "cancelled") return;
  await finalizeStream(job, st, io);
}
