/**
 * Next.js instrumentation — runs once when the server process boots.
 * The download engine provisions its own toolchain (yt-dlp, deno, PO
 * provider, wireproxy, WARP identity) so the app self-heals after any
 * sandbox / home-directory reset. See src/lib/engine-setup.ts.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    try {
      const { ensureEngineProvisioned } = await import("./lib/engine-setup");
      ensureEngineProvisioned();
    } catch (e) {
      console.error(`[instrumentation] engine provisioning failed to start: ${String(e).slice(0, 120)}`);
    }
  }
}
