"use client";

import type { DownloadItem } from "../../../hooks/use-downloader";
import { copyDirectLink } from "./copy-link";
import { jobBadge, jobSubtitle } from "./job-badge";

export function JobRow({
  it,
  onCancel,
  onRemove,
}: {
  it: DownloadItem;
  onCancel: (item: DownloadItem) => void;
  onRemove: (id: string) => void;
}) {
  const working = ["starting", "queued", "downloading", "merging", "saving"].includes(it.state);
  const pct = it.total > 0 ? Math.min(100, Math.round((it.received / it.total) * 100)) : it.state === "done" ? 100 : 0;
  const { badge, cls: badgeCls } = jobBadge(it.state, pct);
  const sub = jobSubtitle(it, working);

  return (
    <div className="job-row">
      <div style={{ minWidth: 0 }}>
        <div className="job-title">{it.title}</div>
        <div className="job-sub">{sub}</div>
        {it.directLink && (
          <button className="x-btn" style={{ marginTop: 4 }} onClick={() => copyDirectLink(it.directLink!, it.directReady ?? false)}>
            🔗 {it.directReady ? "Copy direct link" : "Copy fetch link"}
          </button>
        )}
      </div>
      <div className="job-right">
        <span className={"badge " + badgeCls}>{badge}</span>
        {working ? (
          <button className="x-btn" onClick={() => onCancel(it)}>
            Cancel
          </button>
        ) : (
          <button className="x-btn" onClick={() => onRemove(it.id)}>
            ✕
          </button>
        )}
      </div>
      {working && (
        <div className="job-prog">
          <div className="progress outer">
            <div className="progress inner" style={{ width: `${Math.max(2, pct)}%` }} />
          </div>
        </div>
      )}
    </div>
  );
}
