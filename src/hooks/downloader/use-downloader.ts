"use client";

import { useCallback, useRef } from "react";

import { requestDirectLink } from "./direct-link-phase";
import { startServerJobDownload } from "./job-phase";
import { useDownloaderDeps } from "./use-downloader-deps";
import { useDownloadQueue } from "./use-download-queue";
import { useInfoState } from "./use-info-state";
import { useHistoryStore } from "./history-store";
import type { DownloadStartFn, SpeedSample } from "./types";

export function useDownloader() {
  const info = useInfoState();
  const queue = useDownloadQueue();
  const hist = useHistoryStore();
  const samplers = useRef(new Map<string, SpeedSample>());

  const deps = useDownloaderDeps(queue, hist, samplers);

  const startDownload = useCallback<DownloadStartFn>(
    (fmt, infoData, overrideBitrate) => startServerJobDownload(deps, fmt, infoData, overrideBitrate),
    [deps],
  );

  const getDirectLink = useCallback<DownloadStartFn>(
    (fmt, infoData, overrideBitrate) => requestDirectLink(deps, fmt, infoData, overrideBitrate),
    [deps],
  );

  return {
    ...info,
    items: queue.items,
    history: hist.history,
    startDownload,
    getDirectLink,
    cancelItem: queue.cancelItem,
    removeItem: queue.removeItem,
    clearFinished: queue.clearFinished,
    clearHistory: hist.clearHistory,
  };
}
