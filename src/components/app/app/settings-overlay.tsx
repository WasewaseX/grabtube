"use client";

import { useEffect, useState } from "react";
import { LaneNote, CookiesField, ProxiesField } from "./settings-fields";
import { useSettingsForm, type Lane } from "./use-settings-form";

export function Settings({ onClose }: { onClose: () => void }) {
  const form = useSettingsForm();
  const active: Lane | undefined = form.lanes.find((l) => l.active);

  return (
    <div className="settings-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label="Settings">
      <div className="settings-card" onClick={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <div className="settings-title">Settings</div>
          <button className="icon-btn" onClick={onClose} aria-label="Close settings">
            ✕
          </button>
        </div>

        <LaneNote active={active} />

        <ProxiesField proxies={form.proxies} setProxies={form.setProxies} />

        <CookiesField cookies={form.cookies} setCookies={form.setCookies} hasCookies={form.hasCookies} />

        <div className="settings-actions">
          <button className="btn ghost" onClick={onClose}>
            Close
          </button>
          <button className="btn primary" onClick={() => void form.save()} disabled={form.saving}>
            {form.saving ? "Saving…" : form.saved ? "Saved ✓" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
