import { NextRequest, NextResponse } from "next/server";
import { getSettings, saveSettings } from "@/lib/settings";
import { laneSnapshot, probeAll, reloadLanes } from "@/lib/proxy";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";

export const dynamic = "force-dynamic";

const DATA_DIR = "/home/z/my-project/data";
const LANE_SETTINGS_PATH = `${DATA_DIR}/settings.json`;
const COOKIES_FILE = `${DATA_DIR}/cookies.txt`;

/** settings.json consumed by the egress lane manager (proxy.ts). */
function readLaneSettings(): { extraProxies?: string[]; cookies?: string | null } {
  try {
    if (!existsSync(LANE_SETTINGS_PATH)) return {};
    return JSON.parse(readFileSync(LANE_SETTINGS_PATH, "utf8")) as {
      extraProxies?: string[];
      cookies?: string | null;
    };
  } catch {
    return {};
  }
}

function writeLaneSettings(patch: { extraProxies?: string[]; cookies?: string | null }): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    const next = { ...readLaneSettings(), ...patch, updatedAt: Date.now() };
    writeFileSync(LANE_SETTINGS_PATH, JSON.stringify(next, null, 2), { mode: 0o600 });
  } catch {
    /* best effort */
  }
}

function persistCookiesFile(cookies: string | null): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    if (cookies && cookies.trim()) writeFileSync(COOKIES_FILE, cookies, { mode: 0o600 });
    else if (existsSync(COOKIES_FILE)) writeFileSync(COOKIES_FILE, "", { mode: 0o600 });
  } catch {
    /* best effort */
  }
}

function parseProxyList(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && /^https?:\/\/|^socks(4|4a|5|h)?:\/\//.test(l));
}

export async function GET() {
  const [s, laneSettings] = [await getSettings(), readLaneSettings()];
  const hasCookies = Boolean(s.cookies && s.cookies.trim());
  return NextResponse.json({
    // settings-tab shape
    cookiesConfigured: hasCookies,
    extraProxies: (laneSettings.extraProxies ?? []).join("\n"),
    lanes: laneSnapshot(),
    // legacy shape (kept for compatibility)
    cookies: hasCookies ? "..." : "",
    hasCookies,
    clientOrder: s.clientOrder,
    usePoToken: s.usePoToken,
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { extraProxies?: string; cookies?: string };
    const proxies = parseProxyList(body.extraProxies ?? "");

    // 1. Prisma: cookies + proxy entries (engine-level persistence)
    await saveSettings({
      ...(body.cookies !== undefined ? { cookies: body.cookies } : {}),
      ...(proxies.length || body.extraProxies !== undefined
        ? { proxies: proxies.map((url) => ({ url, healthy: true })) }
        : {}),
    });

    // 2. Lane manager sync (data/settings.json) + live reload
    const lanePatch: { extraProxies?: string[]; cookies?: string | null } = { extraProxies: proxies };
    if (body.cookies !== undefined) lanePatch.cookies = body.cookies.trim() ? body.cookies : null;
    writeLaneSettings(lanePatch);
    if (body.cookies !== undefined) persistCookiesFile(body.cookies.trim() ? body.cookies : null);
    reloadLanes();
    void probeAll().catch(() => undefined);

    return NextResponse.json({ ok: true, lanes: laneSnapshot() });
  } catch {
    return NextResponse.json({ error: "Could not save network settings." }, { status: 500 });
  }
}
