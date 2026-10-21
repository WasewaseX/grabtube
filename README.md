# GrabTube

**Fast, resumable YouTube downloader for the web.** Every quality and codec, audio-only extraction, IDM-compatible direct links, and a multi-layer anti-bot engine built for hostile networks.

![stack](https://img.shields.io/badge/Next.js%2016-App%20Router-black) ![ts](https://img.shields.io/badge/TypeScript-strict-blue) ![license](https://img.shields.io/badge/license-MIT-green)

## Why GrabTube

Most web downloaders die on three things: verification walls, mid-download failures on slow connections, and links that external download managers cannot touch. GrabTube is engineered against all three:

| Problem | GrabTube answer |
| --- | --- |
| *"Sign in to confirm you're not a bot"* | Multi-layer engine: bgutil PO-token provider (self-healing deno service), player-client failover chain, proxy rotation with health quarantine, and cookie support |
| Mid-download failures / slow networks | yt-dlp with 20 retries, 20 fragment retries, linear backoff, parallel fragments, `--continue` resume; failed jobs restart with one click and keep partial files |
| IDM / aria2 / wget compatibility | Direct links served with `Accept-Ranges`, HTTP `206 Partial Content`, byte-exact `Content-Range`, UTF-8 `Content-Disposition` — multi-threaded resumable downloads verified by SHA-256 |

## Features

- Analyze any YouTube URL (watch / youtu.be / shorts / embed / live)
- Video: 8K → 360p, codecs **H.264 / VP9 / AV1** (availability detected per video), containers MP4 / WebM / MKV
- Audio-only: **M4A, MP3, Opus, FLAC, WAV** (ffmpeg conversion server-side)
- Live progress: percentage, speed, ETA, pipeline stage (resolving → downloading → merging → converting)
- Job history with retry / cancel / delete; interrupted jobs are detected after restarts
- Settings: cookies, proxy rotation list, client order, parallel fragments, retry rounds, PO-token toggle
- Health dashboard in the header: yt-dlp, ffmpeg, deno, PO-token provider status
- Hydration-safe, responsive, dark UI (Next.js 16 App Router, shadcn/ui, Tailwind 4)

## Architecture

```
Browser ── Next.js App Router
             ├─ POST /api/analyze     → yt-dlp -J with strategy matrix
             ├─ POST /api/download    → job queue (SQLite via Prisma)
             ├─ GET  /api/jobs[/id]   → progress polling, cancel/retry
             ├─ GET  /api/file/[id]   → resumable file server (IDM-ready)
             ├─ GET  /api/settings    → cookies/proxies/options
             ├─ GET  /api/health      → toolchain status
             └─ POST /api/stress      → internal stress-test harness
                       │
             ┌─────────┴──────────┐
        yt-dlp engine        deno PO-token provider (port 4416)
        (retry, resume,      bgutil-ytdlp-pot-provider, supervised
         strategy rotation)  and auto-revived by the Next.js process
                       │
                  ffmpeg (merges, audio conversion, metadata)
```

The download engine (`src/lib/engine.ts`) rotates `(player client × proxy)` strategies with exponential backoff, quarantines proxies that trigger bot checks, writes throttled progress to SQLite, and recovers interrupted jobs on boot.

## Quickstart

Requirements: Node/Bun runtime, Python 3 with pip, ffmpeg, deno.

```bash
# 1. install project dependencies
bun install            # or: npm install

# 2. install external toolchain (yt-dlp, deno, PO-token provider; checks ffmpeg)
./scripts/setup-tools.sh

# 3. database
bun run db:push

# 4. run
bun run dev            # http://localhost:3000
```

### YouTube cookies (recommended)

Datacenter IPs are heavily flagged by YouTube; cookies are the most reliable bypass:

1. Install a browser extension like **Get cookies.txt LOCALLY**
2. Log in to YouTube (a throwaway account is recommended)
3. Export `cookies.txt` (Netscape format)
4. In GrabTube: **Settings → YouTube cookies** → paste the full file contents → Save

The badge switches to `ACTIVE`; every analyze/download now carries your cookies. Add residential proxies in the same dialog for a second layer.

### Downloading with IDM / aria2 / wget

When a job completes, press **Direct link** to copy a stable URL, then:

```bash
idm /a /d <link>             # IDM
aria2c -x16 -s16 -c <link>   # aria2, 16 connections, resume
wget -c <link>               # wget resume
```

Links support byte-range resume; interrupted transfers continue from where they stopped.

## Configuration

Environment (see `.env.example`):

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | SQLite file location |

Runtime settings (stored in DB, edited in-app): cookies, proxy list, player-client order, parallel fragments (1–16), retry rounds (1–6), PO-token provider toggle.

## Legal

This project is a self-hosted technical tool. Respect YouTube's Terms of Service and applicable copyright law: download only content you own, that is licensed permissively (e.g. CC), or that you have permission to save. Redistribution of copyrighted material remains your responsibility. The authors take no position on third-party platform policy changes; features may stop working if platforms change.

## License

[MIT](LICENSE)
