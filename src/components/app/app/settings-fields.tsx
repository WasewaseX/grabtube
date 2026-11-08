"use client";

import type { Lane } from "./use-settings-form";

export function LaneNote({ active }: { active?: Lane }) {
  return (
    <div className="field">
      <div className="lane-note">
        <span className={"lane-dot" + (active?.healthy ? " ok" : "")} />
        <span>
          Egress lane: <b style={{ color: "var(--text)" }}>{active?.label ?? "…"}</b>
          {active?.healthy ? " · healthy" : " · probing…"}
          {active?.egressIp ? ` · ${active.egressIp}` : ""}
        </span>
      </div>
      <div className="hint">
        The engine routes YouTube traffic through a Cloudflare WARP tunnel to bypass datacenter-IP bot walls.
        User proxies are used as fallback lanes.
      </div>
    </div>
  );
}

export function ProxiesField({
  proxies,
  setProxies,
}: {
  proxies: string;
  setProxies: (v: string) => void;
}) {
  return (
    <div className="field">
      <label htmlFor="yw-proxies">Extra proxies (one per line)</label>
      <textarea
        id="yw-proxies"
        rows={3}
        dir="ltr"
        spellCheck={false}
        value={proxies}
        onChange={(e) => setProxies(e.target.value)}
        placeholder={"http://user:pass@host:port\nsocks5://host:1080"}
      />
      <div className="hint">http / socks4 / socks5. Used when the WARP tunnel is unhealthy.</div>
    </div>
  );
}

export function CookiesField({
  cookies,
  setCookies,
  hasCookies,
}: {
  cookies: string;
  setCookies: (v: string) => void;
  hasCookies: boolean;
}) {
  return (
    <div className="field">
      <label htmlFor="yw-cookies">YouTube cookies.txt {hasCookies ? "· configured ✓" : ""}</label>
      <textarea
        id="yw-cookies"
        rows={4}
        dir="ltr"
        spellCheck={false}
        value={cookies}
        onChange={(e) => setCookies(e.target.value)}
        placeholder="# Netscape HTTP Cookie File … (optional — permanent fix for hard-flagged IPs)"
      />
      <div className="hint">
        Export cookies.txt from a signed-in browser (privacy: stored server-side, mode 0600). Optional — the
        tunnel + PO tokens usually suffice.
      </div>
    </div>
  );
}
