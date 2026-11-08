"use client";

import { ShieldCheck } from "lucide-react";

import { useLang } from "../../../hooks/use-lang";
import { Card } from "./primitives";

/** About / disclaimer card. */
export function AboutCard() {
  const { t } = useLang();
  return (
    <Card icon={<ShieldCheck className="h-4 w-4 text-primary" />} title={t("aboutSection")}>
      <p className="text-xs leading-relaxed text-muted-foreground">{t("aboutText")}</p>
      <p className="mt-2 text-[11px] text-muted-foreground/70">{t("disclaimer")}</p>
    </Card>
  );
}
