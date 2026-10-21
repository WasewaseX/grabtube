"use client";

import { History, House, Settings2, Download } from "lucide-react";

import { useLang } from "@/hooks/use-lang";

export type TabId = "home" | "downloads" | "history" | "settings";

interface Props {
  tab: TabId;
  onTab: (t: TabId) => void;
  activeCount: number;
}

/** App tab strip, like the classic Tauri downloader navigation. */
export function TabNav({ tab, onTab, activeCount }: Props) {
  const { t } = useLang();

  const tabs: Array<{ id: TabId; label: string; icon: typeof House; badge?: number }> = [
    { id: "home", label: t("tabHome"), icon: House },
    { id: "downloads", label: t("tabDownloads"), icon: Download, badge: activeCount },
    { id: "history", label: t("tabHistory"), icon: History },
    { id: "settings", label: t("tabSettings"), icon: Settings2 },
  ];

  return (
    <nav
      className="flex h-10 shrink-0 items-center gap-1 overflow-x-auto border-b bg-background px-2 scroll-thin"
      aria-label="App sections"
    >
      {tabs.map(({ id, label, icon: Icon, badge }) => {
        const active = tab === id;
        return (
          <button
            key={id}
            type="button"
            onClick={() => onTab(id)}
            aria-current={active ? "page" : undefined}
            className={`flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors ${
              active
                ? "bg-accent text-accent-foreground shadow-sm"
                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
            }`}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
            {badge !== undefined && badge > 0 && (
              <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold leading-none text-primary-foreground">
                {badge}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}
