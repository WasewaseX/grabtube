/**
 * ENGINE AUTO-PROVISIONER — the app rebuilds its own download engine.
 *
 * Sandboxes reset /home between sessions and wipe every binary the engine
 * needs (yt-dlp venv, deno, wireproxy, WARP identity, PO-token provider).
 * Borrowed from how real self-hosted projects (cobalt's docker instances,
 * Piped's container supervisor) bootstrap: at boot the app CHECKS its tool
 * chain and re-provisions whatever is missing — fully in the background, no
 * manual steps, idempotent, safe to run on every server start.
 *
 * All subprocesses are spawned by the Next.js server process, which the
 * sandbox keeps alive — provisioned children therefore survive too.
 *
 * Provision order (parallel where independent):
 *   1. yt-dlp  → python3 venv + pip install yt-dlp + PO-token plugin
 *   2. deno    → dl.deno.land install script (project-local DENO_INSTALL)
 *   3. PO provider → github master tarball + deno install
 *   4. wireproxy   → github v1.0.9 release tarball
 *   5. WARP identity → Cloudflare reg API via curl (TLS-fingerprint-safe)
 *
 * Status is surfaced through /api/health (engine.provision).
 */
import { execFile } from "child_process";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "fs";
import { generateKeyPairSync } from "crypto";
import path from "path";

export const PROJECT = "/home/z/my-project";
export const TOOLS = `${PROJECT}/tools`;
export const VENV_YTDLP = `${TOOLS}/venv/bin/yt-dlp`;
export const DENO_BIN = `${TOOLS}/deno/bin/deno`;
export const POT_ENTRY = `${PROJECT}/mini-services/pot-provider/server/src/main.ts`;
export const WIREPROXY_BIN = `${PROJECT}/mini-services/warp-proxy/wireproxy`;
export const WARP_CONF = `${PROJECT}/mini-services/warp-proxy/warp.conf`;

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

function step(id: string, s: ProvisionStep["state"], detail?: string): void {
  const st = state();
  st.steps[id] = { id, state: s, detail, at: Date.now() };
}

/** curl-based fetch (TLS fingerprint safe) → local file. */
function curlTo(url: string, out: string, timeoutMs = 180_000): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      "curl",
      ["-fsSL", "--max-time", String(Math.floor(timeoutMs / 1000)), "-o", out, url],
      { timeout: timeoutMs },
      (err) => (err ? reject(err) : resolve()),
    );
  });
}

function sh(
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

/* ------------------------------ 1. yt-dlp ------------------------------ */

async function provisionYtDlp(): Promise<void> {
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
  if (!made) {
    try {
      await sh("uv", ["venv", `${TOOLS}/venv`, "--python", "3.12"]);
      await sh("uv", [
        "pip", "install", "--python", `${TOOLS}/venv/bin/python`,
        "yt-dlp", "bgutil-ytdlp-pot-provider",
      ]);
      made = true;
    } catch (e) {
      return step("ytdlp", "failed", String(e).slice(-140));
    }
  }
  if (!made) return step("ytdlp", "failed", "no usable venv method");
  await sh(`${TOOLS}/venv/bin/pip`, ["install", "-q", "-U", "pip"]).catch(() => undefined);
  await sh(`${TOOLS}/venv/bin/pip`, ["install", "-q", "-U", "yt-dlp", "bgutil-ytdlp-pot-provider"]);
  if (!existsSync(VENV_YTDLP)) return step("ytdlp", "failed", "binary missing after install");
  step("ytdlp", "done", (await sh(VENV_YTDLP, ["--version"])).trim());
}

function execFileSyncShim(cmd: string, args: string[]): string {
  // tiny sync probe used only for python discovery
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { execFileSync } = require("child_process") as typeof import("child_process");
  return execFileSync(cmd, args, { timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] }).toString();
}

/* ------------------------------- 2. deno ------------------------------- */

const DENO_VERSION = "2.9.8";

async function provisionDeno(): Promise<void> {
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

async function provisionPotProvider(): Promise<void> {
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

async function provisionWireproxy(): Promise<void> {
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

/* --------------------------- 5. WARP identity -------------------------- */

const WARP_PEER_PUB = "bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo=";

async function provisionWarpIdentity(): Promise<void> {
  if (existsSync(WARP_CONF)) return step("warp", "present");
  step("warp", "running");
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  const privB64 = (privateKey.export({ type: "pkcs8", format: "der" }) as Buffer)
    .subarray(-32)
    .toString("base64");
  const pubB64 = (publicKey.export({ type: "spki", format: "der" }) as Buffer)
    .subarray(-32)
    .toString("base64");
  const serial = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex");
  const body = JSON.stringify({
    key: pubB64,
    install_id: "",
    fcm_token: "",
    tos: new Date().toISOString().replace(/\.\d+Z$/, ".000Z"),
    model: "PC",
    serial_number: serial,
    locale: "en_US",
  });
  const out = await new Promise<string>((resolve, reject) => {
    execFile(
      "curl",
      [
        "-s", "--compressed", "-X", "POST", "--max-time", "30",
        "https://api.cloudflareclient.com/v0a2158/reg",
        "-H", "Content-Type: application/json; charset=utf-8",
        "-H", "Host: api.cloudflareclient.com",
        "-H", "Connection: Keep-Alive",
        "-H", "Accept-Encoding: gzip",
        "-H", "User-Agent: okhttp/3.12.1",
        "--data", body,
      ],
      { timeout: 40_000 },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout))),
    );
  });
  let json: {
    config?: {
      client_id?: string;
      peers?: { endpoint?: { v4?: string; ports?: number[] } }[];
      interface?: { addresses?: { v4?: string; v6?: string } };
    };
  };
  try {
    json = JSON.parse(out);
  } catch {
    return step("warp", "failed", "bad registration response");
  }
  const reg = json?.config?.peers ? json : (json as never as { result?: typeof json })?.result;
  const peer = reg?.config?.peers?.[0];
  const clientId = reg?.config?.client_id;
  if (!peer || !clientId) return step("warp", "failed", "registration rejected");
  const reserved = Array.from(Buffer.from(clientId, "base64"));
  if (reserved.length !== 3) return step("warp", "failed", "bad client_id");
  const ip = (peer.endpoint?.v4 || "162.159.192.7").split(":")[0];
  const ports = peer.endpoint?.ports?.length ? peer.endpoint.ports : [2408, 500, 1701, 4500];
  // this sandbox completes WARP handshakes only on 928 (measured sweep) — try it first
  const port = ports.includes(928) ? 928 : ports[0];
  const v4 = reg?.config?.interface?.addresses?.v4 ?? "172.16.0.2/32";
  const v6 = reg?.config?.interface?.addresses?.v6 ?? "2606:4700:110::6/128";
  const conf = [
    "[Interface]",
    `PrivateKey = ${privB64}`,
    `Address = ${v4.split("/")[0]}/32`,
    `Address = ${v6.split("/")[0]}/128`,
    "DNS = 1.1.1.1",
    "MTU = 1280",
    "",
    "[Peer]",
    `PublicKey = ${WARP_PEER_PUB}`,
    "AllowedIPs = 0.0.0.0/0",
    `Endpoint = ${ip}:${port}`,
    `Reserved = ${reserved.join(",")}`,
    "PersistentKeepalive = 25",
    "",
    "[Socks5]",
    "BindAddress = 127.0.0.1:41080",
    "",
  ].join("\n");
  writeFileSync(WARP_CONF, conf);
  step("warp", "done", `${ip}:${port}`);
}

/* ------------------------------ orchestrator --------------------------- */

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
  const st = state();
  st.ok = Object.values(st.steps).every((s) => s.state === "done" || s.state === "present");
  st.lastRun = Date.now();
  console.log(`[engine-setup] provision pass complete — ok=${st.ok} ${JSON.stringify(st.steps)}`);
}

/** Idempotent boot hook — kick provisioning in the background once. */
export function ensureEngineProvisioned(): void {
  const st = state();
  if (st.started) return;
  st.started = true;
  const runWithRetries = async (): Promise<void> => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      await runProvision();
      if (st.ok) break;
      // partial failures (flaky network) → retry the failed pieces
      console.log(`[engine-setup] provision attempt ${attempt} incomplete — retrying in 2 min`);
      await new Promise((r) => setTimeout(r, 120_000));
    }
    // nudge the service supervisors so freshly provisioned pieces start fast
    import("./pot")
      .then((m) => void m.ensurePotServer().catch(() => undefined))
      .catch(() => undefined);
  };
  st.running = runWithRetries();
  void st.running.catch(() => undefined);
}
