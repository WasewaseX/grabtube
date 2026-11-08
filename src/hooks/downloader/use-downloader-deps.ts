"use client";

import { useCallback, useMemo } from "react";
import { toast } from "sonner";

import { formatBytes } from "@/lib/format-utils";
import { errorKey } from "@/lib/i18n";
import { useLang } from "../use-lang";
import { pollJobUntilDone } from "./job-phase";
import { sampleDownloadSpeed } from "./speed-sampler";
import { streamToDisk } from "./stream-save";
import type { DownloaderDeps, JobPollFn, SpeedSample, StreamFn } from "./types";
import type { useDownloadQueue } from "./use-download-queue";
import type { useHistoryStore } from "./history-store";

type QueueApi = ReturnType<typeof useDownloadQueue>;
type HistoryApi = ReturnType<typeof useHistoryStore>;

/** Builds the phase-deps bundle: toast callbacks, polling, streaming and speed sampling. */
export function useDownloaderDeps(
  queue: QueueApi,
  hist: HistoryApi,
  samplers: { current: Map<string, SpeedSample> },
): DownloaderDeps {
  const { t } = useLang();

  const onDownloadError = useCallback(
    (message: string) => {
      toast.error(t("downloadFailed"), { description: t(errorKey(message)) });
    },
    [t],
  );

  const onNetworkError = useCallback(() => {
    toast.error(t("downloadFailed"), { description: "Network error" });
  }, [t]);

  const onSaved = useCallback(
    (filename: string, received: number) => {
      toast.success(t("downloadComplete"), { description: `${filename} · ${formatBytes(received)}` });
    },
    [t],
  );

  const sampleSpeed = useCallback(
    (id: string, received: number) => sampleDownloadSpeed(samplers.current, id, received),
    [samplers],
  );

  const pollJob = useCallback<JobPollFn>(
    (itemId, jobId, signal) => pollJobUntilDone(itemId, jobId, signal, queue.patchItem),
    [queue.patchItem],
  );

  const runStream = useCallback<StreamFn>(
    (itemId, open, item, expectedTotal, signal) =>
      streamToDisk(
        { itemId, open, item, expectedTotal, signal },
        { patch: queue.patchItem, pushHistory: hist.pushHistory, sampleSpeed, onSaved },
      ),
    [queue.patchItem, hist.pushHistory, sampleSpeed, onSaved],
  );

  return useMemo<DownloaderDeps>(
    () => ({
      patch: queue.patchItem,
      setItems: queue.setItems,
      pollJob,
      stream: runStream,
      pushHistory: hist.pushHistory,
      controllers: queue.controllers,
      samplers,
      onError: onDownloadError,
      onNetworkError,
    }),
    [queue.patchItem, queue.setItems, queue.controllers, pollJob, runStream, hist.pushHistory, onDownloadError, onNetworkError, samplers],
  );
}
