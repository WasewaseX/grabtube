"use client";

import { CheckCircle2, RefreshCw, XCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useLang } from "../../../hooks/use-lang";
import type { Health } from "./types";

/** Live egress-lane rows plus the manual re-test button. */
export function LanesSection({ health, onTest }: { health: Health | null; onTest: () => void }) {
  const { t } = useLang();
  return (
    <>
      {/* live lanes */}
      <div className="flex items-center justify-between py-2">
        <span className="text-xs font-medium">{t("lanesSection")}</span>
        <Button variant="outline" size="sm" className="h-7 px-2 text-[11px]" onClick={onTest}>
          <RefreshCw className="me-1 h-3 w-3" />
          {t("testLanes")}
        </Button>
      </div>
      <div className="flex flex-col gap-1.5 pb-2">
        {(health?.lanes ?? []).map((lane) => (
          <div
            key={lane.id}
            className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border bg-muted/40 px-2.5 py-1.5"
            data-lane={lane.id}
          >
            {lane.healthy ? (
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
            ) : (
              <XCircle className="h-3.5 w-3.5 shrink-0 text-red-400" />
            )}
            <span className="text-[11px] font-medium" dir="ltr">
              {lane.label}
            </span>
            {lane.active && (
              <span className="rounded bg-primary px-1.5 py-0.5 text-[9px] font-semibold text-primary-foreground">
                {t("laneActive")}
              </span>
            )}
            <span className="ms-auto text-[10px] text-muted-foreground" dir="ltr">
              {lane.egressIp ? `${lane.egressIp}${lane.latencyMs != null ? ` · ${lane.latencyMs}ms` : ""}` : lane.note || "—"}
            </span>
          </div>
        ))}
        {!health && <span className="py-1 text-[11px] text-muted-foreground">{t("laneTesting")}</span>}
      </div>
    </>
  );
}
