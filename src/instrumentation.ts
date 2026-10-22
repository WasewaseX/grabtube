/**
 * Next.js instrumentation hook — runs once when the server boots.
 *
 * Global last-resort error containment: a stray async error from any child
 * process (spawn ENOENT, killed pipe, undici socket reset) used to take the
 * whole runtime down and surface to users as "engine couldn't fetch".
 * We log and keep serving — individual requests already handle their own
 * errors via DlError classification.
 *
 * NOTE: process handlers are reached through globalThis so the Edge-runtime
 * bundler pass (which statically flags `process.on`) compiles this file
 * cleanly; the guard below means the code never RUNS outside Node anyway.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const g = globalThis as unknown as {
    __grabTubeTrapInstalled?: boolean;
    process?: {
      on: (ev: string, cb: (...a: unknown[]) => void) => void;
    };
  };
  if (g.__grabTubeTrapInstalled) return;
  g.__grabTubeTrapInstalled = true;

  const proc = g.process;
  if (!proc?.on) return;

  proc.on("uncaughtException", (err) => {
    const msg = (err as Error)?.message ?? String(err);
    console.error("[safety] uncaughtException contained:", msg);
  });
  proc.on("unhandledRejection", (reason) => {
    console.error("[safety] unhandledRejection contained:", String(reason).slice(0, 300));
  });
}
