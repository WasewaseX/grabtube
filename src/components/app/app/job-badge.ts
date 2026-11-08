import type { DownloadItem } from "../../../hooks/use-downloader";
import { fmtBytes } from "./format-utils";

export interface JobBadge {
  badge: string;
  cls: string;
}

export function jobBadge(state: DownloadItem["state"], pct: number): JobBadge {
  if (state === "done") return { badge: "Ready", cls: "ok" };
  if (state === "error") return { badge: "Failed", cls: "err" };
  if (state === "cancelled") return { badge: "Cancelled", cls: "err" };
  if (state === "merging") return { badge: "Merging", cls: "warn" };
  if (state === "queued" || state === "starting") return { badge: "Starting", cls: "warn" };
  return { badge: `${pct}%`, cls: "warn" };
}

export function jobSubtitle(it: DownloadItem, working: boolean): string {
  return [
    it.label,
    it.total > 0 ? fmtBytes(it.total) : "",
    working && it.speed > 0 ? `${fmtBytes(it.speed)}/s` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}
