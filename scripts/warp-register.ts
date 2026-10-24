/**
 * Register a fresh Cloudflare WARP identity and emit mini-services/warp-proxy/warp.conf.
 * Uses node:crypto x25519 (raw pkcs8/spki tails) for the WireGuard keypair and
 * curl (TLS-fingerprint-safe) for the registration API.
 */
import { generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { writeFileSync, existsSync, readFileSync } from "node:fs";

const CONF = "/home/z/my-project/mini-services/warp-proxy/warp.conf";
const WARP_PEER_PUB = "bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo=";
const ENDPOINT_PORTS = [2408, 500, 1701, 4500, 928];

function b64urlToBytes(s: string): Uint8Array {
  const b = Buffer.from(s, "base64");
  return new Uint8Array(b);
}

function toB64Std(urlB64: string): string {
  return Buffer.from(urlB64, "base64").toString("base64");
}

if (existsSync(CONF)) {
  console.log("[warp-register] warp.conf exists — reusing existing identity");
  process.exit(0);
}

const { publicKey, privateKey } = generateKeyPairSync("x25519");
const privRaw = (privateKey.export({ type: "pkcs8", format: "der" }) as Buffer).subarray(-32);
const pubRaw = (publicKey.export({ type: "spki", format: "der" }) as Buffer).subarray(-32);
const privB64 = privRaw.toString("base64");
const pubB64 = pubRaw.toString("base64");
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

const r = spawnSync(
  "curl",
  [
    "-s",
    "--compressed",
    "-X",
    "POST",
    "https://api.cloudflareclient.com/v0a2158/reg",
    "-H", "Content-Type: application/json; charset=utf-8",
    "-H", "Host: api.cloudflareclient.com",
    "-H", "Connection: Keep-Alive",
    "-H", "Accept-Encoding: gzip",
    "-H", "User-Agent: okhttp/3.12.1",
    "--max-time", "30",
    "--data", body,
  ],
  { encoding: "utf8" },
);

const out = r.stdout || "";
const json = (() => {
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
})();

// the API returns the registration object at the top level (no success/result wrapper)
const res = json?.config?.peers ? json : json?.result;
if (!res?.config?.peers?.[0]) {
  console.error("[warp-register] registration FAILED");
  console.error(out.slice(0, 800));
  process.exit(1);
}

const peer = res.config.peers[0];
const endpointV4 = (peer.endpoint?.v4 || "162.159.192.1").split(":")[0];
const ports: number[] = peer.endpoint?.ports?.length ? peer.endpoint.ports : [2408, 500, 1701, 4500];
const v6 = res.config.interface?.addresses?.v6 ?? "2606:4700:110::/128";
const v4 = res.config.interface?.addresses?.v4 ?? "172.16.0.2/32";
const reservedBytes = b64urlToBytes(res.config.client_id ?? "");
const reserved = Array.from(reservedBytes).join(",");

if (reservedBytes.length !== 3) {
  console.error("[warp-register] bad client_id/reserved:", res.config.client_id);
  process.exit(1);
}

const port = ports[Math.floor(Math.random() * Math.min(2, ports.length))];
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
  `Endpoint = ${endpointV4}:${port}`,
  `Reserved = ${reserved}`,
  "PersistentKeepalive = 25",
  "",
  "[Socks5]",
  "BindAddress = 127.0.0.1:41080",
  "",
].join("\n");

writeFileSync(CONF, conf);
console.log(`[warp-register] OK — account ${res.id ?? "?"} egress endpoint ${endpointV4}:${port} reserved [${reserved}]`);
console.log("[warp-register] warp.conf written");
