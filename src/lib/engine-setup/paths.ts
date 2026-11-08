/** Provisioned toolchain paths (all under the project dir, wiped by sandbox resets). */

export const PROJECT = "/home/z/my-project";
export const TOOLS = `${PROJECT}/tools`;
export const VENV_YTDLP = `${TOOLS}/venv/bin/yt-dlp`;
export const DENO_BIN = `${TOOLS}/deno/bin/deno`;
export const POT_ENTRY = `${PROJECT}/mini-services/pot-provider/server/src/main.ts`;
export const WIREPROXY_BIN = `${PROJECT}/mini-services/warp-proxy/wireproxy`;
export const WARP_CONF = `${PROJECT}/mini-services/warp-proxy/warp.conf`;
