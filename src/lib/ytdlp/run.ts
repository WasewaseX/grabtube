import { execFile } from 'node:child_process'

import { getYtDlpPath, toolEnv } from './tools'

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

export function runYtDlp(args: string[], timeoutMs = 120000): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(
      getYtDlpPath(),
      args,
      { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env: toolEnv() },
      (err, stdout, stderr) => {
        if (err && typeof (err as NodeJS.ErrnoException).code === 'undefined' && !stdout && !stderr) {
          return reject(err)
        }
        resolve({ code: err ? 1 : 0, stdout: stdout ?? '', stderr: stderr ?? '' })
      }
    )
  })
}
