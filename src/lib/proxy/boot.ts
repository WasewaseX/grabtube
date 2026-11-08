import { fetch as undiciFetch, type RequestInit as UndiciRequestInit } from "undici";

import { activeLane } from "./lanes";
import { TRACE_URL, probeAll } from "./probe";
import { ensureWarpService } from "./warp";

declare global {
  var __tgProxyBooted: boolean | undefined;
}

if (!globalThis.__tgProxyBooted) {
  globalThis.__tgProxyBooted = true;
  ensureWarpService();
  setTimeout(() => void probeAll(), 500);
  setInterval(() => void probeAll(), 60_000);
  // keep-alive the agents so sockets through the tunnel stay warm
  setInterval(() => {
    try {
      const dispatcher = activeLane().agent;
      const req = dispatcher
        ? undiciFetch(TRACE_URL, { dispatcher, signal: AbortSignal.timeout(8000) } as UndiciRequestInit)
        : fetch(TRACE_URL, { signal: AbortSignal.timeout(8000) });
      void req.then((r) => r.body?.cancel()).catch(() => undefined);
    } catch {
      /* noop */
    }
  }, 25_000);
}
