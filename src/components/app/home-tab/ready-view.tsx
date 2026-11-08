"use client";

import { useMemo } from "react";
import { toast } from "sonner";
import { Link2, Music4 } from "lucide-react";

import { Button } from "../../../components/ui/button";
import { directLinkUrl } from "../../../lib/direct-link";
import { useLang } from "../../../hooks/use-lang";
import type { PublicFormat, PublicInfo } from "../../../lib/ytdlp";
import { AudioFormatsTable, VideoFormatsTable } from "./formats";
import { MediaCard, QuickActions } from "./ready-parts";
import { MP3_FMT } from "./mp3-format";

interface ReadyViewProps {
  info: PublicInfo;
  onStart: (fmt: PublicFormat, bitrate?: number) => void;
  onReset: () => void;
}

export function ReadyView({ info, onStart, onReset }: ReadyViewProps) {
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
      <MediaCard info={info} sourceLabel={sourceLabel} lang={lang} onReset={onReset} />
      <QuickActions best={best} fastest={fastest} mp3Count={info.mp3Options.length} onStart={onStart} />

      {/* download-manager hint */}
      <div className="flex items-start gap-2 rounded-lg border border-dashed bg-muted/30 p-3">
        <Link2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
        <div className="min-w-0">
          <p className="text-xs font-medium">{t("dlManagerTitle")}</p>
          <p className="text-[11px] leading-relaxed text-muted-foreground">{t("dlManagerDesc")}</p>
        </div>
      </div>

      <VideoFormatsTable info={info} onStart={onStart} onCopyLink={copyDirectLink} />
      <AudioFormatsTable info={info} onStart={onStart} onCopyLink={copyDirectLink} />

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
