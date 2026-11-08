/** Subprocess helpers for the provisioners (execFile promises, curl downloader). */

import { execFile } from "child_process";

/** curl-based fetch (TLS fingerprint safe) → local file. */
export function curlTo(url: string, out: string, timeoutMs = 180_000): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      "curl",
      ["-fsSL", "--max-time", String(Math.floor(timeoutMs / 1000)), "-o", out, url],
      { timeout: timeoutMs },
      (err) => (err ? reject(err) : resolve()),
    );
  });
}

export function sh(
  cmd: string,
  args: string[],
  timeoutMs = 240_000,
  opts?: { env?: NodeJS.ProcessEnv; cwd?: string },
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { timeout: timeoutMs, env: { ...process.env, ...(opts?.env ?? {}) }, cwd: opts?.cwd },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`${cmd} failed: ${String(stderr || err).slice(-300)}`));
        else resolve(String(stdout));
      },
    );
  });
}

export function execFileSyncShim(cmd: string, args: string[]): string {
  // tiny sync probe used only for python discovery
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { execFileSync } = require("child_process") as typeof import("child_process");
  return execFileSync(cmd, args, { timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] }).toString();
}
