/**
 * Self-healing: respawn the warp-proxy mini-service in-process when the
 * tunnel is dead (sandboxes kill detached services between sessions).
 */
declare global {
  var __tgWarpSupervisorStarted: boolean | undefined;
}

export function ensureWarpService(): void {
  if (globalThis.__tgWarpSupervisorStarted) return;
  globalThis.__tgWarpSupervisorStarted = true;
  let spawnedInFlight = false;
  const check = async () => {
    // precise liveness test: is anything ANSWERING on the wireproxy socks port?
    // (lane.healthy flaps — a passing probe from a since-died process used to
    // make the supervisor skip a needed respawn for minutes)
    const alive = await Promise.race([
      import("net")
        .then(
          ({ default: net }) =>
            new Promise<boolean>((resolve) => {
              try {
                const sock = net.connect({ host: "127.0.0.1", port: 41080, timeout: 2500 });
                sock.once("connect", () => {
                  sock.destroy();
                  resolve(true);
                });
                sock.once("timeout", () => {
                  sock.destroy();
                  resolve(false);
                });
                sock.once("error", () => resolve(false));
              } catch {
                resolve(false);
              }
            }),
        )
        .catch(() => false as const),
      new Promise<boolean>((r) => setTimeout(() => r(false), 4000)),
    ]);
    if (alive) return; // tunnel socket up, nothing to do
    // avoid pile-ups while a freshly spawned service is still booting
    if (spawnedInFlight) return;
    spawnedInFlight = true;
    setTimeout(() => (spawnedInFlight = false), 20_000);
    try {
      const probe = await fetch("https://www.cloudflare.com/cdn-cgi/trace", {
        signal: AbortSignal.timeout(4000),
      });
      void probe.body?.cancel().catch(() => undefined);
    } catch {
      /* network down entirely — still try to spawn */
    }
    const { spawn } = await import("child_process");
    const { existsSync } = await import("fs");
    const dir = "/home/z/my-project/mini-services/warp-proxy";
    if (!existsSync(`${dir}/index.ts`)) return;
    console.log("[proxy] warp lane unhealthy — spawning warp-proxy service");
    try {
      const child = spawn("bun", ["run", "index.ts"], {
        cwd: dir,
        detached: true,
        stdio: "ignore",
        env: process.env,
      });
      // async spawn errors (ENOENT etc.) must never escape as uncaughtException
      child.on("error", () => undefined);
      child.unref();
    } catch (e) {
      console.error(`[proxy] warp service spawn failed: ${String(e).slice(0, 90)}`);
    }
  };
  setTimeout(() => void check(), 6000);
  setInterval(() => void check(), 60_000);
}
