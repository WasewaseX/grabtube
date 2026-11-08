"use client";

import { CheckCircle2, CircleDashed } from "lucide-react";

/** Titled settings card with a divided body. */
export function Card({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        {icon}
        <span className="text-xs font-semibold">{title}</span>
      </div>
      <div className="flex flex-col divide-y px-3">{children}</div>
    </div>
  );
}

/** Label / value row used inside settings cards. */
export function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="flex items-center">{children}</div>
    </div>
  );
}

/** Boolean health pill: ok / bad / pending. */
export function Val({ ok, okText, badText }: { ok?: boolean; okText: string; badText: string }) {
  if (ok === undefined) return <span className="text-[11px] text-muted-foreground">…</span>;
  return ok ? (
    <span className="flex items-center gap-1 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
      <CheckCircle2 className="h-3.5 w-3.5" />
      {okText}
    </span>
  ) : (
    <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
      <CircleDashed className="h-3.5 w-3.5" />
      {badText}
    </span>
  );
}
