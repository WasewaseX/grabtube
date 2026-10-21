"use client";

import { useCallback, useMemo, useState } from "react";
import { CheckCircle2, CircleAlert, Cpu, Globe2 } from "lucide-react";

import { HomeTab } from "./home-tab";
import { DownloadsTab } from "./downloads-tab";
import { HistoryTab } from "./history-tab";
import { SettingsTab } from "./settings-tab";
import { TabNav, type TabId } from "./tab-nav";
import { TitleBar } from "./title-bar";
import { useLang } from "@/hooks/use-lang";
import { useDownloader } from "@/hooks/use-downloader";
import type { PublicFormat } from "@/lib/ytdlp";

export function DownloaderApp({ initialLang }: { initialLang: "en" | "fa" }) {
  return (
    <LangGate initialLang={initialLang}>
      <Shell />
    </LangGate>
  );
}

// Lazily imported provider lives in use-lang; re-export for composition.
import { LangProvider } from "@/hooks/use-lang";

function LangGate({ initialLang, children }: { initialLang: "en" | "fa"; children: React.ReactNode }) {
  return <LangProvider initialLang={initialLang}>{children}</LangProvider>;
}

function Shell() {
  const dl = useDownloader();
  const { t } = useLang();
  const [tab, setTab] = useState<TabId>("home");

  const activeCount = useMemo(
    () => dl.items.filter((it) => ["starting", "queued", "downloading", "merging", "saving"].includes(it.state)).length,
    [dl.items],
  );

  const startWith = useCallback(
    (fmt: PublicFormat, bitrate?: number) => {
      if (!dl.info) return;
      void dl.startDownload(fmt, dl.info, bitrate);
      setTab("downloads");
    },
    [dl],
  );

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
      <TitleBar />
      <TabNav tab={tab} onTab={setTab} activeCount={activeCount} />

      <main className="min-h-0 flex-1 overflow-y-auto scroll-thin">
        {tab === "home" && (
          <HomeTab
            url={dl.url}
            setUrl={dl.setUrl}
            phase={dl.phase}
            info={dl.info}
            errorMsg={dl.errorMsg}
            errorCode={dl.errorCode}
            history={dl.history}
            onFetch={dl.fetchInfo}
            onReset={dl.reset}
            onStart={startWith}
          />
        )}
        {tab === "downloads" && (
          <DownloadsTab
            items={dl.items}
            onCancel={dl.cancelItem}
            onRemove={dl.removeItem}
            onClearFinished={dl.clearFinished}
          />
        )}
        {tab === "history" && <HistoryTab history={dl.history} onClear={dl.clearHistory} />}
        {tab === "settings" && <SettingsTab />}
      </main>

      <StatusBar />
    </div>
  );

  function StatusBar() {
    const { t } = useLang();
    return (
      <footer className="flex h-7 shrink-0 items-center gap-3 border-t bg-card px-3 text-[10px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <Cpu className="h-3 w-3" />
          {t("appName")} {t("appVersion")}
        </span>
        <span className="flex items-center gap-1" dir="ltr">
          {dl.phase !== "error" ? (
            <>
              <CheckCircle2 className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
              yt-dlp · {t("engineOn")}
            </>
          ) : (
            <>
              <CircleAlert className="h-3 w-3 text-destructive" />
              yt-dlp · {t("engineOff")}
            </>
          )}
        </span>
        <span className="hidden items-center gap-1 sm:flex" dir="ltr">
          <Globe2 className="h-3 w-3" />
          Piped + Invidious fallback
        </span>
        <span className="ms-auto hidden sm:inline">{t("disclaimer")}</span>
      </footer>
    );
  }
}
