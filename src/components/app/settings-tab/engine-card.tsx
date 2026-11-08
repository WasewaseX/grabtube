"use client";

import { Cpu } from "lucide-react";

import { useLang } from "../../../hooks/use-lang";
import { Card, Row, Val } from "./primitives";
import type { Health } from "./types";

/** Engine health card: version, ffmpeg, client chain, providers. */
export function EngineCard({ health }: { health: Health | null }) {
  const { t } = useLang();
  return (
    <Card icon={<Cpu className="h-4 w-4 text-primary" />} title={t("engineSection")}>
      <Row label={t("engineVersion")}>
        <code dir="ltr" className="rounded bg-muted px-1.5 py-0.5 text-[11px]">
          {health?.engine ?? "…"}
        </code>
      </Row>
      <Row label={t("ffmpegLabel")}>
        <Val ok={health?.ffmpeg} okText={t("present")} badText={t("missing")} />
      </Row>
      <Row label={t("clientChain")}>
        <span dir="ltr" className="text-[11px]">{health ? health.clients : "…"}</span>
      </Row>
      <Row label={t("providersLabel")}>
        <div className="flex flex-wrap justify-end gap-1">
          {(health?.providers ?? []).map((p) => (
            <code key={p} dir="ltr" className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {p}
            </code>
          ))}
          {!health && <span className="text-[11px]">…</span>}
        </div>
      </Row>
    </Card>
  );
}
