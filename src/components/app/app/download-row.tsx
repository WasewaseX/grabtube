"use client";

export function DownloadRow({
  disabled,
  onDownload,
  onDirectLink,
}: {
  disabled: boolean;
  onDownload: () => void;
  onDirectLink: () => void;
}) {
  return (
    <>
      <div className="dl-row">
        <button className="btn primary big" onClick={onDownload} disabled={disabled} style={{ flex: 1 }}>
          Download
        </button>
        <button
          className="btn ghost big"
          style={{ width: "auto", padding: "0 16px", whiteSpace: "nowrap" }}
          disabled={disabled}
          onClick={onDirectLink}
        >
          🔗 Direct link
        </button>
      </div>
      <div className="hint" style={{ marginTop: 8, textAlign: "center" }}>
        Direct link = the file downloaded to this server first, then you download it from here —
        resumable, no YouTube involved. Works in IDM / aria2 / any browser.
      </div>
    </>
  );
}
