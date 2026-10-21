# TubeGrab

**Fast, resumable YouTube downloader for the web — engineered for hostile networks.** Every quality and codec up to 4K60, audio-only extraction, IDM-compatible permanent direct links, and an automatic multi-layer anti-bot engine that defeats the *"Sign in to confirm you're not a bot"* wall without any manual setup.

![stack](https://img.shields.io/badge/Next.js%2016-App%20Router-black) ![ts](https://img.shields.io/badge/TypeScript-strict-blue) ![license](https://img.shields.io/badge/license-MIT-green)

## Why TubeGrab

Most web downloaders die on three things: verification walls, mid-download failures on slow connections, and links that external download managers cannot touch. TubeGrab is engineered against all three:

| Problem | TubeGrab answer |
| --- | --- |
| *"Sign in to confirm you're not a bot"* | **Automatic 7-layer bypass**: ① Cloudflare WARP egress tunnel (consumer-grade IP defeats datacenter bot-walls) ② player-client rotation ③ visitor-data minting/rotation ④ bgutil PO-token provider (self-healing deno service) ⑤ remote JS-challenge solver (deno, solves the n-transform) ⑥ optional cookies.txt ⑦ Piped + Invidious community-proxy fleet fallback |
| Mid-download failures / slow networks | Browser-side auto-resume (up to 15 Range continuations into the same file), server-side bounded-window streaming with backpressure and mid-stream URL re-minting |
| IDM / aria2 / wget compatibility | `/api/dl` **permanent self-contained direct links** that survive restarts — `Accept-Ranges`, HTTP `206 Partial Content`, byte-exact `Content-Range`, UTF-8 `Content-Disposition`, fresh URL re-minting per hit |

## Features

- Desktop-style shell (macOS title bar, tab navigation) with **English + Persian (RTL)** UI
- Analyze any YouTube URL (watch / youtu.be / shorts / embed / live)
- Video: 144p → **2160p60**, codecs **H.264 / VP9 / AV1** with per-video availability and exact size estimates
- Audio-only: M4A / Opus direct, **MP3 320/192/128** server-side conversion
- Live per-item progress: percentage, speed, ETA, merge/convert phases; queue with cancel/remove
- **Egress lane dashboard**: live WARP tunnel health, latency, egress IP, user proxies, direct fallback
- Permanent direct links for download managers (copy button on every format row)
- Thumbnail proxying (works in regions where ytimg CDN is blocked)
- Hydration-safe, responsive, dark UI (Next.js 16 App Router, shadcn/ui, Tailwind 4)

## Architecture

```
Browser ── Next.js App Router (port 3000)
             ├─ POST /api/info         → extract(): yt-dlp → Piped/Invidious fallback
             ├─ GET  /api/download     → instant single-format proxy stream (Range/206)
             ├─ POST /api/jobs         → merge / MP3 conversion jobs (in-memory queue)
             ├─ GET  /api/jobs/[id]    → progress polling
             ├─ GET  /api/jobs/[id]/file → resumable job file server
             ├─ GET  /api/dl           → PERMANENT IDM/aria2 direct links (re-minting)
             ├─ GET  /api/thumb        → SSRF-guarded thumbnail proxy
             ├─ GET  /api/settings     → cookies + extra proxies + live lanes
             └─ GET  /api/health       → toolchain + lane dashboard
                       │
        ┌──────────────┼───────────────────────────┐
   egress lane manager      yt-dlp engine          mini-services
   (src/lib/proxy.ts)       (client rotation,      ├─ warp-proxy: wireproxy
   WARP socks5/http →       visitor-data, PO-      │  (userspace WireGuard)
   user proxies → direct    tokens, remote EJS)    └─ pot-provider: bgutil
                                                    PO-token deno server :4416
```

**Extraction chain** (`src/lib/extract.ts`): yt-dlp through the active egress lane → on bot-wall/rate-limit, re-probe lanes and retry → still blocked → race the Piped/Invidious fleet (community proxy APIs return proxied stream URLs that work from any IP).

**Media streaming** (`src/lib/media-stream.ts`): bounded ranged windows (4 MiB), true backpressure (the client socket governs the pace), byte-exact re-rolls of short reads, mid-stream URL re-minting — slow clients can never blow up server memory.

## Quickstart

Requirements: Bun (or Node), Python 3 with pip, ffmpeg, deno.

```bash
# 1. install project dependencies
bun install            # or: npm install

# 2. install external toolchain (yt-dlp, deno, PO-token provider; checks ffmpeg)
./scripts/setup-tools.sh

# 3. push the database schema (settings persistence)
bun run db:push

# 4. start the WARP tunnel (auto-rotates WireGuard endpoints on failure)
cd mini-services/warp-proxy && bun run index.ts &

# 5. start the app
bun run dev            # http://localhost:3000
```

The WARP tunnel needs outbound UDP. On networks that throttle one endpoint, the supervisor rotates through 12 official WARP ports automatically. If the tunnel is unavailable the app degrades gracefully: user proxies (Settings) → direct egress → community proxy providers.

## Cookies (optional, permanent fix)

For hard-flagged networks or age-restricted videos, paste a cookies.txt (Netscape format, exported from a signed-in YouTube session) in **Settings → Network resilience**. Cookies are used by every extraction and job automatically.

## Direct links for download managers

Every format row has a chain-link button that copies a permanent URL:

```
/api/dl?u=<base64url video>&f=<format>&q=<quality>&t=<title>&b=<bitrate>
```

The link re-resolves everything it needs on every hit (cached briefly so an IDM multi-segment swarm shares one minted URL), works hours later and across server restarts, and honors Range/206 for pause/resume.

## Legal

This project is a technical tool. Download only content you have the right to save; respect creators and YouTube's Terms of Service.

## License

MIT
