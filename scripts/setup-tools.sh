#!/usr/bin/env bash
# GrabTube toolchain installer — reproducible setup for yt-dlp, deno and the
# bgutil PO-token provider. Safe to re-run (idempotent).
set -euo pipefail

YELLOW='\033[1;33m'; GREEN='\033[0;32m'; RED='\033[0;31m'; NC='\033[0m'
ok()   { echo -e "${GREEN}[ok]${NC} $1"; }
warn() { echo -e "${YELLOW}[..]${NC} $1"; }
fail() { echo -e "${RED}[FAIL]${NC} $1"; }

# ---------------------------------------------------------------- ffmpeg
if command -v ffmpeg >/dev/null 2>&1; then
  ok "ffmpeg $(ffmpeg -version | head -1 | awk '{print $3}')"
else
  warn "ffmpeg not found — installing via apt (sudo)..."
  sudo apt-get update -qq && sudo apt-get install -y -qq ffmpeg
  ok "ffmpeg installed"
fi

# ---------------------------------------------------------------- yt-dlp
PY="$(command -v python3)"
if [ -x "$HOME/.venv/bin/yt-dlp" ]; then
  ok "yt-dlp $("$HOME/.venv/bin/yt-dlp" --version) (venv)"
elif "$PY" -c "import yt_dlp" >/dev/null 2>&1; then
  ok "yt-dlp (python module)"
else
  warn "installing yt-dlp..."
  if [ ! -d "$HOME/.venv" ]; then "$PY" -m venv "$HOME/.venv"; fi
  "$HOME/.venv/bin/pip" install -q -U yt-dlp bgutil-ytdlp-pot-provider
  ok "yt-dlp $("$HOME/.venv/bin/yt-dlp" --version)"
fi

# ---------------------------------------------------------------- deno
if [ -x "$HOME/.deno/bin/deno" ]; then
  ok "deno $("$HOME/.deno/bin/deno" --version | head -1 | awk '{print $2}')"
else
  warn "installing deno..."
  curl -fsSL https://deno.land/install.sh | DENO_INSTALL="$HOME/.deno" sh -s -- -y >/dev/null
  ok "deno $("$HOME/.deno/bin/deno" --version | head -1 | awk '{print $2}')"
fi

# ------------------------------------------------- bgutil PO-token provider
PROVIDER_DIR="$(cd "$(dirname "$0")/.." && pwd)/mini-services/pot-provider/server"
if [ -f "$PROVIDER_DIR/src/main.ts" ]; then
  ok "bgutil-ytdlp-pot-provider present"
else
  warn "downloading bgutil-ytdlp-pot-provider server..."
  ROOT="$(cd "$(dirname "$0")/.." && pwd)"
  mkdir -p "$ROOT/mini-services"
  curl -sL https://github.com/Brainicism/bgutil-ytdlp-pot-provider/archive/refs/heads/master.tar.gz \
    | tar xz -C "$ROOT/mini-services"
  mv "$ROOT/mini-services/bgutil-ytdlp-pot-provider-master" "$ROOT/mini-services/pot-provider"
  (cd "$ROOT/mini-services/pot-provider/server" && "$HOME/.deno/bin/deno" install -q)
  ok "PO-token provider installed"
fi

# ------------------------------------------------- plugin registration check
if [ -x "$HOME/.venv/bin/yt-dlp" ]; then
  if "$HOME/.venv/bin/yt-dlp" -v --simulate "https://www.youtube.com/watch?v=dQw4w9WgXcQ" 2>&1 \
      | grep -q "pot:bgutil:http.*external"; then
    ok "yt-dlp sees the bgutil PO-token plugin"
  else
    warn "bgutil plugin not detected by yt-dlp — run: $HOME/.venv/bin/pip install -U bgutil-ytdlp-pot-provider"
  fi
fi

echo
echo "Toolchain ready. The GrabTube app supervises the PO-token server"
echo "automatically — no manual service start required."
