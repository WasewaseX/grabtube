"use client";

import { Textarea } from "@/components/ui/textarea";
import { useLang } from "../../../hooks/use-lang";
import { Val } from "./primitives";

/** YouTube cookies setup: status pill + paste box. */
export function CookiesSection({
  health,
  cookiesText,
  onCookiesChange,
}: {
  health: { cookies: boolean } | null;
  cookiesText: string;
  onCookiesChange: (v: string) => void;
}) {
  const { t } = useLang();
  return (
    <div className="flex flex-col gap-1.5 py-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium">{t("cookiesSetupTitle")}</span>
        <Val ok={health?.cookies} okText={t("configured")} badText={t("notConfigured")} />
      </div>
      <p className="text-[11px] leading-relaxed text-muted-foreground">{t("cookiesSetupHint")}</p>
      <Textarea
        dir="ltr"
        rows={4}
        value={cookiesText}
        onChange={(e) => onCookiesChange(e.target.value)}
        placeholder={t("cookiesPlaceholder")}
        className="scroll-thin max-h-40 min-h-16 font-mono text-[10px]"
        aria-label={t("cookiesSetupTitle")}
      />
    </div>
  );
}
