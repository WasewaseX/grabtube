"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import {
  CheckCircle2,
  CircleDashed,
  Cpu,
  Globe2,
  Palette,
  ShieldCheck,
  RefreshCw,
  XCircle,
} from "lucide-react";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { useLang } from "@/hooks/use-lang";

interface LaneStatus {
  id: string;
  label: string;
  kind: "warp" | "user" | "direct";
  active: boolean;
  healthy: boolean;
  latencyMs: number | null;
  egressIp: string | null;
  lastCheck: number | null;
  note?: string;
}

interface Health {
  engine: string | null;
  ffmpeg: boolean;
  cookies: boolean;
  clients: number;
  lanes: LaneStatus[];
  providers: string[];
}

interface SettingsResp {
  cookiesConfigured: boolean;
  extraProxies: string;
  lanes: LaneStatus[];
}

export function SettingsTab() {
  const { t, lang, setLang } = useLang();
  const { theme, setTheme } = useTheme();
  const [health, setHealth] = useState<Health | null>(null);
  const [cookiesText, setCookiesText] = useState("");
  const [proxiesText, setProxiesText] = useState("");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");

  const loadAll = () => {
    fetch("/api/health")
      .then((r) => r.json())
      .then((j: Health) => setHealth(j))
      .catch(() => undefined);
    fetch("/api/settings")
      .then((r) => r.json())
      .then((j: SettingsResp) => {
        setProxiesText(j.extraProxies ?? "");
        setCookiesText(j.cookiesConfigured ? "..." : "");
      })
      .catch(() => undefined);
  };

  useEffect(() => {
    loadAll();
    const iv = setInterval(() => {
      fetch("/api/health")
        .then((r) => r.json())
        .then((j: Health) => setHealth(j))
        .catch(() => undefined);
    }, 30_000);
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

  return (
    <section className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4" aria-label="Settings">
      <h2 className="text-sm font-semibold">{t("settingsTitle")}</h2>

      {/* network resilience */}
      <Card icon={<Globe2 className="h-4 w-4 text-primary" />} title={t("accessSection")}>
        {/* live lanes */}
        <div className="flex items-center justify-between py-2">
          <span className="text-xs font-medium">{t("lanesSection")}</span>
          <Button variant="outline" size="sm" className="h-7 px-2 text-[11px]" onClick={testNow}>
            <RefreshCw className="me-1 h-3 w-3" />
            {t("testLanes")}
          </Button>
        </div>
        <div className="flex flex-col gap-1.5 pb-2">
          {(health?.lanes ?? []).map((lane) => (
            <div
              key={lane.id}
              className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border bg-muted/40 px-2.5 py-1.5"
              data-lane={lane.id}
            >
              {lane.healthy ? (
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
              ) : (
                <XCircle className="h-3.5 w-3.5 shrink-0 text-red-400" />
              )}
              <span className="text-[11px] font-medium" dir="ltr">
                {lane.label}
              </span>
              {lane.active && (
                <span className="rounded bg-primary px-1.5 py-0.5 text-[9px] font-semibold text-primary-foreground">
                  {t("laneActive")}
                </span>
              )}
              <span className="ms-auto text-[10px] text-muted-foreground" dir="ltr">
                {lane.egressIp ? `${lane.egressIp}${lane.latencyMs != null ? ` · ${lane.latencyMs}ms` : ""}` : lane.note || "—"}
              </span>
            </div>
          ))}
          {!health && <span className="py-1 text-[11px] text-muted-foreground">{t("laneTesting")}</span>}
        </div>

        {/* cookies setup */}
        <div className="flex flex-col gap-1.5 py-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium">{t("cookiesSetupTitle")}</span>
            <Val ok={health?.cookies} okText={t("configured")} badText={t("notConfigured")} />
          </div>
          <p className="text-[11px] leading-relaxed text-muted-foreground">{t("cookiesSetupHint")}</p>
          <Textarea
            dir="ltr"
            rows={4}
            value={cookiesText}
            onChange={(e) => setCookiesText(e.target.value)}
            placeholder={t("cookiesPlaceholder")}
            className="scroll-thin max-h-40 min-h-16 font-mono text-[10px]"
            aria-label={t("cookiesSetupTitle")}
          />
        </div>

        {/* extra proxies */}
        <div className="flex flex-col gap-1.5 py-3">
          <span className="text-xs font-medium">{t("proxiesSetupTitle")}</span>
          <p className="text-[11px] leading-relaxed text-muted-foreground">{t("proxiesSetupHint")}</p>
          <Textarea
            dir="ltr"
            rows={3}
            value={proxiesText}
            onChange={(e) => setProxiesText(e.target.value)}
            placeholder={t("proxiesPlaceholder")}
            className="scroll-thin max-h-32 min-h-14 font-mono text-[10px]"
            aria-label={t("proxiesSetupTitle")}
          />
        </div>

        <div className="flex items-center gap-3 py-3">
          <Button size="sm" className="h-8 px-4 text-xs" onClick={save} disabled={saveState === "saving"}>
            {saveState === "saving" ? t("savingNetwork") : t("saveNetwork")}
          </Button>
          {saveState === "saved" && <span className="text-[11px] text-emerald-600">{t("savedNetwork")}</span>}
          {saveState === "error" && (
            <span className="text-[11px] text-red-500" dir="auto">
              {errorMsg || t("networkSaveFailed")}
            </span>
          )}
        </div>
      </Card>

      {/* engine */}
      <Card icon={<Cpu className="h-4 w-4 text-primary" />} title={t("engineSection")}>
        <Row label={t("engineVersion")}>
          <code dir="ltr" className="rounded bg-muted px-1.5 py-0.5 text-[11px]">
            {health?.engine ?? "…"}
          </code>
        </Row>
        <Row label={t("ffmpegLabel")}>
          <Val ok={health?.ffmpeg} okText={t("present")} badText={t("missing")} />
        </Row>
        <Row label={t("clientChain")}>
          <span dir="ltr" className="text-[11px]">{health ? health.clients : "…"}</span>
        </Row>
        <Row label={t("providersLabel")}>
          <div className="flex flex-wrap justify-end gap-1">
            {(health?.providers ?? []).map((p) => (
              <code key={p} dir="ltr" className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {p}
              </code>
            ))}
            {!health && <span className="text-[11px]">…</span>}
          </div>
        </Row>
      </Card>

      {/* preferences */}
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

      {/* about */}
      <Card icon={<ShieldCheck className="h-4 w-4 text-primary" />} title={t("aboutSection")}>
        <p className="text-xs leading-relaxed text-muted-foreground">{t("aboutText")}</p>
        <p className="mt-2 text-[11px] text-muted-foreground/70">{t("disclaimer")}</p>
      </Card>
    </section>
  );
}

function Card({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        {icon}
        <span className="text-xs font-semibold">{title}</span>
      </div>
      <div className="flex flex-col divide-y px-3">{children}</div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="flex items-center">{children}</div>
    </div>
  );
}

function Val({ ok, okText, badText }: { ok?: boolean; okText: string; badText: string }) {
  if (ok === undefined) return <span className="text-[11px] text-muted-foreground">…</span>;
  return ok ? (
    <span className="flex items-center gap-1 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
      <CheckCircle2 className="h-3.5 w-3.5" />
      {okText}
    </span>
  ) : (
    <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
      <CircleDashed className="h-3.5 w-3.5" />
      {badText}
    </span>
  );
}
