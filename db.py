"""Database models and session setup for Vervfy.

DATABASE_URL is deliberately the only database configuration point.  Supabase
provides a normal PostgreSQL connection URL; SQLAlchemy also accepts a SQLite
URL in tests without changing application code.
"""
from __future__ import annotations

import os
from sqlalchemy import Boolean, Float, ForeignKey, Integer, LargeBinary, String, Text, UniqueConstraint, create_engine
from sqlalchemy.engine import URL
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship, sessionmaker


def database_url() -> str:
    value = os.environ.get("DATABASE_URL", "").strip()
    if not value:
        raise RuntimeError("DATABASE_URL must be set (use your Supabase PostgreSQL connection string).")
    # Render/Supabase URLs are sometimes supplied with the legacy postgres:// scheme.
    if value.startswith("postgres://"):
        value = "postgresql+psycopg://" + value[len("postgres://"):]
    elif value.startswith("postgresql://"):
        value = "postgresql+psycopg://" + value[len("postgresql://"):]
    return value


DATABASE_URL = database_url()
engine = create_engine(DATABASE_URL, pool_pre_ping=True)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    username: Mapped[str] = mapped_column(String(32), nullable=False, unique=True)
    username_key: Mapped[str] = mapped_column(String(32), nullable=False, unique=True, index=True)
    email: Mapped[str | None] = mapped_column(String(320), unique=True)
    password_hash: Mapped[str] = mapped_column(String(128), nullable=False)
    created_at: Mapped[float] = mapped_column(Float, nullable=False)

    # Preserve the existing route code's sqlite.Row-style access.
    def __getitem__(self, key: str):
        return getattr(self, key)


class TrackRecord(Base):
    __tablename__ = "tracks"
    __table_args__ = (UniqueConstraint("user_id", "id", name="uq_tracks_user_id_id"),)
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    filename: Mapped[str] = mapped_column(String(512), nullable=False)
    title: Mapped[str] = mapped_column(String(512), nullable=False)
    artist: Mapped[str] = mapped_column(String(512), nullable=False)
    album: Mapped[str] = mapped_column(String(512), nullable=False)
    duration: Mapped[float] = mapped_column(Float, nullable=False, default=0)
    has_cover: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    custom_lyrics: Mapped[str | None] = mapped_column(Text)
    audio_data: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    cover_data: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)


class Favorite(Base):
    __tablename__ = "favorites"
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    track_id: Mapped[str] = mapped_column(String(64), primary_key=True)


class Playlist(Base):
    __tablename__ = "playlists"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    tracks: Mapped[list["PlaylistTrack"]] = relationship(cascade="all, delete-orphan", order_by="PlaylistTrack.position")


class PlaylistTrack(Base):
    __tablename__ = "playlist_tracks"
    playlist_id: Mapped[str] = mapped_column(ForeignKey("playlists.id", ondelete="CASCADE"), primary_key=True)
    track_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    position: Mapped[int] = mapped_column(Integer, nullable=False)
