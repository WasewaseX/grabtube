"use client";

import { Check, Loader2, Trash2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import type { DownloadItem } from "@/hooks/use-downloader";
import { errorKey } from "@/lib/i18n";
import { formatBytes, formatSpeed } from "@/lib/format-utils";
import { useLang } from "@/hooks/use-lang";

interface Props {
  items: DownloadItem[];
  onCancel: (item: DownloadItem) => void;
  onRemove: (id: string) => void;
  onClearFinished: () => void;
}

export function DownloadsTab({ items, onCancel, onRemove, onClearFinished }: Props) {
  const { t } = useLang();
  const finished = items.filter((it) => ["done", "cancelled", "error"].includes(it.state)).length;

  return (
    <section className="mx-auto flex w-full max-w-3xl flex-col gap-3 p-4" aria-label="Downloads">
      <div className="flex items-center">
        <h2 className="text-sm font-semibold">{t("queueTitle")}</h2>
        {finished > 0 && (
          <Button variant="ghost" size="sm" onClick={onClearFinished} className="ms-auto h-7 gap-1 text-[11px] text-muted-foreground">
            <Trash2 className="h-3 w-3" />
            {t("clearFinished")}
          </Button>
        )}
      </div>

      {items.length === 0 && (
        <div className="rounded-lg border border-dashed p-8 text-center text-xs text-muted-foreground">
          {t("queueEmpty")}
        </div>
      )}

      <div className="flex flex-col gap-2">
        {items.map((item) => (
          <ItemRow key={item.id} item={item} onCancel={onCancel} onRemove={onRemove} />
        ))}
      </div>
    </section>
  );
}

function ItemRow({
  item,
  onCancel,
  onRemove,
}: {
  item: DownloadItem;
  onCancel: (i: DownloadItem) => void;
  onRemove: (id: string) => void;
}) {
  const { t } = useLang();

  const active = ["starting", "queued", "downloading", "merging", "saving"].includes(item.state);
  const pct = item.total > 0 ? Math.min(100, Math.round((item.received / item.total) * 100)) : item.state === "done" ? 100 : 0;

  const stateLabel: Record<string, string> = {
    starting: t("phaseStarting"),
    queued: t("phaseQueued"),
    downloading: t("phaseDownloading"),
    merging: t("phaseMerging"),
    saving: t("phaseSaving"),
    done: t("phaseDone"),
    error: t("phaseError"),
    cancelled: t("phaseCancelled"),
  };

  return (
    <div className="flex flex-col gap-1.5 rounded-lg border bg-card p-3">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium" title={item.title}>
            {item.title}
          </p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
            <span dir="ltr" className="rounded bg-muted px-1.5 py-px font-medium">{item.label}</span>
            <span className={item.state === "error" ? "text-destructive" : item.state === "done" ? "text-emerald-600 dark:text-emerald-400" : ""}>
              {stateLabel[item.state]}
            </span>
            {item.state === "error" && item.error && (
              <span>— {t(errorKey(item.error))}</span>
            )}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {active && (
            <Button variant="ghost" size="icon" aria-label={t("cancel")} onClick={() => onCancel(item)} className="h-7 w-7">
              <X className="h-3.5 w-3.5" />
            </Button>
          )}
          {!active && (
            <Button variant="ghost" size="icon" aria-label={t("remove")} onClick={() => onRemove(item.id)} className="h-7 w-7">
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
          {item.state === "downloading" && <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />}
          {item.state === "done" && <Check className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />}
        </div>
      </div>

      {active && (
        <>
          <Progress value={pct} className="h-1.5" />
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
            <span dir="ltr" className="font-medium tabular-nums">{pct}%</span>
            {item.speed > 0 && <span dir="ltr">{formatSpeed(item.speed)}</span>}
            {item.received > 0 && (
              <span dir="ltr" className="tabular-nums">
                {formatBytes(item.received)} / {item.total > 0 ? formatBytes(item.total) : "—"}
              </span>
            )}
          </div>
        </>
      )}
      {item.state === "done" && (
        <p dir="ltr" className="text-[11px] text-muted-foreground">
          {formatBytes(item.total || item.received)} · {item.filename}
        </p>
      )}
    </div>
  );
}
