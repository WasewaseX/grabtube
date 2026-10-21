#!/usr/bin/env bash
# GrabTube toolchain installer — reproducible setup for yt-dlp, deno and the
# bgutil PO-token provider.
#
# Everything is installed INSIDE the project (./tools) so it survives
# home-directory resets. Idempotent: safe to re-run at any time.
set -euo pipefail

YELLOW='\033[1;33m'; GREEN='\033[0;32m'; RED='\033[0;31m'; NC='\033[0m'
ok()   { echo -e "${GREEN}[ok]${NC} $1"; }
warn() { echo -e "${YELLOW}[..]${NC} $1"; }
fail() { echo -e "${RED}[FAIL]${NC} $1"; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TOOLS="$ROOT/tools"
mkdir -p "$TOOLS"

# ---------------------------------------------------------------- ffmpeg
if command -v ffmpeg >/dev/null 2>&1; then
  ok "ffmpeg $(ffmpeg -version | head -1 | awk '{print $3}') (system)"
else
  warn "ffmpeg not found — installing via apt (sudo)..."
  sudo apt-get update -qq && sudo apt-get install -y -qq ffmpeg
  ok "ffmpeg installed"
fi

# ---------------------------------------------------------------- yt-dlp
# find any usable python3 (system, PATH, or common venv locations)
PY="$(command -v python3 || true)"
[ -z "$PY" ] && for c in /usr/bin/python3 /home/z/.venv/bin/python3 "$HOME/.venv/bin/python3"; do
  [ -x "$c" ] && PY="$c" && break
done
if [ -z "$PY" ]; then
  fail "python3 required but not found"; exit 1
fi

if [ -x "$TOOLS/venv/bin/yt-dlp" ]; then
  ok "yt-dlp $("$TOOLS/venv/bin/yt-dlp" --version) (project-local)"
else
  warn "installing yt-dlp into $TOOLS/venv ..."
  [ -x "$TOOLS/venv/bin/python3" ] || "$PY" -m venv "$TOOLS/venv"
  "$TOOLS/venv/bin/pip" install -q -U pip
  "$TOOLS/venv/bin/pip" install -q -U yt-dlp bgutil-ytdlp-pot-provider
  ok "yt-dlp $("$TOOLS/venv/bin/yt-dlp" --version)"
fi

# ---------------------------------------------------------------- deno
if [ -x "$TOOLS/deno/bin/deno" ]; then
  ok "deno $("$TOOLS/deno/bin/deno" --version | head -1 | awk '{print $2}') (project-local)"
else
  warn "installing deno into $TOOLS/deno ..."
  curl -fsSL https://deno.land/install.sh | DENO_INSTALL="$TOOLS/deno" sh -s -- -y >/dev/null
  ok "deno $("$TOOLS/deno/bin/deno" --version | head -1 | awk '{print $2}')"
fi

# ------------------------------------------------- bgutil PO-token provider
PROVIDER_DIR="$ROOT/mini-services/pot-provider/server"
if [ -f "$PROVIDER_DIR/src/main.ts" ]; then
  ok "bgutil-ytdlp-pot-provider present"
else
  warn "downloading bgutil-ytdlp-pot-provider server..."
  mkdir -p "$ROOT/mini-services"
  curl -sL https://github.com/Brainicism/bgutil-ytdlp-pot-provider/archive/refs/heads/master.tar.gz \
    | tar xz -C "$ROOT/mini-services"
  mv "$ROOT/mini-services/bgutil-ytdlp-pot-provider-master" "$ROOT/mini-services/pot-provider"
  (cd "$PROVIDER_DIR" && "$TOOLS/deno/bin/deno" install -q)
  ok "PO-token provider installed"
fi

# ------------------------------------------------- plugin registration check
if "$TOOLS/venv/bin/yt-dlp" -v --simulate "https://www.youtube.com/watch?v=dQw4w9WgXcQ" 2>&1 \
    | grep -q "pot:bgutil:http.*external"; then
  ok "yt-dlp sees the bgutil PO-token plugin"
else
  warn "bgutil plugin not detected by yt-dlp — run: $TOOLS/venv/bin/pip install -U bgutil-ytdlp-pot-provider"
fi

echo
echo "Toolchain ready (project-local under ./tools — survives home resets)."
echo "The GrabTube app supervises the PO-token server automatically."
