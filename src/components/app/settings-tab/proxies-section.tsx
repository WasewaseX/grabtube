"use client";

import { Textarea } from "@/components/ui/textarea";
import { useLang } from "../../../hooks/use-lang";

/** Extra proxy list setup box. */
export function ProxiesSection({
  proxiesText,
  onProxiesChange,
}: {
  proxiesText: string;
  onProxiesChange: (v: string) => void;
}) {
  const { t } = useLang();
  return (
    <div className="flex flex-col gap-1.5 py-3">
      <span className="text-xs font-medium">{t("proxiesSetupTitle")}</span>
      <p className="text-[11px] leading-relaxed text-muted-foreground">{t("proxiesSetupHint")}</p>
      <Textarea
        dir="ltr"
        rows={3}
        value={proxiesText}
        onChange={(e) => onProxiesChange(e.target.value)}
        placeholder={t("proxiesPlaceholder")}
        className="scroll-thin max-h-32 min-h-14 font-mono text-[10px]"
        aria-label={t("proxiesSetupTitle")}
      />
    </div>
  );
}
