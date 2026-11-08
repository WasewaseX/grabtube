"use client";

import { useTheme } from "next-themes";
import { Palette } from "lucide-react";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useLang } from "../../../hooks/use-lang";
import { Card, Row } from "./primitives";

/** Language + theme preferences card. */
export function PrefsCard() {
  const { t, lang, setLang } = useLang();
  const { theme, setTheme } = useTheme();
  return (
    <Card icon={<Palette className="h-4 w-4 text-primary" />} title={t("prefsSection")}>
      <Row label={t("languageLabel")}>
        <Select value={lang} onValueChange={(v) => setLang(v === "fa" ? "fa" : "en")}>
          <SelectTrigger className="h-8 w-32 text-xs" aria-label={t("languageLabel")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="en">English</SelectItem>
            <SelectItem value="fa">فارسی</SelectItem>
          </SelectContent>
        </Select>
      </Row>
      <Row label={t("themeLabel")}>
        <Select value={theme ?? "dark"} onValueChange={(v) => setTheme(v)}>
          <SelectTrigger className="h-8 w-32 text-xs" aria-label={t("themeLabel")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="dark">{t("themeDark")}</SelectItem>
            <SelectItem value="light">{t("themeLight")}</SelectItem>
          </SelectContent>
        </Select>
      </Row>
    </Card>
  );
}
