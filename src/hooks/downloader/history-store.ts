"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";

import type { HistoryEntry } from "./types";

const HISTORY_KEY = "tubegrab.history.v1";
const HISTORY_EVENT = "tubegrab:history";
const HISTORY_LIMIT = 20;

function writeStoredHistory(entries: HistoryEntry[]): void {
  try {
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify(entries));
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event(HISTORY_EVENT));
}

export function removeStoredHistory(): void {
  try {
    window.localStorage.removeItem(HISTORY_KEY);
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event(HISTORY_EVENT));
}

function subscribe(onStoreChange: () => void): () => void {
  window.addEventListener("storage", onStoreChange);
  window.addEventListener(HISTORY_EVENT, onStoreChange);
  return () => {
    window.removeEventListener("storage", onStoreChange);
    window.removeEventListener(HISTORY_EVENT, onStoreChange);
  };
}

/** Server render always sees an empty list; the client snapshot reads
 *  localStorage directly, so hydration stays consistent (no state effect). */
function getServerSnapshot(): string {
  return "";
}

function getSnapshot(): string {
  try {
    return window.localStorage.getItem(HISTORY_KEY) ?? "";
  } catch {
    return "";
  }
}

function parseHistory(raw: string): HistoryEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as HistoryEntry[]).slice(0, HISTORY_LIMIT) : [];
  } catch {
    return [];
  }
}

/** Keeps the last 20 downloads and mirrors them to localStorage. */
export function useHistoryStore() {
  const raw = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const history = useMemo(() => parseHistory(raw), [raw]);

  const pushHistory = useCallback((entry: HistoryEntry) => {
    const prev = parseHistory(getSnapshot());
    writeStoredHistory([entry, ...prev].slice(0, HISTORY_LIMIT));
  }, []);

  const clearHistory = useCallback(() => {
    removeStoredHistory();
  }, []);

  return { history, pushHistory, clearHistory };
}
