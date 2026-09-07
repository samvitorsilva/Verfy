#!/usr/bin/env bash
set -euo pipefail
URL="${1:-http://127.0.0.1:8765}"
try() {
  if command -v "$1" >/dev/null 2>&1; then
    shift
    "$@" >/dev/null 2>&1 &
    return 0
  fi
  return 1
}
try google-chrome-stable google-chrome-stable --app="$URL" --window-size=1180,820 \
  || try google-chrome google-chrome --app="$URL" --window-size=1180,820 \
  || try chromium chromium --app="$URL" --window-size=1180,820 \
  || try brave brave --app="$URL" --window-size=1180,820 \
  || { command -v xdg-open >/dev/null && xdg-open "$URL" >/dev/null 2>&1 & }
