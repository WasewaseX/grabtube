"use client";

import { useMemo } from "react";
import { toast } from "sonner";
import {
  ClipboardPaste,
  Download,
  Link2,
  Loader2,
  Music4,
  RotateCcw,
  Search,
  TriangleAlert,
  X,
  Zap,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { PublicFormat, PublicInfo } from "@/lib/ytdlp";
import { directLinkUrl } from "@/lib/direct-link";
import { errorKey, type TKey } from "@/lib/i18n";
import { formatBytes, formatDuration, formatViews } from "@/lib/format-utils";
import { useLang } from "@/hooks/use-lang";
import type { HistoryEntry } from "@/hooks/use-downloader";

interface Props {
  url: string;
  setUrl: (u: string) => void;
  phase: "idle" | "loading" | "ready" | "error";
  info: PublicInfo | null;
  errorMsg: string | null;
  errorCode: string | null;
  history: HistoryEntry[];
  onFetch: (u: string) => void;
  onReset: () => void;
  onStart: (fmt: PublicFormat, bitrate?: number) => void;
}

export function HomeTab(props: Props) {
  const { t } = useLang();
  const { phase, info } = props;

  return (
    <section className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4" aria-label="Download home">
      {/* URL row */}
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          props.onFetch(props.url);
        }}
      >
        <div className="relative flex-1">
          <Link2 className="pointer-events-none absolute start-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={props.url}
            onChange={(e) => props.setUrl(e.target.value)}
            placeholder={t("placeholder")}
            dir="ltr"
            spellCheck={false}
            aria-label="Video URL"
            className="h-10 rounded-lg bg-card ps-9 pe-9 text-sm"
          />
          {props.url && (
            <button
              type="button"
              onClick={() => props.setUrl("")}
              aria-label={t("clear")}
              className="absolute end-2 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        <Button
          type="button"
          variant="secondary"
          size="icon"
          aria-label={t("paste")}
          className="h-10 w-10 shrink-0"
          onClick={async () => {
            try {
              const text = await navigator.clipboard.readText();
              if (text) {
                props.setUrl(text);
                props.onFetch(text);
              }
            } catch {
              /* clipboard denied */
            }
          }}
        >
          <ClipboardPaste className="h-4 w-4" />
        </Button>
        <Button type="submit" disabled={phase === "loading" || !props.url.trim()} className="h-10 shrink-0 gap-1.5">
          {phase === "loading" ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              {t("fetching")}
            </>
          ) : (
            <>
              <Search className="h-4 w-4" />
              {t("fetch")}
            </>
          )}
        </Button>
      </form>

      {phase === "idle" && <IdleHint history={props.history} />}
      {phase === "loading" && <SkeletonList />}
      {phase === "error" && (
        <ErrorCard
          code={props.errorCode || "FETCH_FAILED"}
          msg={props.errorMsg}
          onRetry={() => props.onFetch(props.url)}
        />
      )}
      {phase === "ready" && info && <ReadyView info={info} onStart={props.onStart} onReset={props.onReset} />}
    </section>
  );
}

/* ------------------------------------------------------------------ */

function IdleHint({ history }: { history: HistoryEntry[] }) {
  const { t } = useLang();
  return (
    <div className="flex flex-col items-center gap-3 py-10 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10">
        <Download className="h-8 w-8 text-primary" />
      </div>
      <p className="max-w-sm text-sm text-muted-foreground">{t("enterUrl")}</p>
      {history.length > 0 && (
        <div className="mt-2 flex flex-wrap justify-center gap-1.5">
          {history.slice(0, 4).map((h) => (
            <span
              key={h.id}
              className="max-w-52 truncate rounded-full border bg-card px-2.5 py-0.5 text-[11px] text-muted-foreground"
              title={h.title}
            >
              {h.title}
            </span>
          ))}
        </div>
      )}
      <p className="text-[11px] text-muted-foreground/70">
        YouTube · Shorts · TikTok · X · Instagram · Vimeo · +1000
      </p>
    </div>
  );
}

function SkeletonList() {
  return (
    <div className="flex flex-col gap-2" aria-busy="true">
      <div className="h-24 animate-pulse rounded-lg bg-muted" />
      <div className="h-9 animate-pulse rounded-md bg-muted" />
      <div className="h-9 animate-pulse rounded-md bg-muted" />
      <div className="h-9 animate-pulse rounded-md bg-muted" />
    </div>
  );
}

function ErrorCard({ code, msg, onRetry }: { code: string; msg: string | null; onRetry: () => void }) {
  const { t } = useLang();
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-4">
      <div className="flex items-center gap-2">
        <TriangleAlert className="h-4 w-4 text-destructive" />
        <span className="text-sm font-semibold">{t("errorTitle")}</span>
        <code className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{code}</code>
      </div>
      <p className="text-xs text-muted-foreground">{t(errorKey(code))}</p>
      {msg && code !== "FETCH_FAILED" && <p className="text-[11px] text-muted-foreground/70">{msg}</p>}
      <Button variant="outline" size="sm" onClick={onRetry} className="mt-1 w-fit gap-1.5">
        <RotateCcw className="h-3.5 w-3.5" />
        {t("retry")}
      </Button>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function ReadyView({
  info,
  onStart,
  onReset,
}: {
  info: PublicInfo;
  onStart: (fmt: PublicFormat, bitrate?: number) => void;
  onReset: () => void;
}) {
  const { t, lang } = useLang();

  const best = info.videoFormats[0];
  const fastest = useMemo(() => {
    const instant = info.videoFormats.filter((f) => f.instant && f.hasAudio);
    return instant.length > 0 ? instant[instant.length - 1] : undefined;
  }, [info]);

  const copyDirectLink = (fmt: PublicFormat, bitrate?: number) => {
    const link = directLinkUrl(window.location.origin, {
      webpageUrl: info.webpageUrl,
      format: bitrate ? "mp3" : fmt.id,
      quality: bitrate ? `MP3 ${bitrate}` : fmt.quality,
      title: info.title,
      bitrate,
    });
    navigator.clipboard
      .writeText(link)
      .then(() => toast.success(t("linkCopied"), { description: t("linkCopiedDesc") }))
      .catch(() => window.prompt(t("linkCopied"), link));
  };

  const sourceLabel =
    info.source === "youtube" || info.source === "other"
      ? t("sourceEngine")
      : t("viaProvider", { provider: info.source });

  return (
    <div className="flex flex-col gap-4">
      {/* media card */}
      <div className="flex gap-3 rounded-lg border bg-card p-3">
        <div className="relative aspect-video w-40 shrink-0 overflow-hidden rounded-md bg-muted sm:w-48">
          {info.thumbnail ? (
            <img src={info.thumbnail} alt="" className="h-full w-full object-cover" />
          ) : null}
          <span
            dir="ltr"
            className="absolute bottom-1 end-1 rounded bg-black/75 px-1 text-[10px] font-medium text-white"
          >
            {formatDuration(info.duration)}
          </span>
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h2 className="line-clamp-2 text-sm font-semibold leading-snug" title={info.title}>
            {info.title}
          </h2>
          <p className="text-xs text-muted-foreground">
            {info.author}
            {info.views > 0 && (
              <>
                {" · "}
                {formatViews(info.views, lang)} {t("views")}
              </>
            )}
          </p>
          <div className="mt-auto flex items-center gap-2">
            <Badge variant="secondary" className="text-[10px] font-normal">
              {sourceLabel}
            </Badge>
            <Button variant="ghost" size="sm" onClick={onReset} className="h-6 px-2 text-[11px] text-muted-foreground">
              {t("newVideo")}
            </Button>
          </div>
        </div>
      </div>

      {/* quick actions */}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          className="h-8 gap-1.5"
          disabled={!best}
          onClick={() => best && onStart(best)}
        >
          <Zap className="h-3.5 w-3.5" />
          {t("quickBest")}
          {best && <span className="opacity-80">· {best.quality}</span>}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          className="h-8 gap-1.5"
          disabled={!fastest}
          onClick={() => fastest && onStart(fastest)}
        >
          <Download className="h-3.5 w-3.5" />
          {t("quickFastest")}
          {fastest && <span className="opacity-80">· {fastest.quality}</span>}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          className="h-8 gap-1.5"
          disabled={info.mp3Options.length === 0}
          onClick={() => onStart(MP3_FMT, 320)}
        >
          <Music4 className="h-3.5 w-3.5" />
          {t("quickMp3")}
        </Button>
      </div>

      {/* download-manager hint */}
      <div className="flex items-start gap-2 rounded-lg border border-dashed bg-muted/30 p-3">
        <Link2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
        <div className="min-w-0">
          <p className="text-xs font-medium">{t("dlManagerTitle")}</p>
          <p className="text-[11px] leading-relaxed text-muted-foreground">{t("dlManagerDesc")}</p>
        </div>
      </div>

      {/* video formats */}
      {info.videoFormats.length > 0 && (
        <FormatsTable
          title={t("videoFormats")}
          head={[
            t("colQuality"),
            t("colFps"),
            t("colVideo"),
            t("colAudio"),
            t("colContainer"),
            t("colSize"),
            "",
          ]}
          rows={info.videoFormats.map((f) => ({
            key: f.id,
            cells: [
              <span key="q" className="flex items-center gap-1.5 font-medium" dir="ltr">
                {f.quality}
                {f.hdr && <Badge className="px-1 py-0 text-[9px]">{t("hdr")}</Badge>}
                {f.recommended && <Badge variant="secondary" className="px-1 py-0 text-[9px]">{t("recommended")}</Badge>}
              </span>,
              <span key="fps" dir="ltr">{f.fps ? String(f.fps) : "—"}</span>,
              <span key="v" dir="ltr">{f.vcodec || "—"}</span>,
              <span key="a" dir="ltr">{f.acodec || "—"}</span>,
              <span key="c" dir="ltr" className="uppercase">{f.container}</span>,
              <span key="s" dir="ltr" title={f.approx ? "≈" : undefined}>
                {f.approx ? "≈ " : ""}
                {formatBytes(f.filesize)}
              </span>,
            ],
            badges: [
              f.instant ? t("direct") : t("merge"),
            ],
            onStart: () => onStart(f),
            onCopyLink: () => copyDirectLink(f),
            label: `${f.quality} ${f.container}`,
          }))}
        />
      )}

      {/* audio formats */}
      {info.audioFormats.length > 0 && (
        <FormatsTable
          title={t("audioFormats")}
          head={[t("colQuality"), t("colAudio"), t("colContainer"), t("colSize"), ""]}
          rows={info.audioFormats.map((f) => ({
            key: f.id,
            cells: [
              <span key="q" className="font-medium" dir="ltr">{f.quality}</span>,
              <span key="a" dir="ltr">{f.acodec || "—"}</span>,
              <span key="c" dir="ltr" className="uppercase">{f.container}</span>,
              <span key="s" dir="ltr" title={f.approx ? "≈" : undefined}>
                {f.approx ? "≈ " : ""}
                {formatBytes(f.filesize)}
              </span>,
            ],
            badges: [],
            onStart: () => onStart(f),
            onCopyLink: () => copyDirectLink(f),
            label: `${f.quality} ${f.container}`,
          }))}
        />
      )}

      {/* MP3 */}
      {info.mp3Options.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card p-3">
          <Music4 className="h-4 w-4 text-primary" />
          <span className="text-xs font-semibold">{t("mp3Convert")}</span>
          <div className="ms-auto flex gap-1.5">
            {info.mp3Options.map((b) => (
              <Button
                key={b}
                size="sm"
                variant="secondary"
                className="h-7 text-[11px]"
                dir="ltr"
                onClick={() => onStart(MP3_FMT, b)}
              >
                {b} kbps
              </Button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const MP3_FMT: PublicFormat = {
  id: "mp3",
  kind: "audio",
  quality: "mp3",
  container: "mp3",
  hasAudio: true,
  needsMerge: false,
  instant: false,
};

/* ------------------------------------------------------------------ */

interface Row {
  key: string;
  cells: React.ReactNode[];
  badges: string[];
  onStart: () => void;
  onCopyLink?: () => void;
  label: string;
}

function FormatsTable({ title, head, rows }: { title: string; head: string[]; rows: Row[] }) {
  const { t } = useLang();
  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      <div className="border-b px-3 py-2 text-xs font-semibold">{title}</div>
      <ScrollArea className="max-h-72">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-muted/80 backdrop-blur">
            <tr>
              {head.map((h, i) => (
                <th
                  key={i}
                  className="px-3 py-1.5 text-start font-medium text-muted-foreground"
                >
                  {h}
                </th>
              ))}
              <th className="px-3 py-1.5" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="border-t transition-colors hover:bg-accent/40">
                {r.cells.map((c, i) => (
                  <td key={i} className="px-3 py-1.5">
                    {c}
                  </td>
                ))}
                <td className="px-3 py-1.5">
                  <div className="flex items-center justify-end gap-1.5">
                    {r.badges.map((b) => (
                      <Badge
                        key={b}
                        variant="outline"
                        className="hidden px-1 py-0 text-[9px] font-normal text-muted-foreground sm:inline-flex"
                      >
                        {b}
                      </Badge>
                    ))}
                    {r.onCopyLink && (
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={`${t("copyLink")} ${r.label}`}
                        title={`${t("copyLink")} (IDM / FDM / aria2)`}
                        onClick={r.onCopyLink}
                        className="h-7 w-7 text-muted-foreground hover:bg-primary/10 hover:text-primary"
                      >
                        <Link2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`${t("download")} ${r.label}`}
                      title={`${t("download")} ${r.label}`}
                      onClick={r.onStart}
                      className="h-7 w-7 text-primary hover:bg-primary/10 hover:text-primary"
                    >
                      <Download className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollArea>
    </div>
  );
}
