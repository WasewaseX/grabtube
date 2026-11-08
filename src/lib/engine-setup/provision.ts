/* ------------------------------ 1-4: toolchain provisioners ------------------------------ */

import { existsSync, mkdirSync, renameSync } from "fs";
import { curlTo, execFileSyncShim, sh } from "./exec";
import { DENO_BIN, POT_ENTRY, PROJECT, TOOLS, VENV_YTDLP, WIREPROXY_BIN } from "./paths";
import { step } from "./state";

/* ------------------------------ 1. yt-dlp ------------------------------ */

export async function provisionYtDlp(): Promise<void> {
  if (existsSync(VENV_YTDLP)) return step("ytdlp", "present");
  step("ytdlp", "running");
  // /usr/bin/python3 often ships WITHOUT ensurepip in slim images — the
  // platform's uv-managed venv python works, and uv itself is the bulletproof
  // fallback (it bootstraps its own interpreter if needed).
  const py = ["/home/z/.venv/bin/python3", "python3", "/usr/bin/python3"].find((p) => {
    try {
      execFileSyncShim(p, ["--version"]);
      return true;
    } catch {
      return false;
    }
  });
  let made = false;
  if (py) {
    try {
      await sh(py, ["-m", "venv", `${TOOLS}/venv`]);
      made = true;
    } catch {
      made = false;
    }
  }
  if (!made && !(await venvViaUv())) return;
  await sh(`${TOOLS}/venv/bin/pip`, ["install", "-q", "-U", "pip"]).catch(() => undefined);
  await sh(`${TOOLS}/venv/bin/pip`, ["install", "-q", "-U", "yt-dlp", "bgutil-ytdlp-pot-provider"]);
  if (!existsSync(VENV_YTDLP)) return step("ytdlp", "failed", "binary missing after install");
  step("ytdlp", "done", (await sh(VENV_YTDLP, ["--version"])).trim());
}

/** uv fallback venv bootstrap; records the failure step itself on error. */
async function venvViaUv(): Promise<boolean> {
  try {
    await sh("uv", ["venv", `${TOOLS}/venv`, "--python", "3.12"]);
    await sh("uv", [
      "pip", "install", "--python", `${TOOLS}/venv/bin/python`,
      "yt-dlp", "bgutil-ytdlp-pot-provider",
    ]);
    return true;
  } catch (e) {
    step("ytdlp", "failed", String(e).slice(-140));
    return false;
  }
}

/* ------------------------------- 2. deno ------------------------------- */

const DENO_VERSION = "2.9.8";

export async function provisionDeno(): Promise<void> {
  if (existsSync(DENO_BIN)) return step("deno", "present");
  step("deno", "running");
  mkdirSync(`${TOOLS}/deno/bin`, { recursive: true });
  // direct release asset — install.sh's flags drift between versions
  await curlTo(
    `https://dl.deno.land/release/v${DENO_VERSION}/deno-x86_64-unknown-linux-gnu.zip`,
    "/tmp/deno.zip",
    300_000,
  );
  await sh("unzip", ["-o", "/tmp/deno.zip", "-d", "/tmp/deno-extract"]);
  const extracted = "/tmp/deno-extract/deno";
  if (!existsSync(extracted)) return step("deno", "failed", "zip missing deno binary");
  const { copyFileSync, chmodSync } = await import("fs");
  copyFileSync(extracted, DENO_BIN);
  chmodSync(DENO_BIN, 0o755);
  if (!existsSync(DENO_BIN)) return step("deno", "failed", "binary missing after install");
  step("deno", "done", (await sh(DENO_BIN, ["--version"])).split("\n")[0]);
}

/* --------------------------- 3. PO provider ---------------------------- */

export async function provisionPotProvider(): Promise<void> {
  if (existsSync(POT_ENTRY)) return step("pot", "present");
  step("pot", "running");
  const tgz = "/tmp/pot-provider.tgz";
  await curlTo(
    "https://github.com/Brainicism/bgutil-ytdlp-pot-provider/archive/refs/heads/master.tar.gz",
    tgz,
  );
  await sh("tar", ["xz", "-C", `${PROJECT}/mini-services`, "-f", tgz]);
  const src = `${PROJECT}/mini-services/bgutil-ytdlp-pot-provider-master`;
  try {
    renameSync(src, `${PROJECT}/mini-services/pot-provider`);
  } catch {
    /* already moved by a racing run */
  }
  if (!existsSync(POT_ENTRY)) return step("pot", "failed", "entry missing after extract");
  // pre-resolve deno deps into the cache — the first `deno run` otherwise
  // spends minutes downloading, which outlives pot.ts's startup ping window
  if (existsSync(DENO_BIN)) {
    await sh(DENO_BIN, ["install", "-q"], 300_000, {
      cwd: `${PROJECT}/mini-services/pot-provider/server`,
    }).catch((e) => step("pot", "failed", `deno install: ${String(e).slice(-100)}`));
  }
  step("pot", "done", "bgutil provider extracted + deps cached");
}

/* ---------------------------- 4. wireproxy ----------------------------- */

export async function provisionWireproxy(): Promise<void> {
  if (existsSync(WIREPROXY_BIN)) return step("wireproxy", "present");
  step("wireproxy", "running");
  const tgz = "/tmp/wireproxy.tgz";
  await curlTo(
    "https://github.com/pufferffish/wireproxy/releases/download/v1.0.9/wireproxy_linux_amd64.tar.gz",
    tgz,
  );
  await sh("tar", ["xz", "-C", `${PROJECT}/mini-services/warp-proxy`, "-f", tgz]);
  if (!existsSync(WIREPROXY_BIN)) return step("wireproxy", "failed", "binary missing after extract");
  await sh("chmod", ["+x", WIREPROXY_BIN]);
  step("wireproxy", "done", (await sh(WIREPROXY_BIN, ["--version"])).trim());
}
