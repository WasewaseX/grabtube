"use client";

/**
 * Public entry for the downloader client engine.
 *
 * Implementation lives in src/hooks/downloader/* — decomposed by phase
 * (info fetch, job polling, direct-link resolve, stream-to-disk) with the
 * queue/history/speed state hooks beside them. This file keeps the stable
 * import path every component already uses.
 */

export { useDownloader } from "./downloader/use-downloader";
export { buildDlLink } from "./downloader/api-client";
export type { ItemState, DownloadItem, HistoryEntry } from "./downloader/types";
