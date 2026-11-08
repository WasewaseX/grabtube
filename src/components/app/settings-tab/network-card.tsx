"use client";

import { Globe2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useLang } from "../../../hooks/use-lang";
import { CookiesSection } from "./cookies-section";
import { LanesSection } from "./lanes-section";
import { Card } from "./primitives";
import { ProxiesSection } from "./proxies-section";
import type { NetworkSettings } from "./use-network-settings";

/** Network resilience card: lanes, cookies, proxies and the save row. */
export function NetworkCard({ net }: { net: NetworkSettings }) {
  const { t } = useLang();
  return (
    <Card icon={<Globe2 className="h-4 w-4 text-primary" />} title={t("accessSection")}>
      <LanesSection health={net.health} onTest={net.testNow} />
      <CookiesSection
        health={net.health}
        cookiesText={net.cookiesText}
        onCookiesChange={net.setCookiesText}
      />
      <ProxiesSection proxiesText={net.proxiesText} onProxiesChange={net.setProxiesText} />
      <div className="flex items-center gap-3 py-3">
        <Button size="sm" className="h-8 px-4 text-xs" onClick={net.save} disabled={net.saveState === "saving"}>
          {net.saveState === "saving" ? t("savingNetwork") : t("saveNetwork")}
        </Button>
        {net.saveState === "saved" && <span className="text-[11px] text-emerald-600">{t("savedNetwork")}</span>}
        {net.saveState === "error" && (
          <span className="text-[11px] text-red-500" dir="auto">
            {net.errorMsg || t("networkSaveFailed")}
          </span>
        )}
      </div>
    </Card>
  );
}
