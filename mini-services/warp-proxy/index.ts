/** WARP proxy mini-service: (1) wireproxy supervisor (userspace WireGuard →
 *  local SOCKS5 on 41080) and (2) an HTTP CONNECT bridge on 41081 tunnelling
 *  through it. Both share one WARP egress IP so googlevideo's IP-locked URLs
 *  stay consistent between URL minting and media fetching. */
import { listen, connect, type Socket } from "bun";
import { readFileSync, writeFileSync } from "node:fs";

const BIN = new URL("./wireproxy", import.meta.url).pathname;
const CONF = new URL("./warp.conf", import.meta.url).pathname;
const SOCKS_PORT = 41080;
const HTTP_PORT = 41081;

/* ------------------------- wireproxy supervisor ------------------------- */

let child: ReturnType<typeof Bun.spawn> | null = null;
let restarting = false;
/** exponential restart backoff — restart-storms generate handshake spam that
 *  gets the WARP identity device-throttled by Cloudflare (tunnel then stays
 *  dead for a LONG time; a fresh identity is the only cure) */
let restartDelayMs = 2000;
const RESTART_DELAY_CAP = 60_000;

/** WARP supports many UDP ports; networks throttle some, so we rotate when
 *  handshakes stop completing (registration API ports listed first). NOTE:
 *  this sandbox only completes handshakes on 928 — it MUST stay first or
 *  rotation walks into a death spiral. */
const ENDPOINT_PORTS = [928, 2408, 500, 1701, 4500, 854, 894, 1843, 2506, 939, 945, 903];
let portIdx = Math.max(0, ENDPOINT_PORTS.indexOf(currentEndpointPort()));
let handshakeFails = 0;
let lastHandshakeOk = 0;

function currentEndpointIp(): string {
  try {
    const conf = readFileSync(CONF, "utf8");
    const m = conf.match(/^Endpoint = ([^:]+):/m);
    return m ? m[1] : "162.159.192.7";
  } catch {
    return "162.159.192.7";
  }
}

function currentEndpointPort(): number {
  try {
    const conf = readFileSync(CONF, "utf8");
    const m = conf.match(/^Endpoint = .*:(\d+)/m);
    return m ? parseInt(m[1], 10) : 928;
  } catch {
    return 928;
  }
}

/** rotate across Cloudflare's engage endpoint IPs too — a degraded NAT flow
 *  to one IP often stays degraded; a new IP + port pair forces fresh paths */
const ENDPOINT_IPS = [
  "162.159.192.7", "162.159.192.1", "162.159.193.10", "162.159.193.1",
  "162.159.204.1", "162.159.192.3", "162.159.193.5", "162.159.204.3",
];
let ipIdx = 0;
/** last endpoint pair that completed handshakes — rotation snaps back here
 *  before wandering into untested combos (a known-good pair beats a roulette) */
let lastGood: { ip: string; port: number } | null = null;

/** snap back to the last proven-working pair before trying new combos */
function trySnapBack(reason: string): boolean {
  if (!lastGood) return false;
  const confIp = currentEndpointIp();
  const confPort = currentEndpointPort();
  if (lastGood.ip === confIp && lastGood.port === confPort) return false;
  try {
    const conf = readFileSync(CONF, "utf8");
    writeFileSync(CONF, conf.replace(/^Endpoint = .*$/m, `Endpoint = ${lastGood.ip}:${lastGood.port}`));
    console.log(`[warp-proxy] snapping back to known-good → ${lastGood.ip}:${lastGood.port} (${reason})`);
    return true;
  } catch (e) {
    console.error(`[warp-proxy] snap-back failed: ${String(e)}`);
    return false;
  }
}

function rotateEndpoint(reason: string) {
  if (trySnapBack(reason)) return;
  portIdx = (portIdx + 1) % ENDPOINT_PORTS.length;
  const port = ENDPOINT_PORTS[portIdx];
  ipIdx = (ipIdx + 1) % ENDPOINT_IPS.length;
  const ip = ENDPOINT_IPS[ipIdx];
  try {
    const conf = readFileSync(CONF, "utf8");
    writeFileSync(CONF, conf.replace(/^Endpoint = .*$/m, `Endpoint = ${ip}:${port}`));
    console.log(`[warp-proxy] rotating endpoint → ${ip}:${port} (${reason})`);
  } catch (e) {
    console.error(`[warp-proxy] rotate failed: ${String(e)}`);
  }
}

/** a live session resets the failure counter only on traffic, which the
 *  health prober measures — see probe loop below. Returns true when the batch
 *  must stop being processed (escalation consumed it). */
function handleWireproxyLine(l: string): boolean {
  if (l.includes("Handshake did not complete")) {
    handshakeFails++;
    return maybeEscalateStuckHandshake();
  }
  if (l.includes("UDP bind has been updated") || l.includes("Received handshake response")) {
    handshakeFails = 0;
    lastHandshakeOk = Date.now();
    markTunnelAlive();
  }
  return false;
}

/** stuck handshakes → rotate endpoint + restart the child */
function maybeEscalateStuckHandshake(): boolean {
  if (handshakeFails < 6 || Date.now() - lastHandshakeOk <= 60_000) return false;
  handshakeFails = 0;
  rotateEndpoint("handshake stuck");
  killWireproxy();
  return true;
}

function killWireproxy() {
  try {
    child?.kill(9);
  } catch {
    /* noop */
  }
}

function startWireproxy() {
  console.log(`[warp-proxy] starting wireproxy (${new Date().toISOString()})`);
  try {
    child = Bun.spawn([BIN, "-c", CONF], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });

    // watch stderr for stuck handshakes → rotate endpoint + restart
    let line = "";
    const watch = (stream: ReadableStream<Uint8Array>) => {
      const decoder = new TextDecoder();
      (async () => {
        for await (const chunk of stream) {
          line += decoder.decode(chunk, { stream: true });
          const lines = line.split("\n");
          line = lines.pop() ?? "";
          for (const l of lines) {
            if (handleWireproxyLine(l)) break;
          }
        }
      })();
    };
    const { stderr, stdout } = child;
    if (typeof stderr !== "number" && stderr) watch(stderr);
    if (typeof stdout !== "number" && stdout) watch(stdout);

    void child.exited.then((code) => {
      console.log(`[warp-proxy] wireproxy exited code=${code}`);
      child = null;
      scheduleRestart();
    });
  } catch (e) {
    console.error(`[warp-proxy] spawn failed: ${String(e)}`);
    scheduleRestart();
  }
}

function scheduleRestart() {
  if (restarting) return;
  restarting = true;
  const delay = restartDelayMs;
  restartDelayMs = Math.min(restartDelayMs * 2, RESTART_DELAY_CAP);
  setTimeout(() => {
    restarting = false;
    if (!child) startWireproxy();
  }, delay);
}

/** a healthy probe (or live handshake) resets the backoff ramp */
function markTunnelAlive() {
  restartDelayMs = 2000;
}

/** Active health probe: if the tunnel stops passing traffic, rotate + restart. */
async function healthProbe() {
  try {
    const res = await fetch("https://www.cloudflare.com/cdn-cgi/trace", {
      proxy: "http://127.0.0.1:41081",
      signal: AbortSignal.timeout(12_000),
    });
    const text = await res.text();
    if (res.ok && text.includes("warp=on")) {
      handshakeFails = 0;
      lastHandshakeOk = Date.now();
      markTunnelAlive();
      try {
        const m = readFileSync(CONF, "utf8").match(/^Endpoint = (\S+):(\d+)/m);
        if (m) lastGood = { ip: m[1], port: parseInt(m[2], 10) };
      } catch {
        /* noop */
      }
      console.log(`[warp-proxy] health OK (${new Date().toISOString()})`);
      return;
    }
    throw new Error(`bad trace: ${text.slice(0, 60)}`);
  } catch (e) {
    console.log(`[warp-proxy] health probe failed: ${String(e).slice(0, 100)}`);
    if (Date.now() - lastHandshakeOk > 90_000) {
      rotateEndpoint("health probe dead");
      lastHandshakeOk = Date.now(); // avoid tight rotation loops
      killWireproxy();
    }
  }
}

setInterval(() => void healthProbe(), 60_000);
setTimeout(() => void healthProbe(), 15_000);

/* --------------------- SOCKS5 client handshake state -------------------- */

interface BridgeState {
  buf: string; // request bytes not yet parsed (latin1-safe)
  host: string;
  port: number;
  remote: Socket | null;
  connected: boolean;
  pending: Buffer; // client bytes received before tunnel is up
  socksPhase: "greet" | "connect" | "tunnel";
  replyBuf: Buffer;
}

const states = new WeakMap<Socket, BridgeState>();

function st(client: Socket): BridgeState {
  let s = states.get(client);
  if (!s) {
    s = {
      buf: "",
      host: "",
      port: 0,
      remote: null,
      connected: false,
      pending: Buffer.alloc(0),
      socksPhase: "greet",
      replyBuf: Buffer.alloc(0),
    };
    states.set(client, s);
  }
  return s;
}

function socksConnectRequest(host: string, port: number): Buffer {
  const h = Buffer.from(host, "utf8");
  const head = Buffer.from([0x05, 0x01, 0x00, 0x03, h.length]);
  const tail = Buffer.alloc(2);
  tail.writeUInt16BE(port);
  return Buffer.concat([head, h, tail]);
}

/** Feed SOCKS5 server bytes; returns true once the tunnel is established. */
function socksFeed(s: BridgeState, remote: Socket, client: Socket, data: Buffer): boolean {
  s.replyBuf = Buffer.concat([s.replyBuf, data]);

  if (s.socksPhase === "greet") {
    if (s.replyBuf.length < 2) return false;
    if (s.replyBuf[0] !== 0x05 || s.replyBuf[1] !== 0x00) {
      client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      client.end();
      remote.end();
      return false;
    }
    s.socksPhase = "connect";
    s.replyBuf = s.replyBuf.subarray(2);
    remote.write(socksConnectRequest(s.host, s.port));
  }

  if (s.socksPhase === "connect") {
    // reply: ver(1) rep(1) rsv(1) atyp(1) addr(varies) port(2)
    if (s.replyBuf.length < 5) return false;
    const atyp = s.replyBuf[3];
    let need = 0;
    if (atyp === 0x01) need = 4 + 4 + 2;
    else if (atyp === 0x04) need = 4 + 16 + 2;
    else if (atyp === 0x03) need = 4 + 1 + s.replyBuf[4] + 2;
    else {
      client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      client.end();
      remote.end();
      return false;
    }
    if (s.replyBuf.length < need) return false;
    const rep = s.replyBuf[1];
    const rest = s.replyBuf.subarray(need);
    if (rep !== 0x00) {
      console.log(`[warp-proxy] socks connect refused rep=${rep} ${s.host}:${s.port}`);
      client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      client.end();
      remote.end();
      return false;
    }
    s.socksPhase = "tunnel";
    s.connected = true;
    client.write("HTTP/1.1 200 Connection established\r\n\r\n");
    if (s.pending.length) {
      remote.write(s.pending);
      s.pending = Buffer.alloc(0);
    }
    // any bytes after the handshake belong to the tunnel payload
    if (rest.length) client.write(rest);
    return true;
  }
  return false;
}

/* --------------------------- CONNECT listener --------------------------- */

const server = listen({
  hostname: "127.0.0.1",
  port: HTTP_PORT,
  socket: {
    open(client) {
      st(client);
    },
    data(client, data) {
      const s = st(client);

      if (s.connected && s.remote) {
        s.remote.write(data);
        return;
      }

      if (!s.remote) {
        // parse the CONNECT request line
        s.buf += data.toString("latin1");
        const idx = s.buf.indexOf("\r\n\r\n");
        if (idx === -1) return;
        const m = s.buf.match(/CONNECT\s+([^\s:]+):(\d+)/i);
        if (!m) {
          client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
          client.end();
          return;
        }
        s.host = m[1];
        s.port = parseInt(m[2], 10);
        // everything after the request header belongs to the tunneled stream
        const leftover = Buffer.from(s.buf.slice(idx + 4), "latin1");
        s.pending = leftover;
        s.buf = "";
        connect({
          hostname: "127.0.0.1",
          port: SOCKS_PORT,
          socket: {
            open(remote) {
              remote.write(Buffer.from([0x05, 0x01, 0x00]));
            },
            data(remote, d) {
              // once the tunnel is up, everything is raw payload → client
              if (s.connected) {
                client.write(d);
                return;
              }
              const ok = socksFeed(s, remote, client, d);
              if (ok) {
                s.remote = remote;
              }
            },
            error(_remote, e) {
              console.log(`[warp-proxy] socks error ${s.host}:${s.port} ${String(e).slice(0, 80)}`);
              client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
              client.end();
            },
            close() {
              client.end();
            },
          },
        }).catch((e) => {
          console.log(`[warp-proxy] socks dial failed: ${String(e).slice(0, 80)}`);
          client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
          client.end();
        });
        return;
      }

      // remote exists but handshake not finished yet
      s.pending = Buffer.concat([s.pending, data]);
    },
    close(client) {
      const s = states.get(client);
      s?.remote?.end();
    },
    error(client, e) {
      const s = states.get(client);
      s?.remote?.end();
      console.log(`[warp-proxy] client error ${String(e).slice(0, 80)}`);
    },
  },
});

/* --------------------------------- boot --------------------------------- */

startWireproxy();

console.log(
  `[warp-proxy] HTTP CONNECT bridge listening on 127.0.0.1:${server.port} → socks5://127.0.0.1:${SOCKS_PORT}`,
);

setInterval(() => {
  console.log(`[warp-proxy] alive=${!!child} ts=${new Date().toISOString()}`);
}, 5 * 60 * 1000).unref();
