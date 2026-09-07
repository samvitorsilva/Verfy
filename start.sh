#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

PORT=8765
PIDFILE="$DIR/.auralis.pid"
LOGFILE="$DIR/.auralis.log"
VENV="$DIR/.venv"
URL="http://127.0.0.1:${PORT}"

if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "Auralis is already running — opening it."
  "$DIR/open_app.sh" "$URL" &
  exit 0
fi

if [ ! -d "$VENV" ]; then
  echo "Setting up Auralis…"
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install --quiet --upgrade pip
  "$VENV/bin/pip" install --quiet -r "$DIR/requirements.txt"
fi

nohup "$VENV/bin/python" "$DIR/server.py" --port "$PORT" > "$LOGFILE" 2>&1 &
echo $! > "$PIDFILE"

for _ in $(seq 1 40); do
  if curl -s -o /dev/null "$URL/api/health"; then
    break
  fi
  sleep 0.25
done

"$DIR/open_app.sh" "$URL" &
echo "Auralis is running at $URL"
