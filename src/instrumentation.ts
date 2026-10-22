/**
 * Next.js instrumentation hook — runs once when the server boots.
 *
 * Global last-resort error containment: a stray async error from any child
 * process (spawn ENOENT, killed pipe, undici socket reset) used to take the
 * whole runtime down and surface to users as "engine couldn't fetch".
 * We log and keep serving — individual requests already handle their own
 * errors via DlError classification.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return

  const g = globalThis as unknown as { __grabTubeTrapInstalled?: boolean }
  if (g.__grabTubeTrapInstalled) return
  g.__grabTubeTrapInstalled = true

  process.on('uncaughtException', (err) => {
    console.error('[safety] uncaughtException contained:', err?.message ?? err)
  })
  process.on('unhandledRejection', (reason) => {
    console.error('[safety] unhandledRejection contained:', String(reason).slice(0, 300))
  })
}
