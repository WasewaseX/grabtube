"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { dict, translate, type Lang, type TKey } from "@/lib/i18n";

interface LangCtx {
  lang: Lang;
  dir: "ltr" | "rtl";
  setLang: (l: Lang) => void;
  toggle: () => void;
  t: (key: TKey, vars?: Record<string, string | number>) => string;
}

const Ctx = createContext<LangCtx | null>(null);

function persistLang(l: Lang): void {
  try {
    window.localStorage.setItem("tubegrab.lang", l);
    document.cookie = `tg_lang=${l}; path=/; max-age=31536000; samesite=lax`;
  } catch {
    /* ignore */
  }
}

export function LangProvider({ initialLang = "en", children }: { initialLang?: Lang; children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initialLang);

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === "fa" ? "rtl" : "ltr";
  }, [lang]);

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    persistLang(l);
  }, []);

  const value = useMemo<LangCtx>(
    () => ({
      lang,
      dir: lang === "fa" ? "rtl" : "ltr",
      setLang,
      toggle: () => setLang(lang === "en" ? "fa" : "en"),
      t: (key, vars) => translate(lang, key, vars),
    }),
    [lang, setLang],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useLang(): LangCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useLang must be used inside LangProvider");
  return ctx;
}

export { dict };
