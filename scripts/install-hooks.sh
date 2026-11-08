#!/usr/bin/env bash
# Install the local git hooks (pre-commit quality gate).
# Run once after cloning: bash scripts/install-hooks.sh
set -euo pipefail
cd "$(dirname "$0")/.."
chmod +x scripts/quality-gate.sh .githooks/pre-commit
git config core.hooksPath .githooks
echo "hooks installed: pre-commit now runs scripts/quality-gate.sh"
