"""PostgreSQL-backed music library; no durable data is written to disk."""
from __future__ import annotations
import hashlib, io, os, tempfile
from dataclasses import dataclass
from PIL import Image, ImageDraw, ImageFont
from sqlalchemy import func, select
from sqlalchemy.orm import load_only
from db import SessionLocal, TrackRecord
try:
    from mutagen import File as MutagenFile
    from mutagen.id3 import APIC, ID3
    from mutagen.mp3 import MP3
    MUTAGEN_AVAILABLE = True
except ImportError: MUTAGEN_AVAILABLE = False

AUDIO_EXTENSIONS = {".mp3", ".m4a", ".mp4", ".aac", ".flac", ".ogg", ".oga", ".opus", ".wav", ".weba"}
@dataclass
class Track:
    id: str; filename: str; title: str; artist: str; album: str; duration: float; has_cover: bool; custom_lyrics: str | None; audio_data: bytes; cover_data: bytes

def track_id_for_bytes(data: bytes) -> str:
    size, chunk = len(data), 65536; digest = hashlib.sha1(str(size).encode()); digest.update(data[:chunk])
    if size > chunk: digest.update(data[-chunk:])
    return digest.hexdigest()[:16]

def make_placeholder_cover(title: str, size: int = 512) -> Image.Image:
    seed = sum(map(ord, title)) or 1; image = Image.new("RGB", (size, size), ((seed*47)%180, 55, 90)); draw = ImageDraw.Draw(image)
    try: font = ImageFont.truetype("DejaVuSans-Bold.ttf", int(size*.42))
    except Exception: font = ImageFont.load_default()
    letter = (title.strip()[:1] or "?").upper(); box = draw.textbbox((0, 0), letter, font=font)
    draw.text((size/2-(box[2]-box[0])/2, size/2-(box[3]-box[1])/2), letter, font=font, fill=(220, 245, 245)); return image

def _parse_filename(filename: str):
    stem = os.path.splitext(os.path.basename(filename))[0]
    if " - " in stem:
        artist, title = (x.strip() for x in stem.split(" - ", 1))
        if artist and title: return title, artist
    return stem, "Unknown Artist"

class Library:
    def __init__(self, user_id: str): self.user_id = user_id

    @staticmethod
    def _track(row: TrackRecord, include_audio: bool = False, include_cover: bool = False) -> Track:
        return Track(
            row.id,
            row.filename,
            row.title,
            row.artist,
            row.album,
            row.duration,
            row.has_cover,
            row.custom_lyrics,
            bytes(row.audio_data) if include_audio and row.audio_data is not None else b"",
            bytes(row.cover_data) if include_cover and row.cover_data is not None else b"",
        )

    def list_tracks(self):
        with SessionLocal() as s:
            selected = [
                TrackRecord.id,
                TrackRecord.filename,
                TrackRecord.title,
                TrackRecord.artist,
                TrackRecord.album,
                TrackRecord.duration,
                TrackRecord.has_cover,
                TrackRecord.custom_lyrics,
            ]
            rows = s.scalars(select(TrackRecord).options(load_only(*selected)).where(TrackRecord.user_id == self.user_id)).all()
            return sorted((self._track(r) for r in rows), key=lambda t: (t.artist.lower(), t.title.lower()))

    def get(self, track_id: str, include_audio: bool = False, include_cover: bool = False):
        with SessionLocal() as s:
            selected = [
                TrackRecord.id,
                TrackRecord.filename,
                TrackRecord.title,
                TrackRecord.artist,
                TrackRecord.album,
                TrackRecord.duration,
                TrackRecord.has_cover,
                TrackRecord.custom_lyrics,
            ]
            if include_audio:
                selected.append(TrackRecord.audio_data)
            if include_cover:
                selected.append(TrackRecord.cover_data)
            row = s.scalar(select(TrackRecord).options(load_only(*selected)).where(TrackRecord.id == track_id, TrackRecord.user_id == self.user_id))
            return self._track(row, include_audio=include_audio, include_cover=include_cover) if row else None

    def count_tracks(self) -> int:
        with SessionLocal() as s:
            return s.scalar(select(func.count()).select_from(TrackRecord).where(TrackRecord.user_id == self.user_id)) or 0

    def set_custom_lyrics(self, track_id: str, lyrics: str):
        with SessionLocal() as s:
            row = s.get(TrackRecord, {"id": track_id, "user_id": self.user_id})
            if not row:
                return None
            row.custom_lyrics = lyrics
            s.commit()
            return self._track(row)

    def add_upload(self, filename: str, data: bytes):
        safe=os.path.basename(filename.replace("\\","/")).replace("\x00","") or "upload.mp3"
        if os.path.splitext(safe)[1].lower() not in AUDIO_EXTENSIONS:return None
        track_id=track_id_for_bytes(data)
        with SessionLocal() as s:
            old=s.get(TrackRecord,{"id":track_id,"user_id":self.user_id})
            if old:return self._track(old)
        meta=self._read_metadata(safe,data)
        if not meta:return None
        title,artist,album,duration,cover,has_cover=meta; output=io.BytesIO();cover.save(output,format="JPEG",quality=90)
        row=TrackRecord(id=track_id,user_id=self.user_id,filename=safe,title=title,artist=artist,album=album,duration=duration,has_cover=has_cover,audio_data=data,cover_data=output.getvalue())
        with SessionLocal() as s:s.add(row);s.commit();return self._track(row)

    def remove(self, track_id: str):
        from db import Favorite, PlaylistTrack
        with SessionLocal() as s:
            row=s.get(TrackRecord,{"id":track_id,"user_id":self.user_id})
            if not row:return False
            s.delete(row);s.query(Favorite).filter_by(user_id=self.user_id,track_id=track_id).delete();s.query(PlaylistTrack).filter_by(track_id=track_id).delete();s.commit();return True

    def cover_bytes(self, track_id: str):
        with SessionLocal() as s:
            row = s.execute(
                select(TrackRecord.cover_data).where(TrackRecord.id == track_id, TrackRecord.user_id == self.user_id)
            ).scalar_one_or_none()
            return bytes(row) if row is not None else b""

    def cover_jpeg(self, track_id: str, size: int=512):
        cover_data = self.cover_bytes(track_id)
        if not cover_data:
            return b""
        image=Image.open(io.BytesIO(cover_data)).convert("RGB").resize((size,size),Image.LANCZOS);out=io.BytesIO();image.save(out,format="JPEG",quality=90);return out.getvalue()

    def audio_bytes(self, track_id: str, max_bytes: int | None = None):
        with SessionLocal() as s:
            row = s.execute(
                select(TrackRecord.audio_data, TrackRecord.filename).where(
                    TrackRecord.id == track_id,
                    TrackRecord.user_id == self.user_id,
                )
            ).one_or_none()
            if row is None:
                return None, None
            data, filename = row
            if max_bytes is not None:
                data = data[:max_bytes]
            return bytes(data), filename
    def _read_metadata(self, filename, data):
        title,artist=_parse_filename(filename);album="Unknown Album";duration=0.;cover=make_placeholder_cover(title);has_cover=False
        with tempfile.NamedTemporaryFile(suffix=os.path.splitext(filename)[1],delete=False) as f:path=f.name;f.write(data)
        try:
            if MUTAGEN_AVAILABLE:
                try:
                    audio=MutagenFile(path,easy=True)
                    if audio is None:return None
                    duration=float(getattr(getattr(audio,"info",None),"length",0) or 0);tags=getattr(audio,"tags",None) or {}
                    if tags.get("title"):title=str(tags["title"][0])
                    if tags.get("artist"):artist=str(tags["artist"][0])
                    if tags.get("album"):album=str(tags["album"][0])
                except Exception:return None
                if path.lower().endswith(".mp3"):
                    try:
                        audio=MP3(path);duration=float(audio.info.length or duration)
                        for tag in ID3(path).values():
                            if isinstance(tag,APIC) and tag.data:cover=Image.open(io.BytesIO(tag.data)).convert("RGB");has_cover=True;break
                    except Exception:pass
            return title,artist,album,duration,cover,has_cover
        finally:
            try:os.unlink(path)
            except OSError:pass
