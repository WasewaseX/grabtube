"use client";

import { Download, Music4, Zap } from "lucide-react";

import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { formatDuration, formatViews } from "../../../lib/format-utils";
import { useLang } from "../../../hooks/use-lang";
import type { PublicFormat, PublicInfo } from "../../../lib/ytdlp";
import { MP3_FMT } from "./mp3-format";

export function MediaCard({
  info,
  sourceLabel,
  lang,
  onReset,
}: {
  info: PublicInfo;
  sourceLabel: string;
  lang: "en" | "fa";
  onReset: () => void;
}) {
  const { t } = useLang();

  return (
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
  );
}

interface QuickActionsProps {
  best?: PublicFormat;
  fastest?: PublicFormat;
  mp3Count: number;
  onStart: (fmt: PublicFormat, bitrate?: number) => void;
}

export function QuickActions({ best, fastest, mp3Count, onStart }: QuickActionsProps) {
  const { t } = useLang();

  return (
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
        disabled={mp3Count === 0}
        onClick={() => onStart(MP3_FMT, 320)}
      >
        <Music4 className="h-3.5 w-3.5" />
        {t("quickMp3")}
      </Button>
    </div>
  );
}
