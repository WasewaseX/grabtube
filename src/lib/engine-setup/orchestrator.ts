/* ------------------------------ orchestrator --------------------------- */

import { provisionDeno, provisionPotProvider, provisionWireproxy, provisionYtDlp } from "./provision";
import { finishProvisionPass, isProvisionOk, claimProvisionStart, setRunning, step } from "./state";
import { provisionWarpIdentity } from "./warp";

async function runProvision(): Promise<void> {
  // order: yt-dlp & wireproxy & warp are independent; deno gates the PO dir
  const jobs: Promise<void>[] = [
    provisionYtDlp().catch((e) => step("ytdlp", "failed", String(e).slice(-120))),
    provisionWireproxy().catch((e) => step("wireproxy", "failed", String(e).slice(-120))),
    provisionWarpIdentity().catch((e) => step("warp", "failed", String(e).slice(-120))),
    provisionDeno()
      .then(() => provisionPotProvider())
      .catch((e) => step(e instanceof Error && /pot|extract|tar/i.test(e.message) ? "pot" : "deno", "failed", String(e).slice(-120))),
  ];
  await Promise.allSettled(jobs);
  finishProvisionPass();
}

/** Retry ramp for partial provision failures (flaky network). */
async function runWithRetries(): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    await runProvision();
    if (isProvisionOk()) break;
    console.log(`[engine-setup] provision attempt ${attempt} incomplete — retrying in 2 min`);
    await new Promise((r) => setTimeout(r, 120_000));
  }
  // nudge the service supervisors so freshly provisioned pieces start fast
  import("../pot")
    .then((m) => void m.ensurePotServer().catch(() => undefined))
    .catch(() => undefined);
}

/** Idempotent boot hook — kick provisioning in the background once. */
export function ensureEngineProvisioned(): void {
  if (!claimProvisionStart()) return;
  const running = runWithRetries();
  setRunning(running);
  void running.catch(() => undefined);
}
