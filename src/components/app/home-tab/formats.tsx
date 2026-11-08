"use client";

import { Download, Link2 } from "lucide-react";

import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { ScrollArea } from "../../../components/ui/scroll-area";
import { formatBytes } from "../../../lib/format-utils";
import { useLang } from "../../../hooks/use-lang";
import type { PublicFormat, PublicInfo } from "../../../lib/ytdlp";

interface Row {
  key: string;
  cells: React.ReactNode[];
  badges: string[];
  onStart: () => void;
  onCopyLink?: () => void;
  label: string;
}

function RowActions({ row }: { row: Row }) {
  const { t } = useLang();
  return (
    <div className="flex items-center justify-end gap-1.5">
      {row.badges.map((b) => (
        <Badge
          key={b}
          variant="outline"
          className="hidden px-1 py-0 text-[9px] font-normal text-muted-foreground sm:inline-flex"
        >
          {b}
        </Badge>
      ))}
      {row.onCopyLink && (
        <Button
          size="icon"
          variant="ghost"
          aria-label={`${t("copyLink")} ${row.label}`}
          title={`${t("copyLink")} (IDM / FDM / aria2)`}
          onClick={row.onCopyLink}
          className="h-7 w-7 text-muted-foreground hover:bg-primary/10 hover:text-primary"
        >
          <Link2 className="h-3.5 w-3.5" />
        </Button>
      )}
      <Button
        size="icon"
        variant="ghost"
        aria-label={`${t("download")} ${row.label}`}
        title={`${t("download")} ${row.label}`}
        onClick={row.onStart}
        className="h-7 w-7 text-primary hover:bg-primary/10 hover:text-primary"
      >
        <Download className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

export function FormatsTable({ title, head, rows }: { title: string; head: string[]; rows: Row[] }) {
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
                  <RowActions row={r} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollArea>
    </div>
  );
}

interface TableProps {
  info: PublicInfo;
  onStart: (fmt: PublicFormat, bitrate?: number) => void;
  onCopyLink: (fmt: PublicFormat, bitrate?: number) => void;
}

export function VideoFormatsTable({ info, onStart, onCopyLink }: TableProps) {
  const { t } = useLang();
  return (
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
        onCopyLink: () => onCopyLink(f),
        label: `${f.quality} ${f.container}`,
      }))}
    />
  );
}

export function AudioFormatsTable({ info, onStart, onCopyLink }: TableProps) {
  const { t } = useLang();
  return (
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
        onCopyLink: () => onCopyLink(f),
        label: `${f.quality} ${f.container}`,
      }))}
    />
  );
}
