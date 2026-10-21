"use client";

import { ExternalLink, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { HistoryEntry } from "@/hooks/use-downloader";
import { formatBytes } from "@/lib/format-utils";
import { useLang } from "@/hooks/use-lang";

interface Props {
  history: HistoryEntry[];
  onClear: () => void;
}

export function HistoryTab({ history, onClear }: Props) {
  const { t, lang } = useLang();

  return (
    <section className="mx-auto flex w-full max-w-3xl flex-col gap-3 p-4" aria-label="History">
      <div className="flex items-center">
        <h2 className="text-sm font-semibold">{t("historyTitle")}</h2>
        {history.length > 0 && (
          <Button variant="ghost" size="sm" onClick={onClear} className="ms-auto h-7 gap-1 text-[11px] text-muted-foreground">
            <Trash2 className="h-3 w-3" />
            {t("clearAll")}
          </Button>
        )}
      </div>

      {history.length === 0 && (
        <div className="rounded-lg border border-dashed p-8 text-center text-xs text-muted-foreground">
          {t("historyEmpty")}
        </div>
      )}

      <div className="flex flex-col gap-2">
        {history.map((h) => (
          <div key={h.id} className="flex items-center gap-3 rounded-lg border bg-card p-2.5">
            <div className="aspect-video w-16 shrink-0 overflow-hidden rounded bg-muted">
              {h.thumb && (
                    <img src={h.thumb} alt="" className="h-full w-full object-cover" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium" title={h.title}>
                {h.title}
              </p>
              <p className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                <span dir="ltr" className="rounded bg-muted px-1.5 py-px">{h.label}</span>
                <span dir="ltr">{formatBytes(h.size)}</span>
                <span dir="ltr">
                  {new Date(h.at).toLocaleString(lang === "fa" ? "fa-IR" : "en-GB", {
                    dateStyle: "short",
                    timeStyle: "short",
                  })}
                </span>
              </p>
            </div>
            {h.videoUrl && (
              <a
                href={h.videoUrl}
                target="_blank"
                rel="noreferrer noopener"
                aria-label={t("openLink")}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
