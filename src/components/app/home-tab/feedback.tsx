"use client";

import { Download, RotateCcw, TriangleAlert } from "lucide-react";

import { Button } from "../../../components/ui/button";
import { errorKey } from "../../../lib/i18n";
import { useLang } from "../../../hooks/use-lang";
import type { HistoryEntry } from "../../../hooks/use-downloader";

export function IdleHint({ history }: { history: HistoryEntry[] }) {
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

export function SkeletonList() {
  return (
    <div className="flex flex-col gap-2" aria-busy="true">
      <div className="h-24 animate-pulse rounded-lg bg-muted" />
      <div className="h-9 animate-pulse rounded-md bg-muted" />
      <div className="h-9 animate-pulse rounded-md bg-muted" />
      <div className="h-9 animate-pulse rounded-md bg-muted" />
    </div>
  );
}

export function ErrorCard({ code, msg, onRetry }: { code: string; msg: string | null; onRetry: () => void }) {
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
