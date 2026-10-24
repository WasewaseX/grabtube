"use client";

/**
 * YouWee — 1:1 port of the original desktop app UI.
 * Topbar (brand + ↺ history + ⚙ settings), URL card, video panel with
 * quality tiles / codec chips / audio segments, live job rows, and the
 * settings + history overlays. Powered by the hardened yt-dlp engine
 * (WARP egress lane, PO tokens, client rotation).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import "@/styles/youwee.css";
import { useDownloader, type DownloadItem } from "@/hooks/use-downloader";
import { LangProvider } from "@/hooks/use-lang";
import type { PublicFormat, PublicInfo } from "@/lib/ytdlp";

/* ------------------------------------------------------------------ */
/* constants (identical to the original VideoPanel)                    */
/* ------------------------------------------------------------------ */

const QUALITIES = ["2160p", "1440p", "1080p", "720p", "480p", "360p", "240p", "144p"];
const CODECS = ["H.264 (AVC)", "VP9", "AV1"];
const AUDIO = ["M4A", "MP3", "Opus", "FLAC", "WAV"];
const MP3_BITRATES = [320, 192, 128];

function fmtDuration(sec: number): string {
  if (!sec || sec <= 0) return "";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

function fmtBytes(b: number): string {
  if (!b || b <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = b;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function qualityHeight(q: string): number {
  return parseInt(q, 10) || 0;
}

function fmtHeight(f: PublicFormat): number {
  const m = f.quality?.match(/(\d{3,4})/);
  return m ? parseInt(m[1], 10) : 0;
}

function fmtCodec(f: PublicFormat): string | null {
  const v = (f.vcodec ?? "").toLowerCase();
  if (v.startsWith("h264") || v.startsWith("h.264") || v.startsWith("avc")) return "H.264 (AVC)";
  if (v.startsWith("vp9") || v.startsWith("vp09")) return "VP9";
  if (v.startsWith("av1") || v.startsWith("av01")) return "AV1";
  return null;
}

/* ------------------------------------------------------------------ */
/* root                                                                */
/* ------------------------------------------------------------------ */

export function DownloaderApp() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  return (
    <LangProvider initialLang="en">
      <div className="yw-app-root">
        <div className="app">
          <Header onOpenHistory={() => setHistoryOpen(true)} onOpenSettings={() => setSettingsOpen(true)} />
          <Downloader />
        </div>
        {settingsOpen && <Settings onClose={() => setSettingsOpen(false)} />}
        {historyOpen && <History onClose={() => setHistoryOpen(false)} />}
      </div>
    </LangProvider>
  );
}

/* ------------------------------------------------------------------ */
/* header                                                              */
/* ------------------------------------------------------------------ */

function Header({ onOpenSettings, onOpenHistory }: { onOpenSettings: () => void; onOpenHistory: () => void }) {
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

/* ------------------------------------------------------------------ */
/* downloader                                                          */
/* ------------------------------------------------------------------ */

function Downloader() {
  const dl = useDownloader();
  const [audioMode, setAudioMode] = useState(false);
  const [audioFmt, setAudioFmt] = useState("M4A");
  const [quality, setQuality] = useState("1080p");
  const [codec, setCodec] = useState("H.264 (AVC)");
  const [mp3Bitrate, setMp3Bitrate] = useState(320);

  const analyze = useCallback(() => {
    if (dl.url.trim()) void dl.fetchInfo(dl.url);
  }, [dl]);

  const info = dl.info;

  return (
    <main className="wrap">
      {/* ---------------- url card ---------------- */}
      <section className="card url-card">
        <div className="input-row">
          <div className="url-input">
            <span className="link-ico">🔗</span>
            <input
              value={dl.url}
              onChange={(e) => dl.setUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") analyze();
              }}
              placeholder="Paste YouTube link…"
              aria-label="YouTube URL"
              dir="ltr"
              spellCheck={false}
            />
          </div>
          <button className="btn primary" onClick={analyze} disabled={dl.phase === "loading" || !dl.url.trim()}>
            {dl.phase === "loading" ? "Fetching…" : "Fetch"}
          </button>
        </div>
        {dl.phase === "loading" && dl.pendingNote && (
          <div className="alert info" role="status" aria-live="polite">{dl.pendingNote}</div>
        )}
        {dl.phase === "error" && dl.errorMsg && <div className="alert err">{dl.errorMsg}</div>}
      </section>

      {/* ---------------- video panel ---------------- */}
      {info && (
        <VideoPanel
          info={info}
          audioMode={audioMode}
          setAudioMode={setAudioMode}
          quality={quality}
          setQuality={setQuality}
          codec={codec}
          setCodec={setCodec}
          audioFmt={audioFmt}
          setAudioFmt={setAudioFmt}
          mp3Bitrate={mp3Bitrate}
          setMp3Bitrate={setMp3Bitrate}
          onStart={(fmt, bitrate) => {
            void dl.startDownload(fmt, info, bitrate);
          }}
          onDirectLink={(fmt, bitrate) => {
            void dl.getDirectLink(fmt, info, bitrate);
          }}
        />
      )}

      {/* ---------------- jobs ---------------- */}
      <JobsList items={dl.items} onCancel={dl.cancelItem} onRemove={dl.removeItem} onClearFinished={dl.clearFinished} />
    </main>
  );
}

/* ------------------------------------------------------------------ */
/* video panel (quality tiles + codec chips + audio segments)          */
/* ------------------------------------------------------------------ */

interface VideoPanelProps {
  info: PublicInfo;
  audioMode: boolean;
  setAudioMode: (v: boolean) => void;
  quality: string;
  setQuality: (q: string) => void;
  codec: string;
  setCodec: (c: string) => void;
  audioFmt: string;
  setAudioFmt: (a: string) => void;
  mp3Bitrate: number;
  setMp3Bitrate: (b: number) => void;
  onStart: (fmt: PublicFormat, bitrate?: number) => void;
  onDirectLink: (fmt: PublicFormat, bitrate?: number) => void;
}

function VideoPanel(p: VideoPanelProps) {
  const { info } = p;
  const vids = info.videoFormats ?? [];
  const auds = info.audioFormats ?? [];

  /* keep selection valid when a new video arrives */
  useEffect(() => {
    const heights = new Set(vids.map(fmtHeight));
    if (!heights.has(qualityHeight(p.quality))) {
      const best = [...heights].sort((a, b) => b - a).find((h) => h <= 1080) ?? [...heights][0];
      if (best) p.setQuality(`${best}p`);
    }
  }, [info.infoId]);

  const selHeight = qualityHeight(p.quality);

  /* ---------- video selection ---------- */
  const atHeight = useMemo(() => vids.filter((f) => fmtHeight(f) === selHeight), [vids, selHeight]);
  const codecAvailable = useMemo(() => {
    const set = new Set<string>();
    for (const f of vids) {
      const c = fmtCodec(f);
      if (c) set.add(c);
    }
    return set;
  }, [vids]);
  const pick = useCallback(
    (wantCodec: string) => {
      const exact = atHeight.find((f) => fmtCodec(f) === wantCodec);
      if (exact) return exact;
      const anyAt = atHeight[0];
      if (anyAt) return anyAt;
      const lower = vids
        .filter((f) => fmtHeight(f) < selHeight && fmtCodec(f) === wantCodec)
        .sort((a, b) => fmtHeight(b) - fmtHeight(a));
      return lower[0] ?? vids.sort((a, b) => fmtHeight(b) - fmtHeight(a))[0] ?? null;
    },
    [atHeight, selHeight, vids],
  );
  const chosen = useMemo(() => pick(p.codec), [pick, p.codec]);

  /* ---------- audio selection ---------- */
  const audioPick = useCallback(
    (name: string): PublicFormat | null => {
      if (name === "M4A") {
        const native = auds.find((a) => a.container === "m4a");
        return native ?? { id: "convert", kind: "audio", quality: "Audio", container: "m4a", instant: false, needsMerge: false };
      }
      if (name === "Opus") {
        const native = auds.find((a) => a.container === "webm" || a.container === "opus");
        return native ?? { id: "convert", kind: "audio", quality: "Audio", container: "opus", instant: false, needsMerge: false };
      }
      if (name === "MP3")
        return { id: "convert", kind: "audio", quality: "Audio", container: "mp3", instant: false, needsMerge: false };
      if (name === "FLAC")
        return { id: "convert", kind: "audio", quality: "Audio", container: "flac", instant: false, needsMerge: false };
      if (name === "WAV")
        return { id: "convert", kind: "audio", quality: "Audio", container: "wav", instant: false, needsMerge: false };
      return null;
    },
    [auds],
  );

  const audioChosen = audioPick(p.audioFmt);
  const containers = useMemo(() => {
    const set = new Set<string>();
    for (const f of vids) set.add(f.container);
    if (set.size === 0) set.add("mp4");
    return [...set].join(" · ");
  }, [vids]);

  const download = () => {
    if (p.audioMode) {
      if (audioChosen) p.onStart(audioChosen, p.audioFmt === "MP3" ? p.mp3Bitrate : undefined);
    } else if (chosen) {
      p.onStart(chosen);
    }
  };

  const disabled = p.audioMode ? !audioChosen : !chosen;

  return (
    <section className="card video-card">
      <div className="video-head">
        <div className="thumb">
          <img src={info.thumbnail} alt={info.title} />
        </div>
        <div className="vp-info">
          <div className="vp-title">{info.title}</div>
          <div className="vp-sub">
            {info.author} · {fmtDuration(info.duration)}
            {info.views ? ` · ${info.views.toLocaleString("en-US")} views` : ""}
          </div>
        </div>
      </div>

      <div className="seg-row">
        <button className={"seg" + (!p.audioMode ? " active" : "")} onClick={() => p.setAudioMode(false)}>
          Video
        </button>
        <button className={"seg" + (p.audioMode ? " active" : "")} onClick={() => p.setAudioMode(true)}>
          Audio
        </button>
      </div>

      {!p.audioMode ? (
        <>
          <div className="quality-grid">
            {QUALITIES.map((q) => {
              const h = qualityHeight(q);
              const has = vids.some((f) => fmtHeight(f) === h);
              return (
                <button
                  key={q}
                  className={"quality-tile" + (p.quality === q ? " active" : "")}
                  onClick={() => setQualityLocal(p, q)}
                  disabled={!has}
                >
                  {q}
                </button>
              );
            })}
          </div>
          <div className="codec-row">
            {CODECS.map((c) => (
              <button
                key={c}
                className={"chip" + (p.codec === c ? " active" : "")}
                onClick={() => p.setCodec(c)}
                disabled={!codecAvailable.has(c)}
              >
                {c}
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="seg-list audio-list">
            {AUDIO.map((a) => (
              <button
                key={a}
                className={"seg" + (p.audioFmt === a ? " active" : "")}
                onClick={() => p.setAudioFmt(a)}
              >
                {a}
              </button>
            ))}
          </div>
          {p.audioFmt === "MP3" && (
            <div className="codec-row">
              {MP3_BITRATES.map((b) => (
                <button
                  key={b}
                  className={"chip" + (p.mp3Bitrate === b ? " active" : "")}
                  onClick={() => p.setMp3Bitrate(b)}
                >
                  {b} kbps
                </button>
              ))}
            </div>
          )}
        </>
      )}

      <div className="meta-row">
        <span className="muted">Container</span> {containers}
      </div>

      <div className="dl-row">
        <button className="btn primary big" onClick={download} disabled={disabled} style={{ flex: 1 }}>
          Download
        </button>
        <button
          className="btn ghost big"
          style={{ width: "auto", padding: "0 16px", whiteSpace: "nowrap" }}
          disabled={disabled}
          onClick={() => {
            const fmt = p.audioMode ? audioChosen : chosen;
            if (!fmt) return;
            p.onDirectLink(fmt, p.audioFmt === "MP3" ? p.mp3Bitrate : undefined);
          }}
        >
          🔗 Direct link
        </button>
      </div>
      <div className="hint" style={{ marginTop: 8, textAlign: "center" }}>
        Direct link = the file downloaded to this server first, then you download it from here —
        resumable, no YouTube involved. Works in IDM / aria2 / any browser.
      </div>
    </section>
  );
}

/** quality click also snaps the codec chip to one available at that height */
function setQualityLocal(p: VideoPanelProps, q: string) {
  p.setQuality(q);
  const h = qualityHeight(q);
  const at = p.info.videoFormats.filter((f) => fmtHeight(f) === h);
  if (at.length && !at.some((f) => fmtCodec(f) === p.codec)) {
    const c = fmtCodec(at[0]);
    if (c) p.setCodec(c);
  }
}

/* ------------------------------------------------------------------ */
/* jobs list                                                           */
/* ------------------------------------------------------------------ */

function JobsList({
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

function JobRow({
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
  let badge = "";
  let badgeCls = "ok";
  if (it.state === "done") {
    badge = "Ready";
    badgeCls = "ok";
  } else if (it.state === "error") {
    badge = "Failed";
    badgeCls = "err";
  } else if (it.state === "cancelled") {
    badge = "Cancelled";
    badgeCls = "err";
  } else if (it.state === "merging") {
    badge = "Merging";
    badgeCls = "warn";
  } else if (it.state === "queued" || it.state === "starting") {
    badge = "Starting";
    badgeCls = "warn";
  } else {
    badge = `${pct}%`;
    badgeCls = "warn";
  }

  const sub = [
    it.label,
    it.total > 0 ? fmtBytes(it.total) : "",
    working && it.speed > 0 ? `${fmtBytes(it.speed)}/s` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="job-row">
      <div style={{ minWidth: 0 }}>
        <div className="job-title">{it.title}</div>
        <div className="job-sub">{sub}</div>
        {it.directLink && (
          <button
            className="x-btn"
            style={{ marginTop: 4 }}
            onClick={() => {
              const abs = `${window.location.origin}${it.directLink}`;
              void navigator.clipboard?.writeText(abs).catch(() => undefined);
              if (it.directReady) {
                toast.success("Direct link copied", {
                  description: "The file is stored on the YouWee server — this link downloads it from here with full resume support (IDM, aria2, any browser).",
                });
              } else {
                toast.info("Fetch-first link copied", {
                  description: "The server downloads the file first; your download manager will retry automatically and land on the finished file.",
                });
              }
            }}
          >
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

/* ------------------------------------------------------------------ */
/* settings overlay                                                    */
/* ------------------------------------------------------------------ */

function Settings({ onClose }: { onClose: () => void }) {
  const [proxies, setProxies] = useState("");
  const [cookies, setCookies] = useState("");
  const [hasCookies, setHasCookies] = useState(false);
  const [lanes, setLanes] = useState<{ id: string; label: string; healthy: boolean; active: boolean; egressIp?: string | null; note?: string }[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/settings");
        const j = await res.json();
        setProxies(j.extraProxies ?? "");
        setHasCookies(Boolean(j.cookiesConfigured));
        setLanes(j.lanes ?? []);
      } catch {
        /* overlay still renders */
      }
    })();
  }, []);

  const save = async () => {
    setSaving(true);
    setSaved(false);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ extraProxies: proxies, ...(cookies.trim() ? { cookies } : {}) }),
      });
      if (res.ok) {
        setSaved(true);
        setCookies("");
        const j = await fetch("/api/settings").then((r) => r.json());
        setLanes(j.lanes ?? []);
        setHasCookies(Boolean(j.cookiesConfigured));
        setTimeout(() => setSaved(false), 2200);
      }
    } finally {
      setSaving(false);
    }
  };

  const active = lanes.find((l) => l.active);

  return (
    <div className="settings-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label="Settings">
      <div className="settings-card" onClick={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <div className="settings-title">Settings</div>
          <button className="icon-btn" onClick={onClose} aria-label="Close settings">
            ✕
          </button>
        </div>

        <div className="field">
          <div className="lane-note">
            <span className={"lane-dot" + (active?.healthy ? " ok" : "")} />
            <span>
              Egress lane: <b style={{ color: "var(--text)" }}>{active?.label ?? "…"}</b>
              {active?.healthy ? " · healthy" : " · probing…"}
              {active?.egressIp ? ` · ${active.egressIp}` : ""}
            </span>
          </div>
          <div className="hint">
            The engine routes YouTube traffic through a Cloudflare WARP tunnel to bypass datacenter-IP bot walls.
            User proxies are used as fallback lanes.
          </div>
        </div>

        <div className="field">
          <label htmlFor="yw-proxies">Extra proxies (one per line)</label>
          <textarea
            id="yw-proxies"
            rows={3}
            dir="ltr"
            spellCheck={false}
            value={proxies}
            onChange={(e) => setProxies(e.target.value)}
            placeholder={"http://user:pass@host:port\nsocks5://host:1080"}
          />
          <div className="hint">http / socks4 / socks5. Used when the WARP tunnel is unhealthy.</div>
        </div>

        <div className="field">
          <label htmlFor="yw-cookies">YouTube cookies.txt {hasCookies ? "· configured ✓" : ""}</label>
          <textarea
            id="yw-cookies"
            rows={4}
            dir="ltr"
            spellCheck={false}
            value={cookies}
            onChange={(e) => setCookies(e.target.value)}
            placeholder="# Netscape HTTP Cookie File … (optional — permanent fix for hard-flagged IPs)"
          />
          <div className="hint">
            Export cookies.txt from a signed-in browser (privacy: stored server-side, mode 0600). Optional — the
            tunnel + PO tokens usually suffice.
          </div>
        </div>

        <div className="settings-actions">
          <button className="btn ghost" onClick={onClose}>
            Close
          </button>
          <button className="btn primary" onClick={() => void save()} disabled={saving}>
            {saving ? "Saving…" : saved ? "Saved ✓" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* history overlay                                                     */
/* ------------------------------------------------------------------ */

function History({ onClose }: { onClose: () => void }) {
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
            <div
              key={h.id}
              className="hist-item"
              onClick={() => {
                if (h.videoUrl) {
                  dl.setUrl(h.videoUrl);
                  void dl.fetchInfo(h.videoUrl);
                }
                onClose();
              }}
            >
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
          ))
        )}
      </div>
    </div>
  );
}
