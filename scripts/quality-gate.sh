#!/usr/bin/env bash
# GrabTube local quality gate — the local mirror of master-ci (profile: strict).
# Runs the same gate families CI enforces, in fast local form:
#   1. ESLint (node-lint)
#   2. TypeScript --noEmit (node-lint)
#   3. Shellcheck on *.sh (hygiene)
#   4. Ruff on *.py (python)
#   5. Secret-pattern guard on the working tree (secrets)
#   6. Editorconfig basics: final newline, no trailing whitespace in *.ts/*.sh
# Exit non-zero on any gate failure. CI runs the full 100+ check suite;
# this script is the cheap pre-commit prevention layer.
set -uo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
fail=0

step() { printf '\n\033[1;36m[gate]\033[0m %s\n' "$1"; }
ok()   { printf '\033[1;32m  ok\033[0m %s\n' "$1"; }
bad()  { printf '\033[1;31m  FAIL\033[0m %s\n' "$1"; fail=1; }

# 1 ── ESLint ─────────────────────────────────────────────────────────────────
step "ESLint"
if bun run lint >/tmp/gate-eslint.log 2>&1; then ok "eslint clean"; else
  bad "eslint findings"; tail -20 /tmp/gate-eslint.log; fi

# 2 ── TypeScript ─────────────────────────────────────────────────────────────
step "TypeScript --noEmit"
if bunx tsc --noEmit >/tmp/gate-tsc.log 2>&1; then ok "types clean"; else
  bad "type errors"; tail -30 /tmp/gate-tsc.log; fi

# 3 ── Shellcheck ─────────────────────────────────────────────────────────────
step "Shellcheck"
if command -v shellcheck >/dev/null 2>&1; then
  sh_ok=1
  while IFS= read -r f; do
    shellcheck -S error "$f" || sh_ok=0
  done < <(rg --files -g '*.sh' -g '!node_modules' -g '!tools' -g '!downloads')
  [ "$sh_ok" = 1 ] && ok "shell scripts clean" || bad "shellcheck findings"
else
  ok "shellcheck not installed locally — CI enforces it"
fi

# 4 ── Ruff (python) ──────────────────────────────────────────────────────────
step "Ruff"
if command -v ruff >/dev/null 2>&1; then
  if ruff check scripts/ >/tmp/gate-ruff.log 2>&1; then ok "python clean"; else
    bad "ruff findings"; cat /tmp/gate-ruff.log; fi
else
  ok "ruff not installed locally — CI enforces it"
fi

# 5 ── Secret-pattern guard (working tree, untracked included) ────────────────
step "Secret-pattern guard"
# Patterns mirror gitleaks' high-signal rules. .env.example placeholders and
# the GitHub PAT env var are excluded by design.
sec_ok=1
while IFS= read -r f; do
  if rg -n --no-heading \
      -e 'ghp_[A-Za-z0-9]{36}' \
      -e 'github_pat_[A-Za-z0-9_]{60,}' \
      -e 'sk-[A-Za-z0-9]{32,}' \
      -e 'AKIA[0-9A-Z]{16}' \
      -e '-----BEGIN (RSA|EC|OPENSSH|PRIVATE) KEY-----' \
      "$f" >/tmp/gate-sec.log 2>&1; then
    bad "secret-like pattern in $f"; cat /tmp/gate-sec.log; sec_ok=0
  fi
done < <(rg --files -g '!node_modules' -g '!.next' -g '!tools' -g '!downloads' -g '!db' -g '!.env.example' -g '!package-lock.json' -g '!bun.lock')
[ "$sec_ok" = 1 ] && ok "no secret-like patterns" || true

# 6 ── Editorconfig basics ────────────────────────────────────────────────────
step "Editorconfig basics (ts/sh/js/mjs)"
ec_ok=1
while IFS= read -r f; do
  # final newline
  [ -n "$(tail -c 1 "$f")" ] && { bad "missing final newline: $f"; ec_ok=0; }
  # trailing whitespace (excluding tabs-as-indent Makefiles, not applicable)
  if rg -n '[ \t]+$' "$f" >/tmp/gate-ec.log 2>&1; then
    bad "trailing whitespace: $f"; head -3 /tmp/gate-ec.log; ec_ok=0
  fi
done < <(rg --files -g '*.ts' -g '*.tsx' -g '*.sh' -g '*.mjs' -g '!node_modules' -g '!.next' -g '!tools')
[ "$ec_ok" = 1 ] && ok "editorconfig basics clean" || true

printf '\n'
if [ "$fail" = 1 ]; then
  printf '\033[1;31mQUALITY GATE: FAILED\033[0m — fix findings above before committing.\n'
  exit 1
fi
printf '\033[1;32mQUALITY GATE: PASSED\033[0m — all local gates green.\n'
