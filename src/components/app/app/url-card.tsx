"use client";

interface UrlCardProps {
  url: string;
  onUrlChange: (v: string) => void;
  onSubmit: () => void;
  loading: boolean;
  pendingNote: string | null;
  errorMsg: string | null;
}

export function UrlCard({ url, onUrlChange, onSubmit, loading, pendingNote, errorMsg }: UrlCardProps) {
  return (
    <section className="card url-card">
      <div className="input-row">
        <div className="url-input">
          <span className="link-ico">🔗</span>
          <input
            value={url}
            onChange={(e) => onUrlChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onSubmit();
            }}
            placeholder="Paste YouTube link…"
            aria-label="YouTube URL"
            dir="ltr"
            spellCheck={false}
          />
        </div>
        <button className="btn primary" onClick={onSubmit} disabled={loading || !url.trim()}>
          {loading ? "Fetching…" : "Fetch"}
        </button>
      </div>
      {loading && pendingNote && (
        <div className="alert info" role="status" aria-live="polite">{pendingNote}</div>
      )}
      {errorMsg && <div className="alert err">{errorMsg}</div>}
    </section>
  );
}
