"""Local music library — saves uploads and metadata under data/."""

from __future__ import annotations

import hashlib
import io
import json
import os
import tempfile
from dataclasses import asdict, dataclass
from typing import Any

from PIL import Image, ImageDraw, ImageFont

try:
    from mutagen import File as MutagenFile
    from mutagen.id3 import APIC, ID3
    from mutagen.mp3 import MP3

    MUTAGEN_AVAILABLE = True
except ImportError:
    MUTAGEN_AVAILABLE = False

AUDIO_EXTENSIONS = {".mp3", ".m4a", ".mp4", ".aac", ".flac", ".ogg", ".oga", ".opus", ".wav", ".weba"}


@dataclass
class Track:
    id: str
    path: str
    title: str
    artist: str
    album: str
    duration: float
    has_cover: bool = False
    custom_lyrics: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def track_id_for_path(path: str) -> str:
    """Stable, content-based track ID.

    Deliberately NOT based on the absolute filesystem path: that breaks every
    single track's ID (and therefore every favorite and playlist membership,
    which the frontend keys by ID in IndexedDB) as soon as the app folder is
    moved, restored from a backup/zip, or run under a different username or
    home directory — even though the audio file itself didn't change at all.

    Instead we fingerprint the file's own bytes: its size plus a hash of its
    first and last chunks. This is stable across moves/renames/relocations
    (the whole point), fast even for large files (reads only a couple of
    small chunks instead of the whole file), and still distinguishes
    different tracks reliably in practice.
    """
    chunk_size = 65536
    size = os.path.getsize(path)
    digest = hashlib.sha1()
    digest.update(str(size).encode("utf-8"))
    with open(path, "rb") as handle:
        digest.update(handle.read(chunk_size))
        if size > chunk_size:
            # Seek to the true last `chunk_size` bytes (may overlap the head
            # chunk for files under 2x chunk_size — that's fine, it just
            # means small files hash the same bytes twice; what matters is
            # that this always matches track_id_for_bytes() below for
            # identical content, so add_upload() can dedupe before writing.
            handle.seek(max(size - chunk_size, 0))
            digest.update(handle.read(chunk_size))
    return digest.hexdigest()[:16]


def track_id_for_bytes(data: bytes) -> str:
    """Same fingerprint as track_id_for_path, computed from in-memory bytes.

    Lets add_upload() recognize "this exact audio is already in the library"
    BEFORE writing a new copy to disk, instead of writing a redundant file
    and only discovering the ID collision afterwards.
    """
    chunk_size = 65536
    size = len(data)
    digest = hashlib.sha1()
    digest.update(str(size).encode("utf-8"))
    digest.update(data[:chunk_size])
    if size > chunk_size:
        digest.update(data[-chunk_size:])
    return digest.hexdigest()[:16]


def _hsl_to_rgb(h: float, s: float, l: float) -> tuple[int, int, int]:
    s, l = s / 100.0, l / 100.0
    c = (1 - abs(2 * l - 1)) * s
    x = c * (1 - abs((h / 60) % 2 - 1))
    m = l - c / 2
    if h < 60:
        r, g, b = c, x, 0
    elif h < 120:
        r, g, b = x, c, 0
    elif h < 180:
        r, g, b = 0, c, x
    elif h < 240:
        r, g, b = 0, x, c
    elif h < 300:
        r, g, b = x, 0, c
    else:
        r, g, b = c, 0, x
    return tuple(int((v + m) * 255) for v in (r, g, b))


def make_placeholder_cover(title: str, size: int = 512) -> Image.Image:
    seed = sum(ord(c) for c in title) or 1
    hues = [(seed * 47 + i * 73) % 360 for i in range(3)]
    colors = [_hsl_to_rgb(h, 45 + (seed % 25), 28 + (h % 18)) for h in hues]
    img = Image.new("RGB", (size, size), colors[0])
    draw = ImageDraw.Draw(img)
    for y in range(size):
        t = y / max(size - 1, 1)
        rgb = tuple(int(colors[0][i] * (1 - t) + colors[1][i] * t) for i in range(3))
        draw.line([(0, y), (size, y)], fill=rgb)
    letter = (title.strip()[:1] or "?").upper()
    try:
        font = ImageFont.truetype("DejaVuSans-Bold.ttf", int(size * 0.42))
    except Exception:
        font = ImageFont.load_default()
    bbox = draw.textbbox((0, 0), letter, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    draw.text(
        (size / 2 - tw / 2 - bbox[0], size / 2 - th / 2 - bbox[1]),
        letter,
        font=font,
        fill=colors[2],
    )
    return img


def _parse_filename(path: str) -> tuple[str, str]:
    stem = os.path.splitext(os.path.basename(path))[0]
    if " - " in stem:
        artist, title = stem.split(" - ", 1)
        artist, title = artist.strip(), title.strip()
        if artist and title:
            return title, artist
    return stem, "Unknown Artist"


def _crop_square(img: Image.Image) -> Image.Image:
    w, h = img.size
    side = min(w, h)
    left = (w - side) // 2
    top = (h - side) // 2
    return img.crop((left, top, left + side, top + side))


class Library:
    def __init__(self, data_dir: str):
        self.data_dir = data_dir
        self.covers_dir = os.path.join(data_dir, "covers")
        self.index_path = os.path.join(data_dir, "library.json")
        os.makedirs(self.covers_dir, exist_ok=True)
        os.makedirs(os.path.join(data_dir, "uploads"), exist_ok=True)
        self.tracks: dict[str, Track] = {}
        self._load()

    def _load(self) -> None:
        # Prefer index, then rescanning uploads so files survive a wiped index.
        if os.path.isfile(self.index_path):
            try:
                with open(self.index_path, encoding="utf-8") as handle:
                    payload = json.load(handle)
                for item in payload.get("tracks", []):
                    try:
                        track = Track(**item)
                    except (TypeError, ValueError):
                        # A single stale or manually edited entry should not
                        # hide every later valid track in the library index.
                        continue
                    if os.path.isfile(track.path):
                        self.tracks[track.id] = track
            except (json.JSONDecodeError, OSError, TypeError):
                pass
        uploads = os.path.join(self.data_dir, "uploads")
        if os.path.isdir(uploads):
            for name in sorted(os.listdir(uploads)):
                path = os.path.join(uploads, name)
                if os.path.isfile(path) and os.path.splitext(name)[1].lower() in AUDIO_EXTENSIONS:
                    tid = track_id_for_path(path)
                    if tid not in self.tracks:
                        self.load_track(path)
        if self.tracks:
            self.save()

    def save(self) -> None:
        payload = {"tracks": [t.to_dict() for t in self.tracks.values()]}
        # Replace the index atomically so an interrupted write cannot leave a
        # partially written JSON file that loses an entire user's library.
        fd, temporary_path = tempfile.mkstemp(
            prefix=".library-", suffix=".json", dir=self.data_dir, text=True
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(payload, handle, indent=2)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary_path, self.index_path)
        except Exception:
            try:
                os.unlink(temporary_path)
            except OSError:
                pass
            raise

    def list_tracks(self) -> list[Track]:
        return sorted(self.tracks.values(), key=lambda t: (t.artist.lower(), t.title.lower()))

    def get(self, track_id: str) -> Track | None:
        return self.tracks.get(track_id)

    def set_custom_lyrics(self, track_id: str, lyrics: str) -> Track | None:
        track = self.tracks.get(track_id)
        if track is None:
            return None
        track.custom_lyrics = lyrics
        self.save()
        return track

    def add_upload(self, filename: str, data: bytes) -> Track | None:
        # Check for "this exact audio is already in the library" BEFORE
        # writing anything to disk. Track IDs are content fingerprints (see
        # track_id_for_path), so re-adding a file whose bytes we already
        # have — same song imported twice, a folder re-added after a
        # restore, etc. — would otherwise silently write a redundant copy
        # to data/uploads/ and orphan the original entry once the new
        # upload's identical ID overwrote it in the index.
        existing = self.tracks.get(track_id_for_bytes(data))
        if existing is not None:
            return existing
        uploads_dir = os.path.join(self.data_dir, "uploads")
        os.makedirs(uploads_dir, exist_ok=True)
        # Browsers normally provide a basename, but normalize both POSIX and
        # Windows separators before treating an upload name as a local path.
        safe = os.path.basename(filename.replace("\\", "/")).replace("\x00", "") or "upload.mp3"
        ext = os.path.splitext(safe)[1].lower()
        if ext not in AUDIO_EXTENSIONS:
            return None
        destination = os.path.join(uploads_dir, safe)
        base, ext = os.path.splitext(destination)
        n = 1
        while os.path.exists(destination):
            destination = f"{base}_{n}{ext}"
            n += 1
        with open(destination, "wb") as handle:
            handle.write(data)
        if not self._is_readable_audio(destination):
            try:
                os.remove(destination)
            except OSError:
                pass
            return None
        track = self.load_track(destination)
        if track:
            self.save()
        return track

    def _is_readable_audio(self, path: str) -> bool:
        """Reject corrupt payloads mutagen can't parse (e.g. renamed text files).

        Mutagen returns ``None`` for unrecognized formats instead of raising, so a
        bare truthy check on "did it throw?" would happily accept garbage uploads
        with a plausible extension (``.ogg``, ``.wav``, …).
        """
        if not MUTAGEN_AVAILABLE:
            return True
        try:
            return MutagenFile(path) is not None
        except Exception:
            return False

    def load_track(self, path: str) -> Track | None:
        path = os.path.abspath(path)
        if not os.path.isfile(path):
            return None
        track_id = track_id_for_path(path)
        title, artist, album, duration, cover, has_cover = self._read_metadata(path)
        track = Track(
            id=track_id,
            path=path,
            title=title,
            artist=artist,
            album=album,
            duration=duration,
            has_cover=has_cover,
        )
        self.tracks[track_id] = track
        cover_path = os.path.join(self.covers_dir, f"{track_id}.jpg")
        cover.save(cover_path, format="JPEG", quality=90)
        return track

    def remove(self, track_id: str) -> bool:
        track = self.tracks.pop(track_id, None)
        if track is None:
            return False
        cover_path = os.path.join(self.covers_dir, f"{track_id}.jpg")
        if os.path.isfile(cover_path):
            os.remove(cover_path)
        # Only delete files we own inside uploads/
        uploads = os.path.abspath(os.path.join(self.data_dir, "uploads"))
        if os.path.abspath(track.path).startswith(uploads + os.sep) and os.path.isfile(track.path):
            os.remove(track.path)
        self.save()
        return True

    def cover_jpeg(self, track_id: str, size: int = 512) -> bytes:
        track = self.tracks.get(track_id)
        cover_path = os.path.join(self.covers_dir, f"{track_id}.jpg")
        if os.path.isfile(cover_path):
            img = Image.open(cover_path).convert("RGB")
        elif track:
            _, _, _, _, img, _ = self._read_metadata(track.path)
            img.save(cover_path, format="JPEG", quality=90)
        else:
            img = make_placeholder_cover("Auralis")
        if size:
            img = img.resize((size, size), Image.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=90)
        return buf.getvalue()

    def _read_metadata(self, path: str) -> tuple[str, str, str, float, Image.Image, bool]:
        title, artist = _parse_filename(path)
        album = "Unknown Album"
        duration = 0.0
        has_cover = False
        cover = make_placeholder_cover(title)

        if not MUTAGEN_AVAILABLE:
            return title, artist, album, duration, cover, has_cover

        try:
            audio = MutagenFile(path, easy=True)
            if audio is not None:
                info = getattr(audio, "info", None)
                if info is not None and getattr(info, "length", None):
                    duration = float(info.length or 0)
                tags = getattr(audio, "tags", None) or {}
                if tags.get("title"):
                    title = str(tags["title"][0])
                if tags.get("artist"):
                    artist = str(tags["artist"][0])
                if tags.get("album"):
                    album = str(tags["album"][0])
        except Exception:
            pass

        try:
            if path.lower().endswith(".mp3"):
                audio = MP3(path)
                duration = float(audio.info.length or 0) or duration
                tags = ID3(path)
                if "TIT2" in tags and tags["TIT2"].text:
                    title = str(tags["TIT2"].text[0])
                if "TPE1" in tags and tags["TPE1"].text:
                    artist = str(tags["TPE1"].text[0])
                if "TALB" in tags and tags["TALB"].text:
                    album = str(tags["TALB"].text[0])
                for tag in tags.values():
                    if isinstance(tag, APIC) and tag.data:
                        cover = _crop_square(Image.open(io.BytesIO(tag.data)).convert("RGB"))
                        has_cover = True
                        break
        except Exception:
            pass

        if not has_cover:
            try:
                audio = MutagenFile(path)
                pictures = getattr(audio, "pictures", None) or []
                if pictures and pictures[0].data:
                    cover = _crop_square(Image.open(io.BytesIO(pictures[0].data)).convert("RGB"))
                    has_cover = True
            except Exception:
                pass

        if not has_cover:
            cover = make_placeholder_cover(title)
        return title, artist, album, duration, cover, has_cover
