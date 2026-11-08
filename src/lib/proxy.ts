/**
 * Egress lane manager: extraction and media fetching MUST share one egress
 * (googlevideo URLs are IP-locked): WARP first, user proxies, then direct.
 */
export { COOKIES_PATH, DATA_DIR, SETTINGS_PATH, loadSettings } from "./proxy/settings";
export type { Settings } from "./proxy/settings";
export {
  activeLane,
  ffmpegProxyEnv,
  laneSnapshot,
  mediaDispatcher,
  proxiedFetch,
  reloadLanes,
  ytDlpProxy,
} from "./proxy/lanes";
export type { LaneStatus } from "./proxy/lanes";
export { probeAll } from "./proxy/probe";
import "./proxy/boot";
