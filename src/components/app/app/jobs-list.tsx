"use client";

import type { DownloadItem } from "../../../hooks/use-downloader";
import { JobRow } from "./job-row";

export function JobsList({
  items,
  onCancel,
  onRemove,
  onClearFinished,
}: {
  items: DownloadItem[];
  onCancel: (item: DownloadItem) => void;
  onRemove: (id: string) => void;
  onClearFinished: () => void;
}) {
  if (items.length === 0) {
    return (
      <section className="card">
        <div className="jobs-empty">No downloads yet — fetch a link and pick a quality above.</div>
      </section>
    );
  }
  const finished = items.every((it) => ["done", "error", "cancelled"].includes(it.state));
  return (
    <section className="card">
      <div className="settings-head">
        <div className="settings-title" style={{ fontSize: 14 }}>
          Downloads
        </div>
        {finished && (
          <button className="x-btn" onClick={onClearFinished}>
            Clear finished
          </button>
        )}
      </div>
      <div className="jobs-scroll">
        {items.map((it) => (
          <JobRow key={it.id} it={it} onCancel={onCancel} onRemove={onRemove} />
        ))}
      </div>
    </section>
  );
}
