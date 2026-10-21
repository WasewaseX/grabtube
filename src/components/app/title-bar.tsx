"use client";

import { Languages, Moon, Sun, MonitorDown } from "lucide-react";
import { useTheme } from "next-themes";

import { Button } from "@/components/ui/button";
import { useLang } from "@/hooks/use-lang";

/** macOS-style window title bar – instantly reads as a desktop app. */
export function TitleBar() {
  const { t, lang, toggle } = useLang();
  const { resolvedTheme, setTheme } = useTheme();

  return (
    <header
      className="flex h-9 shrink-0 select-none items-center gap-3 border-b bg-card px-3"
      dir="ltr"
    >
      <div className="flex gap-1.5" aria-hidden="true">
        <span className="h-3 w-3 rounded-full bg-[#ff5f57]" />
        <span className="h-3 w-3 rounded-full bg-[#febc2e]" />
        <span className="h-3 w-3 rounded-full bg-[#28c840]" />
      </div>
      <div className="flex items-center gap-2">
        <MonitorDown className="h-4 w-4 text-primary" />
        <span className="text-xs font-semibold tracking-wide">{t("appName")}</span>
        <span className="text-[10px] text-muted-foreground">{t("appVersion")}</span>
      </div>
      <div className="ms-auto flex items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          onClick={toggle}
          aria-label="Language"
          className="h-7 gap-1 px-2 text-[11px] font-medium"
        >
          <Languages className="h-3.5 w-3.5" />
          {lang === "en" ? "EN" : "فا"}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("themeToggle")}
          onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
          className="h-7 w-7"
        >
          {/* Both icons rendered; CSS decides. Branching on resolvedTheme during
              render mismatches hydration when localStorage disagrees with the
              server default. Event handlers below are always client-side. */}
          <Sun className="hidden h-3.5 w-3.5 dark:block" />
          <Moon className="h-3.5 w-3.5 dark:hidden" />
        </Button>
      </div>
    </header>
  );
}
