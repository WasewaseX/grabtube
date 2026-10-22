/**
 * Stored-file registry — the "database" behind the MIDDLEMAN direct links.
 *
 * A row is written ONLY after the server has fully downloaded / merged /
 * converted a video from YouTube (never before). The direct link
 * (/api/file/<token>) then serves the LOCAL file with full Range/resume
 * support, so the user's own connection never touches YouTube — essential
 * for slow / censored networks (Iran etc.).
 *
 * lookupKey = request signature → the SAME token is reused when the same
 * file is requested again (even after eviction + re-download), so links that
 * were shared hours ago keep working.
 *
 * Lifecycle: files persist on disk until (a) disk pressure (auto-evict
 * oldest-accessed when free space drops below the floor) or (b) 7 days
 * without any access. Actively-downloading files (touched < 10 min ago)
 * are never evicted.
 */
import { existsSync, rmSync, statfsSync, statSync } from "fs";
import { randomBytes } from "crypto";
import path from "path";

import { db } from "@/lib/db";

/** free-disk floor: below this, oldest stored files are evicted */
const EVICT_BELOW_BYTES = 1.6 * 1024 * 1024 * 1024;
/** eviction stops once free space reaches this */
const EVICT_TARGET_BYTES = 2.6 * 1024 * 1024 * 1024;
/** a file accessed within this window is "hot" and never evicted */
const HOT_MS = 10 * 60 * 1000;
/** hard cap: files untouched for a week can be reclaimed */
const MAX_IDLE_MS = 7 * 24 * 60 * 60 * 1000;

export interface StoredFileInfo {
  token: string;
  lookupKey: string;
  filename: string;
  filePath: string;
  sizeBytes: number;
  mime: string;
  kind: string;
  quality: string;
  title: string;
  webpageUrl: string;
}

function newToken(): string {
  return randomBytes(12).toString("hex"); // 24 chars, unguessable
}

export function lookupKeyFor(webpageUrl: string, format: string, bitrate?: number): string {
  // Normalize DRC audio variants ("140-drc" → "140"): the picker prefers DRC
  // tracks, but they're the same content as the plain itag — without this the
  // same visible file would be downloaded and stored TWICE under two keys
  // (manual/API links vs UI-built composites) instead of sharing one token.
  const norm = format.replace(/(\d+)-drc/gi, "$1");
  return `${webpageUrl}::${norm}::${bitrate || 0}`;
}

/**
 * Semantic video storage key — YouTube itags DRIFT between extraction
 * sessions (360p H.264 came back as itag 134 in one fetch and 230 in the
 * next for the same video), so keying storage by raw itag stores the same
 * visible file several times. Keying by height+fps+codec+container instead
 * means every variant of "360p H.264 mp4" shares ONE stored file/token.
 * Falls back to the plain itag key when the format entry is unavailable.
 */
export function videoKeyFromFormat(
  webpageUrl: string,
  f: { height?: number | null; fps?: number | null; vcodec?: string | null; ext?: string | null } | null,
  fallbackFormat: string,
): string {
  if (f?.height) {
    const vc = (f.vcodec ?? "").toLowerCase();
    const codec = /avc1|h264/.test(vc)
      ? "h264"
      : /vp0?9/.test(vc)
        ? "vp9"
        : /av01|av1/.test(vc)
          ? "av1"
          : vc ? vc.slice(0, 10) : "any";
    const fps = f.fps && f.fps > 30 ? Math.round(f.fps) : 0;
    const container = (f.ext || fallbackFormat.split("|")[2] || "mp4").toLowerCase();
    return `${webpageUrl}::v|h${f.height}${fps ? `f${fps}` : ""}|${codec}|${container}::0`;
  }
  return lookupKeyFor(webpageUrl, fallbackFormat);
}

function toInfo(row: {
  token: string;
  lookupKey: string;
  filename: string;
  filePath: string;
  sizeBytes: bigint;
  mime: string;
  kind: string;
  quality: string;
  title: string;
  webpageUrl: string;
}): StoredFileInfo {
  return { ...row, sizeBytes: Number(row.sizeBytes) };
}

/** Register (or refresh) a finished file. Keeps the ORIGINAL token when the
 *  same lookupKey was stored before, so old links keep working. */
export async function registerStoredFile(input: {
  lookupKey: string;
  filePath: string;
  filename: string;
  mime: string;
  kind: string;
  quality?: string;
  title?: string;
  webpageUrl?: string;
  formatSpec?: string;
}): Promise<StoredFileInfo | null> {
  let size = 0;
  try {
    size = statSync(input.filePath).size;
  } catch {
    return null; // file vanished between completion and registration
  }
  try {
    const existing = await db.storedFile.findUnique({ where: { lookupKey: input.lookupKey } });
    if (existing) {
      // re-download (self-heal) → same token, refreshed metadata
      const row = await db.storedFile.update({
        where: { id: existing.id },
        data: {
          filePath: input.filePath,
          filename: input.filename,
          sizeBytes: BigInt(size),
          mime: input.mime,
          lastAccessAt: new Date(),
        },
      });
      return toInfo(row);
    }
    const row = await db.storedFile.create({
      data: {
        token: newToken(),
        lookupKey: input.lookupKey,
        filePath: input.filePath,
        filename: input.filename,
        sizeBytes: BigInt(size),
        mime: input.mime,
        kind: input.kind,
        quality: input.quality || "",
        title: input.title || "",
        webpageUrl: input.webpageUrl || "",
        formatSpec: input.formatSpec || "",
      },
    });
    // opportunistically reclaim space after every new registration
    void evictIfNeeded();
    return toInfo(row);
  } catch (e) {
    console.error("[store] register failed:", (e as Error).message);
    return null;
  }
}

export async function findStoredByToken(token: string): Promise<StoredFileInfo | null> {
  try {
    const row = await db.storedFile.findUnique({ where: { token } });
    return row ? toInfo(row) : null;
  } catch {
    return null;
  }
}

export async function findStoredByLookupKey(lookupKey: string): Promise<StoredFileInfo | null> {
  try {
    const row = await db.storedFile.findUnique({ where: { lookupKey } });
    if (!row) return null;
    if (!existsSync(row.filePath)) return null; // file was evicted
    return toInfo(row);
  } catch {
    return null;
  }
}

export async function findStoredRowByLookupKey(lookupKey: string) {
  try {
    return await db.storedFile.findUnique({ where: { lookupKey } });
  } catch {
    return null;
  }
}

/** Touch on every serve — keeps hot files out of eviction and counts hits. */
export async function touchStoredFile(token: string): Promise<void> {
  try {
    await db.storedFile.update({
      where: { token },
      data: { lastAccessAt: new Date(), downloadCount: { increment: 1 } },
    });
  } catch {
    /* non-fatal */
  }
}

/** Parse a lookupKey back into its link spec (used by the self-heal path). */
export function parseLookupKey(key: string): { webpageUrl: string; format: string; bitrate?: number } | null {
  const idx = key.indexOf("::");
  if (idx <= 0) return null;
  const webpageUrl = key.slice(0, idx);
  const rest = key.slice(idx + 2);
  const last = rest.lastIndexOf("::");
  if (last < 0) return { webpageUrl, format: rest };
  const format = rest.slice(0, last);
  const bitrate = parseInt(rest.slice(last + 2), 10) || undefined;
  if (!webpageUrl.startsWith("http")) return null;
  return { webpageUrl, format, bitrate };
}

function freeDiskBytes(): number {
  try {
    const s = statfsSync(path.dirname(process.cwd()));
    return s.bsize * s.bavail;
  } catch {
    return Number.MAX_SAFE_INTEGER; // statfs unavailable → never evict
  }
}

/** Delete a stored file's row + disk file (explicit delete / eviction). */
export async function deleteStoredFile(token: string): Promise<void> {
  try {
    const row = await db.storedFile.findUnique({ where: { token } });
    if (!row) return;
    if (existsSync(row.filePath)) {
      try {
        rmSync(row.filePath, { force: true });
      } catch {
        /* noop */
      }
    }
    await db.storedFile.delete({ where: { token } });
  } catch {
    /* noop */
  }
}

/** Disk-pressure eviction: oldest-accessed first, hot files immune. */
export async function evictIfNeeded(): Promise<void> {
  try {
    let free = freeDiskBytes();
    const forceIdle = Date.now() - MAX_IDLE_MS;
    if (free >= EVICT_BELOW_BYTES) {
      // still reclaim ancient files (idle > 7d) even when disk is comfortable
      const ancients = await db.storedFile.findMany({
        where: { lastAccessAt: { lt: new Date(forceIdle) } },
        take: 10,
      });
      for (const a of ancients) await deleteStoredFile(a.token);
      return;
    }
    const rows = await db.storedFile.findMany({ orderBy: { lastAccessAt: "asc" }, take: 200 });
    const now = Date.now();
    for (const row of rows) {
      if (free >= EVICT_TARGET_BYTES) break;
      if (now - row.lastAccessAt.getTime() < HOT_MS) continue; // active download
      await deleteStoredFile(row.token);
      free = freeDiskBytes();
    }
  } catch {
    /* eviction is best-effort */
  }
}
