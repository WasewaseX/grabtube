"use client";

import { useState } from "react";
import { LangProvider } from "../../../hooks/use-lang";
import { Header } from "./header";
import { Downloader } from "./downloader-view";
import { Settings } from "./settings-overlay";
import { History } from "./history-overlay";

export function DownloaderApp() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  return (
    <LangProvider initialLang="en">
      <div className="yw-app-root">
        <div className="app">
          <Header onOpenHistory={() => setHistoryOpen(true)} onOpenSettings={() => setSettingsOpen(true)} />
          <Downloader />
        </div>
        {settingsOpen && <Settings onClose={() => setSettingsOpen(false)} />}
        {historyOpen && <History onClose={() => setHistoryOpen(false)} />}
      </div>
    </LangProvider>
  );
}
