"use client";

import { useEffect, useState } from "react";

export interface Lane {
  id: string;
  label: string;
  healthy: boolean;
  active: boolean;
  egressIp?: string | null;
  note?: string;
}

export function useSettingsForm() {
  const [proxies, setProxies] = useState("");
  const [cookies, setCookies] = useState("");
  const [hasCookies, setHasCookies] = useState(false);
  const [lanes, setLanes] = useState<Lane[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/settings");
        const j = await res.json();
        setProxies(j.extraProxies ?? "");
        setHasCookies(Boolean(j.cookiesConfigured));
        setLanes(j.lanes ?? []);
      } catch {
        /* overlay still renders */
      }
    })();
  }, []);

  const save = async () => {
    setSaving(true);
    setSaved(false);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ extraProxies: proxies, ...(cookies.trim() ? { cookies } : {}) }),
      });
      if (res.ok) {
        setSaved(true);
        setCookies("");
        const j = await fetch("/api/settings").then((r) => r.json());
        setLanes(j.lanes ?? []);
        setHasCookies(Boolean(j.cookiesConfigured));
        setTimeout(() => setSaved(false), 2200);
      }
    } finally {
      setSaving(false);
    }
  };

  return { proxies, setProxies, cookies, setCookies, hasCookies, lanes, saving, saved, save };
}
