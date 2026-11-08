/** ENGINE AUTO-PROVISIONER — the app rebuilds its own download engine:
 *  at boot it re-provisions whatever the sandbox reset wiped (yt-dlp, deno,
 *  PO provider, wireproxy, WARP identity); background, idempotent. */

export { PROJECT, TOOLS, VENV_YTDLP, DENO_BIN, POT_ENTRY, WIREPROXY_BIN, WARP_CONF } from "./engine-setup/paths";
export { provisionStatus } from "./engine-setup/state";
export type { ProvisionStep } from "./engine-setup/state";
export { ensureEngineProvisioned } from "./engine-setup/orchestrator";
