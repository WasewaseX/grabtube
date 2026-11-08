"use client";

import { useDownloader } from "../../../hooks/use-downloader";
import { HistoryRow } from "./history-row";

export function History({ onClose }: { onClose: () => void }) {
  const dl = useDownloader();
  const entries = dl.history;

  return (
    <div className="history-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label="History">
      <div className="history-card" onClick={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <div className="settings-title">History</div>
          <div style={{ display: "flex", gap: 8 }}>
            {entries.length > 0 && (
              <button className="x-btn" onClick={dl.clearHistory}>
                Clear all
              </button>
            )}
            <button className="icon-btn" onClick={onClose} aria-label="Close history">
              ✕
            </button>
          </div>
        </div>
        {entries.length === 0 ? (
          <div className="jobs-empty">Nothing here yet — finished downloads land in history.</div>
        ) : (
          entries.map((h) => (
            <HistoryRow
              key={h.id}
              entry={h}
              onOpen={() => {
                if (h.videoUrl) {
                  dl.setUrl(h.videoUrl);
                  void dl.fetchInfo(h.videoUrl);
                }
                onClose();
              }}
            />
          ))
        )}
      </div>
    </div>
  );
}
