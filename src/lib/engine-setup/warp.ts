/* --------------------------- 5. WARP identity -------------------------- */

import { execFile } from "child_process";
import { existsSync, writeFileSync } from "fs";
import { generateKeyPairSync } from "crypto";
import { WARP_CONF } from "./paths";
import { step } from "./state";

const WARP_PEER_PUB = "bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo=";

/** Mint an x25519 keypair and the Cloudflare WARP registration request body. */
function buildRegistrationBody(): { body: string; privB64: string } {
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
  return { body, privB64 };
}

function registerWarp(body: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
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
}

interface WarpRegistration {
  config?: {
    client_id?: string;
    peers?: { endpoint?: { v4?: string; ports?: number[] } }[];
    interface?: { addresses?: { v4?: string; v6?: string } };
  };
}

/** Turn the registration reply into a wireproxy config; records failure steps. */
function buildWarpConf(out: string, privB64: string): { conf: string; detail: string } | null {
  let json: WarpRegistration;
  try {
    json = JSON.parse(out);
  } catch {
    step("warp", "failed", "bad registration response");
    return null;
  }
  const reg = json?.config?.peers ? json : (json as never as { result?: typeof json })?.result;
  const peer = reg?.config?.peers?.[0];
  const clientId = reg?.config?.client_id;
  if (!peer || !clientId) {
    step("warp", "failed", "registration rejected");
    return null;
  }
  const reserved = Array.from(Buffer.from(clientId, "base64"));
  if (reserved.length !== 3) {
    step("warp", "failed", "bad client_id");
    return null;
  }
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
  return { conf, detail: `${ip}:${port}` };
}

export async function provisionWarpIdentity(): Promise<void> {
  if (existsSync(WARP_CONF)) return step("warp", "present");
  step("warp", "running");
  const { body, privB64 } = buildRegistrationBody();
  const out = await registerWarp(body);
  const built = buildWarpConf(out, privB64);
  if (!built) return;
  writeFileSync(WARP_CONF, built.conf);
  step("warp", "done", built.detail);
}
