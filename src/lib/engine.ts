/** Legacy download pipeline (yt-dlp strategy rotation) — consumed only by
 *  /api/stress. Public API re-exported verbatim from src/lib/engine/*. */

export { DOWNLOAD_DIR, startDownload } from './engine/runner'
export { cancelDownload, isJobActive } from './engine/registry'
export { buildFormatString, buildOutputArgs } from './engine/format'
export type { SelectOptions } from './engine/format'
export { parseProgressLine } from './engine/progress'
export { recoverInterruptedJobs } from './engine/recovery'
