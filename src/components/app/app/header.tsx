export function Header({ onOpenSettings, onOpenHistory }: { onOpenSettings: () => void; onOpenHistory: () => void }) {
  return (
    <header className="topbar">
      <div className="brand">
        <div className="logo">▶</div>
        <div>
          <div className="brand-name">YouWee</div>
          <div className="brand-sub">YouTube Downloader</div>
        </div>
      </div>
      <div className="top-actions">
        <button className="icon-btn" title="History" aria-label="History" onClick={onOpenHistory}>
          ↺
        </button>
        <button className="icon-btn" title="Settings" aria-label="Settings" onClick={onOpenSettings}>
          ⚙
        </button>
      </div>
    </header>
  );
}
