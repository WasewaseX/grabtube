"use client";

import { toast } from "sonner";
import type { HistoryEntry } from "../../../hooks/use-downloader";
import { fmtBytes } from "./format-utils";

export function HistoryRow({ entry: h, onOpen }: { entry: HistoryEntry; onOpen: () => void }) {
  return (
    <div className="hist-item" onClick={onOpen}>
      <img className="hist-thumb" src={h.thumb} alt="" />
      <div className="hist-info">
        <div className="job-title">{h.title}</div>
        <div className="job-sub">
          {h.label} · {h.ext.toUpperCase()}
          {h.size ? ` · ${fmtBytes(h.size)}` : ""}
        </div>
      </div>
      <div className="hist-actions">
        {h.directUrl && (
          <button
            className="x-btn"
            title="Copy direct link (stored on the server)"
            onClick={(e) => {
              e.stopPropagation();
              const abs = `${window.location.origin}${h.directUrl}`;
              void navigator.clipboard?.writeText(abs).catch(() => undefined);
              toast.success("Direct link copied", {
                description: "The stored file downloads from this server with full resume support.",
              });
            }}
          >
            🔗
          </button>
        )}
        <button
          className="x-btn"
          title="Fetch again"
          onClick={(e) => e.stopPropagation()}
        >
          ↻
        </button>
      </div>
    </div>
  );
}
