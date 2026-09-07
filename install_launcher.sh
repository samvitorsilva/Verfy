#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
chmod +x "$DIR/start.sh" "$DIR/stop.sh" "$DIR/open_app.sh"

APPS_DIR="$HOME/.local/share/applications"
mkdir -p "$APPS_DIR"
DESKTOP_FILE="$APPS_DIR/auralis.desktop"

cat > "$DESKTOP_FILE" << EOF
[Desktop Entry]
Version=1.0
Type=Application
Name=Auralis
Comment=Local music player that saves your library
Exec=$DIR/start.sh
Path=$DIR
Icon=audio-x-generic
Terminal=false
StartupNotify=true
Categories=AudioVideo;Audio;Player;
Keywords=music;player;mp3;lyrics;
EOF

chmod +x "$DESKTOP_FILE"
update-desktop-database "$APPS_DIR" 2>/dev/null || true
echo "Installed launcher: $DESKTOP_FILE"
echo "Project: $DIR"
