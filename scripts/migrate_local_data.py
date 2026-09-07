#!/usr/bin/env python3
"""Copy the legacy SQLite/file library into DATABASE_URL without deleting it.

Run once from a backup of the old deployment before switching Render. Browser
IndexedDB favorites/playlists import themselves on each user's first login.
"""
from __future__ import annotations
import argparse, io, json, sqlite3, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from PIL import Image
from db import SessionLocal, User, TrackRecord

def cover_bytes(path: Path, title: str) -> bytes:
    cover = path / "covers"
    # The caller supplies a track-specific stem through its title only as a
    # fallback; a missing legacy cover is represented by a small placeholder.
    image = Image.new("RGB", (1, 1), (20, 24, 34)); out = io.BytesIO(); image.save(out, "JPEG"); return out.getvalue()

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("legacy_data_dir", type=Path, help="old data/ directory")
    args = parser.parse_args(); root = args.legacy_data_dir
    conn = sqlite3.connect(root / "users.db"); conn.row_factory = sqlite3.Row
    with SessionLocal() as session:
        for user in conn.execute("SELECT id, username, email, password_hash, created_at FROM users"):
            if not session.get(User, user["id"]):
                session.add(User(id=user["id"], username=user["username"], username_key=user["username"].lower(), email=user["email"], password_hash=user["password_hash"], created_at=user["created_at"]))
        session.commit()
        for user in conn.execute("SELECT id FROM users"):
            library = root / "users" / user["id"] / "library.json"
            if not library.is_file(): continue
            for track in json.loads(library.read_text()).get("tracks", []):
                audio = Path(track["path"])
                if not audio.is_file() or session.get(TrackRecord, {"id": track["id"], "user_id": user["id"]}): continue
                cover = root / "users" / user["id"] / "covers" / f'{track["id"]}.jpg'
                data = cover.read_bytes() if cover.is_file() else cover_bytes(root, track.get("title", ""))
                session.add(TrackRecord(id=track["id"], user_id=user["id"], filename=audio.name, title=track["title"], artist=track["artist"], album=track["album"], duration=track["duration"], has_cover=track.get("has_cover", False), custom_lyrics=track.get("custom_lyrics"), audio_data=audio.read_bytes(), cover_data=data))
        session.commit()
    print("Migration complete. Legacy files and SQLite database were not changed.")

if __name__ == "__main__": main()
