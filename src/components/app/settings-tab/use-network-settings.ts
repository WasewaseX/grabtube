"use client";

import { useEffect, useState } from "react";

import { useLang } from "../../../hooks/use-lang";
import type { Health, SettingsResp } from "./types";

function fetchHealthInto(setHealth: (h: Health) => void): void {
  fetch("/api/health")
    .then((r) => r.json())
    .then((j: Health) => setHealth(j))
    .catch(() => undefined);
}

function fetchSettingsInto(
  setProxiesText: (v: string) => void,
  setCookiesText: (v: string) => void,
): void {
  fetch("/api/settings")
    .then((r) => r.json())
    .then((j: SettingsResp) => {
      setProxiesText(j.extraProxies ?? "");
      setCookiesText(j.cookiesConfigured ? "..." : "");
    })
    .catch(() => undefined);
}

/** Owns the settings-tab data: lane health polling, cookie/proxy drafts and the save flow. */
export function useNetworkSettings() {
  const { t } = useLang();
  const [health, setHealth] = useState<Health | null>(null);
  const [cookiesText, setCookiesText] = useState("");
  const [proxiesText, setProxiesText] = useState("");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");

  const loadAll = () => {
    fetchHealthInto(setHealth);
    fetchSettingsInto(setProxiesText, setCookiesText);
  };

  useEffect(() => {
    loadAll();
    const iv = setInterval(() => fetchHealthInto(setHealth), 30_000);
    return () => clearInterval(iv);
  }, []);

  const save = async () => {
    setSaveState("saving");
    setErrorMsg("");
    try {
      const body: Record<string, string> = { extraProxies: proxiesText };
      if (cookiesText.trim() && cookiesText.trim() !== "...") body.cookies = cookiesText;
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setErrorMsg(j.error || t("networkSaveFailed"));
        setSaveState("error");
        return;
      }
      setSaveState("saved");
      if (cookiesText.trim() && cookiesText.trim() !== "...") setCookiesText("...");
      setTimeout(() => {
        setSaveState("idle");
        loadAll();
      }, 1200);
    } catch {
      setErrorMsg(t("networkSaveFailed"));
      setSaveState("error");
    }
  };

  const testNow = () => {
    fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ extraProxies: proxiesText }),
    }).catch(() => undefined);
  };

  return {
    health,
    cookiesText,
    setCookiesText,
    proxiesText,
    setProxiesText,
    saveState,
    errorMsg,
    save,
    testNow,
  };
}

export type NetworkSettings = ReturnType<typeof useNetworkSettings>;
