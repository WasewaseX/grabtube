import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Job } from "./types";

declare global {
  var __tgJobs: Map<string, Job> | undefined;
  var __tgJobsCleanup: NodeJS.Timeout | undefined;
}

export function jobStore(): Map<string, Job> {
  if (!globalThis.__tgJobs) globalThis.__tgJobs = new Map();
  return globalThis.__tgJobs;
}

export function jobsDir(): string {
  const dir = path.join(tmpdir(), "tubegrab-jobs");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}
