"use client";

import { useLang } from "../../hooks/use-lang";

import { AboutCard } from "./settings-tab/about-card";
import { EngineCard } from "./settings-tab/engine-card";
import { NetworkCard } from "./settings-tab/network-card";
import { PrefsCard } from "./settings-tab/prefs-card";
import { useNetworkSettings } from "./settings-tab/use-network-settings";

export function SettingsTab() {
  const { t } = useLang();
  const net = useNetworkSettings();

  return (
    <section className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4" aria-label="Settings">
      <h2 className="text-sm font-semibold">{t("settingsTitle")}</h2>

      {/* network resilience */}
      <NetworkCard net={net} />

      {/* engine */}
      <EngineCard health={net.health} />

      {/* preferences */}
      <PrefsCard />

      {/* about */}
      <AboutCard />
    </section>
  );
}
