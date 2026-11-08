"use client";

import { useCallback, useRef, useState } from "react";

import type { DownloadItem, ItemPatchFn } from "./types";

/** Owns the download queue rows and the abort controllers behind them. */
export function useDownloadQueue() {
  const [items, setItems] = useState<DownloadItem[]>([]);
  const controllers = useRef(new Map<string, AbortController>());

  const patchItem = useCallback<ItemPatchFn>((id, patch, force = false) => {
    setItems((prev) => {
      const idx = prev.findIndex((it) => it.id === id);
      if (idx === -1) return prev;
      const next = [...prev];
      next[idx] = { ...next[idx], ...patch };
      return next;
    });
    void force;
  }, []);

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

  const removeItem = useCallback((id: string) => {
    setItems((prev) => prev.filter((it) => it.id !== id));
  }, []);

  const clearFinished = useCallback(() => {
    setItems((prev) =>
      prev.filter((it) => it.state !== "done" && it.state !== "cancelled" && it.state !== "error"),
    );
  }, []);

  return {
    items,
    setItems,
    patchItem,
    cancelItem,
    removeItem,
    clearFinished,
    controllers,
  };
}
