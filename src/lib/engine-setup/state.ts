/** Provision state registry surfaced through /api/health (engine.provision). */

export interface ProvisionStep {
  id: string;
  state: "waiting" | "running" | "done" | "failed" | "present";
  detail?: string;
  at?: number;
}

interface ProvisionState {
  started: boolean;
  ok: boolean;
  steps: Record<string, ProvisionStep>;
  lastRun: number | null;
  running: Promise<void> | null;
}

declare global {
  var __tgProvision: ProvisionState | undefined;
}

function state(): ProvisionState {
  if (!globalThis.__tgProvision) {
    globalThis.__tgProvision = {
      started: false,
      ok: false,
      steps: {},
      lastRun: null,
      running: null,
    };
  }
  return globalThis.__tgProvision;
}

export function provisionStatus(): ProvisionState {
  return state();
}

export function step(id: string, s: ProvisionStep["state"], detail?: string): void {
  const st = state();
  st.steps[id] = { id, state: s, detail, at: Date.now() };
}

export function finishProvisionPass(): void {
  const st = state();
  st.ok = Object.values(st.steps).every((s) => s.state === "done" || s.state === "present");
  st.lastRun = Date.now();
  console.log(`[engine-setup] provision pass complete — ok=${st.ok} ${JSON.stringify(st.steps)}`);
}

export function isProvisionOk(): boolean {
  return state().ok;
}

export function claimProvisionStart(): boolean {
  const st = state();
  if (st.started) return false;
  st.started = true;
  return true;
}

export function setRunning(p: Promise<void>): void {
  state().running = p;
}
