#!/usr/bin/env python3
"""Auralis — local music player server."""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import re
import secrets
import socket
import time
import unicodedata
from urllib.parse import quote, urlencode
from urllib.request import Request as UrlRequest, urlopen
from pathlib import Path

from fastapi import Depends, FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel, Field
from sqlalchemy import select
from starlette.middleware.sessions import SessionMiddleware

import auth
from db import Favorite, Playlist, PlaylistTrack, SessionLocal, TrackRecord
from library import Library

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
STATIC_DIR = ROOT / "static"
SECRET_KEY_PATH = DATA_DIR / ".secret_key"


def _load_or_create_secret_key() -> str:
    """Persist a random session-signing key across restarts.

    Prefers the AURALIS_SECRET_KEY env var (set this in production so the
    key isn't just a file sitting next to the app). Falls back to a
    generated key stored under data/ for local/dev use.
    """
    env_key = os.environ.get("AURALIS_SECRET_KEY")
    if env_key:
        return env_key
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if SECRET_KEY_PATH.is_file():
        return SECRET_KEY_PATH.read_text(encoding="utf-8").strip()
    key = secrets.token_hex(32)
    SECRET_KEY_PATH.write_text(key, encoding="utf-8")
    try:
        os.chmod(SECRET_KEY_PATH, 0o600)
    except OSError:
        pass
    return key


app = FastAPI(title="Auralis", version="1.0")
# Provisional until startup reads the DB; must exist so /register never AttributeErrors
# if a request somehow arrives before the startup hook finishes.
app.state.is_first_account = True
app.add_middleware(
    SessionMiddleware,
    secret_key=_load_or_create_secret_key(),
    session_cookie="auralis_session",
    same_site="lax",
    https_only=os.environ.get("AURALIS_HTTPS_ONLY", "0") == "1",
    max_age=60 * 60 * 24 * 30,  # 30 days
)
templates = Jinja2Templates(directory=str(ROOT / "templates"))
user_store = auth.UserStore()
login_throttle = auth.LoginThrottle()
MAX_UPLOAD_BYTES = 500 * 1024 * 1024

_libraries: dict[str, Library] = {}
_artist_photo_cache: dict[str, tuple[float, str | None]] = {}
_artist_profile_cache: dict[str, tuple[float, dict[str, str] | None]] = {}


def _artist_search_key(name: str) -> str:
    """Normalize names before comparing a public catalog search result."""
    normalized = unicodedata.normalize("NFKD", name)
    normalized = "".join(c for c in normalized if not unicodedata.combining(c))
    return "".join(c.lower() for c in normalized if c.isalnum())


def _artist_name_candidates(name: str) -> list[str]:
    """Return catalog lookup candidates for an artist credit.

    Downloaded music commonly stores collaborations in one tag
    (``Kendrick Lamar, SZA``, ``Tommy Bueno/Snail Lake``,
    ``… feat. Celeste Sanazi``). Catalogs store those performers separately,
    so try each individual credit. Duo/band names that only use ``&`` /
    ``and`` (e.g. ``Strings & Heart``) are kept intact.
    """
    full_name = name.strip()
    if not full_name:
        return []

    has_list_sep = re.search(
        r"[,;/]|\bfeat(?:uring)?\.?\b|\bft\.?\b|\bwith\b",
        full_name,
        flags=re.IGNORECASE,
    )
    if has_list_sep:
        parts = re.split(
            r"\s*(?:,|;|/|\bfeat(?:uring)?\.?\b|\bft\.?\b|\bwith\b)\s*",
            full_name,
            flags=re.IGNORECASE,
        )
        parts = [
            piece
            for part in parts
            for piece in re.split(r"\s+(?:&|and)\s+", part, flags=re.IGNORECASE)
        ]
    else:
        parts = [full_name]

    candidates: list[str] = []
    seen: set[str] = set()
    for part in parts:
        cleaned = part.strip(" \t-–—·•")
        cleaned = re.sub(r"\s+", " ", cleaned).strip()
        if not cleaned:
            continue
        key = _artist_search_key(cleaned)
        if key in seen:
            continue
        seen.add(key)
        candidates.append(cleaned)
    return candidates


# These entries are deliberately small.  General music catalogs are useful for
# discovery, but an exact name match is not enough to establish an artist's
# identity (especially for short, stylised, or shared names).  Each profile
# below was checked against the artist's own site or artist-managed profile and
# is used before a catalog lookup.  Do not add an entry without a source that
# unambiguously identifies the performer.
_VERIFIED_ARTIST_PROFILES: dict[str, dict[str, str]] = {
    "morada": {
        "bio": (
            "MORADA is a Brazilian contemporary Christian band formed in 2009 "
            "in Fernandópolis, São Paulo."
        ),
        "genre": "Contemporary Christian music",
        "formed_year": "2009",
        "website": "https://www.youtube.com/watch?v=ePdRgBWhvog",
        "website_label": "Official music video",
        "source": "MORADA artist biography",
        "source_url": "https://jairproducoes.com.br/morada",
    },
    "marcosnui": {
        "bio": (
            "Marcos Nui is the artist behind the 2024 single Mi Tiempo and "
            "other Spanish-language releases."
        ),
        "website": "https://music.apple.com/us/artist/marcos-nui/1686270730",
        "website_label": "Artist profile",
        "source": "Marcos Nui artist profile",
        "source_url": "https://music.apple.com/us/artist/marcos-nui/1686270730",
    },
    "tommybueno": {
        "bio": (
            "Tommy Bueno is a Buenos Aires–based artist whose catalog includes "
            "the releases Visionario and Atmósfera."
        ),
        "website": "https://linktr.ee/tommybueno",
        "website_label": "Official artist page",
        "source": "Tommy Bueno official artist page",
        "source_url": "https://linktr.ee/tommybueno",
    },
    "visionofleo": {
        "bio": (
            "Vision of Leo is a Pop artist whose 2023 album Legacy of Faith "
            "was released through Vision of Leo Records."
        ),
        "genre": "Pop",
        "label": "Vision of Leo Records",
        "website": "https://music.apple.com/us/artist/vision-of-leo/1461686609",
        "website_label": "Artist profile",
        "source": "Vision of Leo release page",
        "source_url": "https://music.apple.com/us/album/legacy-of-faith/1688293569",
    },
    "obros": {
        "bio": (
            "O'Bros are a German Christian hip-hop duo from Munich. Their "
            "music brings hip-hop together with Christian faith."
        ),
        "genre": "Christian hip-hop",
        "website": "https://obros.eu/presse/",
        "website_label": "Official artist site",
        "source": "O'Bros official artist site",
        "source_url": "https://obros.eu/presse/",
    },
    "kallysmashupcast": {
        "bio": (
            "KALLY'S Mashup Cast is the credited ensemble for music from "
            "Nickelodeon's KALLY'S Mashup television series."
        ),
        "website": "https://www.youtube.com/watch?v=SRQdCfYQJAU",
        "website_label": "Official music video",
        "source": "KALLY'S Mashup official artist channel",
        "source_url": "https://www.youtube.com/watch?v=SRQdCfYQJAU",
    },
    "viclucas": {
        "bio": (
            "Vic Lucas is an Afrobeat artist whose music draws on Nigerian, "
            "South African, and U.S. influences, with faith and gratitude at "
            "its core."
        ),
        "genre": "Afrobeat",
        "website": "https://www.viclucas.com/",
        "website_label": "Official artist site",
        "source": "Vic Lucas official artist site and artist profile",
        "source_url": "https://www.viclucas.com/",
    },
    "kaimalachi": {
        "bio": (
            "Kai Malachi is a cinematic gospel, soul, and alternative R&B "
            "project created, produced, and directed by Tim Vishnevskiy."
        ),
        "genre": "Cinematic gospel, soul, alternative R&B",
        "website": "https://kaimalachi.com/",
        "website_label": "Official artist site",
        "source": "Kai Malachi official artist site and artist profile",
        "source_url": "https://kaimalachi.com/",
    },
    "ajvitanza": {
        "bio": (
            "AJ Vitanza is a pop artist whose official site presents the "
            "nine-track debut EP Plastic Heart."
        ),
        "genre": "Pop",
        "website": "https://ajvitanza.com/",
        "website_label": "Official artist site",
        "source": "AJ Vitanza official artist site",
        "source_url": "https://ajvitanza.com/",
    },
    "mielsanmarcos": {
        "bio": (
            "Miel San Marcos is a Guatemalan Christian band founded in 2000 "
            "by brothers Josh, Luis, and Samy Morales."
        ),
        "genre": "Contemporary Christian music",
        "formed_year": "2000",
        "website": "https://www.mielsanmarcos.org/artist",
        "website_label": "Official artist site",
        "source": "Miel San Marcos official artist site",
        "source_url": "https://www.mielsanmarcos.org/artist",
    },
    "braydentabakian": {
        "bio": (
            "Brayden Tabakian is a singer and drummer based in Missouri whose "
            "work includes Christian music."
        ),
        "genre": "Pop, Christian music",
        "website": "https://open.spotify.com/artist/0wbQ4YBld5MzVAh9lTZlYy",
        "website_label": "Artist profile",
        "source": "Brayden Tabakian artist profile",
        "source_url": "https://open.spotify.com/artist/0wbQ4YBld5MzVAh9lTZlYy",
    },
    "josephobrien": {
        "bio": (
            "Joseph O'Brien is a Nashville-based singer-songwriter. He is a "
            "Gotee Records artist whose music aims to encourage listeners in "
            "their faith."
        ),
        "genre": "Christian music",
        "label": "Gotee Records",
        "website": "https://www.josephobrienmusic.com/",
        "website_label": "Official artist site",
        "source": "Joseph O'Brien official artist site",
        "source_url": "https://www.josephobrienmusic.com/",
    },
    "stringsheart": {
        "bio": (
            "Strings & Heart is an indie Christian band of three brothers: "
            "Angelo, Michael, and Eric Espinosa."
        ),
        "genre": "Indie Christian",
        "website": "https://www.stringsandheart.com/",
        "website_label": "Official artist site",
        "source": "Strings & Heart official artist site",
        "source_url": "https://www.stringsandheart.com/",
    },
    "gio": {
        "bio": (
            "gio. is a Christian pop and hip-hop artist from the outskirts of "
            "Boston. His music is shaped by early exposure to gospel and poetry, "
            "and he aims to bring a modern, creative approach to Christian music."
        ),
        "genre": "Christian pop, hip-hop",
        "website": "https://www.wassupgio.com/about/",
        "website_label": "Official artist site",
        "source": "gio. official artist site",
        "source_url": "https://www.wassupgio.com/about/",
    },
}


def _verified_artist_profile(name: str) -> dict[str, str] | None:
    """Return an identity-checked profile for an artist credit, if available."""
    for candidate in _artist_name_candidates(name):
        profile = _VERIFIED_ARTIST_PROFILES.get(_artist_search_key(candidate))
        if profile:
            result = profile.copy()
            if candidate != name.strip():
                result["lookup_name"] = candidate
            return result
    return None


def _matching_catalog_artist(results: list[dict], candidates: list[str], name_field: str) -> tuple[dict | None, str | None]:
    """Find an exact normalized catalog result for the first safe candidate."""
    for candidate in candidates:
        key = _artist_search_key(candidate)
        for result in results:
            if _artist_search_key(str(result.get(name_field, ""))) == key:
                return result, candidate
    return None, None


def _lookup_artist_photo(name: str) -> str | None:
    """Return a verified public artist portrait, without making the UI wait.

    Deezer's artist search is public and includes artist-owned portrait URLs.
    Requiring an exact normalized name prevents a loose search from showing the
    wrong person. Both hits and misses are cached briefly to avoid repeatedly
    querying the catalog as users move between views.
    """
    key = _artist_search_key(name)
    if not key:
        return None
    now = time.monotonic()
    cached = _artist_photo_cache.get(key)
    if cached and cached[0] > now:
        return cached[1]

    photo: str | None = None
    try:
        for candidate_name in _artist_name_candidates(name):
            query = urlencode({"q": candidate_name, "limit": 5})
            request = UrlRequest(
                f"https://api.deezer.com/search/artist?{query}",
                headers={"User-Agent": "Auralis/1.0"},
            )
            with urlopen(request, timeout=4) as response:  # nosec B310 - fixed HTTPS host
                results = json.load(response).get("data", [])
            result, _ = _matching_catalog_artist(results, [candidate_name], "name")
            if result:
                candidate = result.get("picture_big") or result.get("picture_medium")
                if isinstance(candidate, str) and candidate.startswith("https://"):
                    photo = candidate
                break
    except (OSError, ValueError, json.JSONDecodeError):
        # Being offline must leave the local library fully usable.
        pass

    _artist_photo_cache[key] = (now + 60 * 60 * 24, photo)
    return photo


def _lookup_artist_profile(name: str) -> dict[str, str] | None:
    """Get an inline artist profile from public catalogs.

    AudioDB is preferred because it provides structured artist facts. Wikipedia
    fills the biography when AudioDB has no record or an incomplete one, so the
    artist page remains useful without sending the listener to another site.
    """
    key = _artist_search_key(name)
    if not key:
        return None
    now = time.monotonic()
    cached = _artist_profile_cache.get(key)
    if cached and cached[0] > now:
        return cached[1]

    verified_profile = _verified_artist_profile(name)
    if verified_profile:
        # A profile sourced from the artist or their managed profile has
        # already established identity; do not replace it with a same-name
        # result from an unauthenticated catalog search.
        _artist_profile_cache[key] = (now + 60 * 60 * 24, verified_profile)
        return verified_profile

    profile: dict[str, str] | None = None
    try:
        for candidate_name in _artist_name_candidates(name):
            query = urlencode({"s": candidate_name})
            request = UrlRequest(
                f"https://www.theaudiodb.com/api/v1/json/2/search.php?{query}",
                headers={"User-Agent": "Auralis/1.0"},
            )
            with urlopen(request, timeout=4) as response:  # nosec B310 - fixed HTTPS host
                artists = json.load(response).get("artists") or []
            artist, matched_name = _matching_catalog_artist(artists, [candidate_name], "strArtist")
            if not artist:
                continue
            fields = {
                "bio": artist.get("strBiographyEN") or artist.get("strBiography") or "",
                "genre": artist.get("strGenre") or "",
                "style": artist.get("strStyle") or "",
                "mood": artist.get("strMood") or "",
                "formed_year": artist.get("intFormedYear") or "",
                "followers": artist.get("intFollowers") or "",
                "popularity": artist.get("intPopularity") or "",
                "label": artist.get("strLabel") or "",
                "website": artist.get("strWebsite") or "",
            }
            profile = {field: str(value).strip() for field, value in fields.items() if value}
            if profile:
                profile["source"] = "TheAudioDB"
                profile["source_url"] = "https://www.theaudiodb.com/"
                if matched_name != name.strip():
                    profile["lookup_name"] = matched_name
            website = profile.get("website", "")
            if website and not website.startswith(("http://", "https://")):
                profile["website"] = f"https://{website}"
            break
    except (OSError, ValueError, json.JSONDecodeError):
        pass

    # Wikipedia is a useful fallback for artists missing from AudioDB, and can
    # also supply the biography when the structured record is incomplete.
    if not profile or not profile.get("bio"):
        try:
            # Use the same conservative primary-credit fallback as the catalog
            # lookup.  Trying a collaboration title here would otherwise cache
            # a false miss for a perfectly documented lead performer.
            lookup_name = _artist_name_candidates(name)[-1]
            search_query = urlencode({
                "action": "query",
                "list": "search",
                "srsearch": lookup_name,
                "srnamespace": 0,
                "srlimit": 5,
                "format": "json",
            })
            request = UrlRequest(
                f"https://en.wikipedia.org/w/api.php?{search_query}",
                headers={"User-Agent": "Auralis/1.0 (artist profile)"},
            )
            with urlopen(request, timeout=4) as response:  # nosec B310 - fixed HTTPS host
                search = json.load(response)
            matches = (search.get("query") or {}).get("search") or []
            match = next(
                (
                    result for result in matches
                    if _artist_search_key(str(result.get("title", "")))
                    == _artist_search_key(lookup_name)
                ),
                None,
            )
            if not match:
                raise LookupError("Wikipedia did not return an exact artist match")

            title = quote(str(match["title"]).replace(" ", "_"), safe="()_")
            summary_request = UrlRequest(
                f"https://en.wikipedia.org/api/rest_v1/page/summary/{title}",
                headers={"User-Agent": "Auralis/1.0 (artist profile)"},
            )
            with urlopen(summary_request, timeout=4) as response:  # nosec B310 - fixed HTTPS host
                summary = json.load(response)
            extract = summary.get("extract")
            page_title = str(summary.get("title", "")).strip()
            if isinstance(extract, str) and extract.strip() and page_title:
                profile = profile or {}
                profile.setdefault("bio", extract.strip())
                # A structured AudioDB record may have supplied the tags while
                # Wikipedia supplied the missing biography.  Name both sources
                # instead of attributing the whole card to just one of them.
                if profile.get("source") == "TheAudioDB":
                    profile["source"] = "TheAudioDB and Wikipedia"
                else:
                    profile.setdefault("source", "Wikipedia")
                if lookup_name != name.strip():
                    profile.setdefault("lookup_name", lookup_name)
                page_url = (summary.get("content_urls") or {}).get("desktop", {}).get("page")
                if isinstance(page_url, str) and page_url.startswith("https://"):
                    profile.setdefault("website", page_url)
                    profile["source_url"] = page_url
        except (LookupError, OSError, ValueError, json.JSONDecodeError):
            pass

    # Keep successful profiles for a day, but retry a catalog miss soon. Public
    # catalog records are occasionally incomplete or temporarily unavailable.
    cache_seconds = 60 * 60 * 24 if profile and profile.get("bio") else 10 * 60
    _artist_profile_cache[key] = (now + cache_seconds, profile)
    return profile


def get_library(user_id: str) -> Library:
    """One lightweight, PostgreSQL-backed library facade per account."""
    lib = _libraries.get(user_id)
    if lib is None:
        lib = Library(user_id)
        _libraries[user_id] = lib
    return lib


def current_user_row(request: Request):
    user_id = request.session.get("user_id")
    if not user_id:
        return None
    return user_store.get_by_id(user_id)


class LoginRequired(Exception):
    """Raised by HTML page deps so we can return a real redirect, not JSON."""


@app.exception_handler(LoginRequired)
async def _login_required_handler(request: Request, exc: LoginRequired) -> RedirectResponse:
    del request, exc
    return RedirectResponse("/login", status_code=303)


def require_page_user(request: Request):
    """For HTML page routes: bounce to /login instead of a bare 401."""
    row = current_user_row(request)
    if row is None:
        raise LoginRequired()
    return row


def require_api_user(request: Request):
    """For JSON API routes: a clean 401 the frontend can react to."""
    row = current_user_row(request)
    if row is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return row


def _track_payload(track) -> dict:
    return {
        "id": track.id,
        "title": track.title,
        "artist": track.artist,
        "album": track.album,
        "duration": track.duration,
        "custom_lyrics": track.custom_lyrics,
        "has_cover": track.has_cover,
        "cover_url": f"/api/tracks/{track.id}/cover",
        "stream_url": f"/api/tracks/{track.id}/stream",
    }


@app.on_event("startup")
def startup() -> None:
    app.state.is_first_account = user_store.count() == 0


@app.get("/", response_class=HTMLResponse)
def index(request: Request, user=Depends(require_page_user)) -> HTMLResponse:
    del user
    page = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    page = page.replace("__CSRF_TOKEN__", auth.get_or_create_csrf_token(request))
    return HTMLResponse(
        page,
        headers={"Cache-Control": "no-store"},
    )


# ------------------------------------------------------------------ accounts

@app.get("/login", response_class=HTMLResponse)
def login_form(request: Request) -> HTMLResponse:
    if current_user_row(request) is not None:
        return RedirectResponse("/", status_code=303)
    return templates.TemplateResponse(
        request, "login.html", {"csrf_token": auth.get_or_create_csrf_token(request)}
    )


@app.post("/login")
def login_submit(
    request: Request,
    username: str = Form(...),
    password: str = Form(...),
    csrf_token: str = Form(...),
) -> Response:
    auth.verify_csrf(request, csrf_token)
    ip = auth.client_ip(request)

    def fail(message: str) -> HTMLResponse:
        return templates.TemplateResponse(
            request,
            "login.html",
            {
                "csrf_token": auth.get_or_create_csrf_token(request),
                "error": message,
                "username": username,
            },
            status_code=400,
        )

    if login_throttle.is_locked(ip, username):
        return fail("Too many attempts. Please wait a few minutes and try again.")

    row = user_store.get_by_username(username)
    if row is None or not auth.verify_password(password, row["password_hash"]):
        login_throttle.record_failure(ip, username)
        return fail("Incorrect username or password")

    login_throttle.clear(ip, username)
    request.session.clear()
    request.session["user_id"] = row["id"]
    return RedirectResponse("/", status_code=303)


@app.get("/register", response_class=HTMLResponse)
def register_form(request: Request) -> HTMLResponse:
    if current_user_row(request) is not None:
        return RedirectResponse("/", status_code=303)
    return templates.TemplateResponse(
        request, "register.html", {"csrf_token": auth.get_or_create_csrf_token(request)}
    )


@app.post("/register")
def register_submit(
    request: Request,
    username: str = Form(...),
    password: str = Form(...),
    email: str = Form(""),
    csrf_token: str = Form(...),
) -> Response:
    auth.verify_csrf(request, csrf_token)

    def fail(message: str) -> HTMLResponse:
        return templates.TemplateResponse(
            request,
            "register.html",
            {
                "csrf_token": auth.get_or_create_csrf_token(request),
                "error": message,
                "username": username,
                "email": email,
            },
            status_code=400,
        )

    username_error = auth.validate_username(username)
    if username_error:
        return fail(username_error)
    password_error = auth.validate_password(password)
    if password_error:
        return fail(password_error)

    try:
        new_user = user_store.create_user(username, email or None, password)
    except ValueError as exc:
        return fail(str(exc))

    request.app.state.is_first_account = False

    request.session.clear()
    request.session["user_id"] = new_user["id"]
    return RedirectResponse("/", status_code=303)


@app.post("/logout")
def logout(request: Request, csrf_token: str = Form(...)) -> Response:
    auth.verify_csrf(request, csrf_token)
    request.session.clear()
    return RedirectResponse("/login", status_code=303)


@app.get("/logout")
def logout_get(request: Request) -> Response:
    # A GET must not change authentication state. Keep this route as a
    # compatibility redirect for old bookmarks and links.
    del request
    return RedirectResponse("/login", status_code=303)


@app.get("/api/me")
def api_me(user=Depends(require_api_user)) -> dict:
    return {
        "id": user["id"],
        "username": user["username"],
        "email": user["email"],
        "created_at": user["created_at"],
        "track_count": get_library(user["id"]).count_tracks(),
    }


@app.get("/api/csrf")
def api_csrf(request: Request, user=Depends(require_api_user)) -> dict:
    """SPA fetches this once and sends the token back as X-CSRF-Token on
    any state-changing call (upload, delete, password change)."""
    return {"csrf_token": auth.get_or_create_csrf_token(request)}


class PasswordChangeRequest(BaseModel):
    current_password: str
    new_password: str


class TrackLyricsRequest(BaseModel):
    lyrics: str = Field(..., min_length=1, max_length=200_000)


class PlaylistState(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    name: str = Field(min_length=1, max_length=200)
    trackIds: list[str] = Field(default_factory=list, max_length=10_000)


class LibraryStateRequest(BaseModel):
    favorites: list[str] = Field(default_factory=list, max_length=10_000)
    playlists: list[PlaylistState] = Field(default_factory=list, max_length=1_000)


def _library_state(user_id: str) -> dict:
    with SessionLocal() as session:
        favorites = session.scalars(select(Favorite.track_id).where(Favorite.user_id == user_id)).all()
        playlists = session.scalars(select(Playlist).where(Playlist.user_id == user_id)).all()
        return {"favorites": favorites, "playlists": [
            {"id": playlist.id, "name": playlist.name,
             "trackIds": [item.track_id for item in playlist.tracks]}
            for playlist in playlists
        ]}


def _parse_range_header(range_header: str, size: int) -> tuple[int, int] | None:
    if not range_header or not range_header.startswith("bytes="):
        return None
    spec = range_header[6:].strip()
    if not spec or "," in spec:
        return None
    if spec.startswith("-"):
        suffix = int(spec[1:])
        if suffix <= 0 or suffix > size:
            return None
        return max(0, size - suffix), size - 1
    start_str, _, end_str = spec.partition("-")
    try:
        start = int(start_str)
        end = int(end_str) if end_str else size - 1
    except ValueError:
        return None
    if start < 0 or start >= size:
        return None
    end = min(end, size - 1)
    if end < start:
        return None
    return start, end


@app.post("/api/account/password")
def change_password(
    payload: PasswordChangeRequest,
    request: Request,
    user=Depends(require_api_user),
    _csrf=Depends(auth.verify_api_csrf),
) -> dict:
    if not auth.verify_password(payload.current_password, user["password_hash"]):
        raise HTTPException(status_code=400, detail="Current password is incorrect")
    error = auth.validate_password(payload.new_password)
    if error:
        raise HTTPException(status_code=400, detail=error)
    user_store.update_password(user["id"], auth.hash_password(payload.new_password))
    return {"ok": True}


@app.get("/sw.js")
def service_worker() -> FileResponse:
    """Serve a kill-switch worker so stale registrations can't brick the UI."""
    path = STATIC_DIR / "sw.js"
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Not found")
    return FileResponse(
        path,
        media_type="application/javascript",
        headers={"Cache-Control": "no-store", "Service-Worker-Allowed": "/"},
    )


@app.get("/api/health")
def health(user=Depends(require_api_user)) -> dict:
    return {"ok": True, "tracks": get_library(user["id"]).count_tracks()}


@app.get("/api/library/state")
def get_library_state(user=Depends(require_api_user)) -> dict:
    """Server-backed favorites and playlists, shared across browsers/redeploys."""
    return _library_state(user["id"])


@app.put("/api/library/state")
def save_library_state(
    payload: LibraryStateRequest,
    user=Depends(require_api_user),
    _csrf=Depends(auth.verify_api_csrf),
) -> dict:
    # Accept only tracks belonging to this account; this prevents cross-account
    # playlist references and cleans stale browser IndexedDB entries safely.
    with SessionLocal() as session:
        valid_ids = set(session.scalars(select(TrackRecord.id).where(TrackRecord.user_id == user["id"])).all())
        favorite_ids = list(dict.fromkeys(track_id for track_id in payload.favorites if track_id in valid_ids))
        session.query(Favorite).filter_by(user_id=user["id"]).delete()
        session.add_all(Favorite(user_id=user["id"], track_id=track_id) for track_id in favorite_ids)
        existing = {playlist.id: playlist for playlist in session.scalars(select(Playlist).where(Playlist.user_id == user["id"])).all()}
        requested = set()
        for item in payload.playlists:
            if item.id in requested:
                continue
            requested.add(item.id)
            playlist = existing.pop(item.id, None)
            if playlist is None:
                playlist = Playlist(id=item.id, user_id=user["id"], name=item.name.strip())
                session.add(playlist)
            else:
                playlist.name = item.name.strip()
                playlist.tracks.clear()
            ids = list(dict.fromkeys(track_id for track_id in item.trackIds if track_id in valid_ids))
            playlist.tracks = [PlaylistTrack(track_id=track_id, position=index) for index, track_id in enumerate(ids)]
        for playlist in existing.values():
            session.delete(playlist)
        session.commit()
    return _library_state(user["id"])


@app.get("/api/artists/photo")
def artist_photo(
    name: str = Query(min_length=1, max_length=200), user=Depends(require_api_user)
) -> dict:
    """Find an artist portrait for the Artists view, if the public catalog has one."""
    del user  # The dependency keeps this account-scoped endpoint private.
    return {"url": _lookup_artist_photo(name.strip())}


@app.get("/api/artists/profile")
def artist_profile(
    name: str = Query(min_length=1, max_length=200), user=Depends(require_api_user)
) -> dict:
    """Return public artist metadata for the detail page, when available."""
    del user  # The dependency keeps this account-scoped endpoint private.
    return {"profile": _lookup_artist_profile(name.strip())}


@app.get("/api/tracks")
def list_tracks(user=Depends(require_api_user)) -> dict:
    library = get_library(user["id"])
    return {"tracks": [_track_payload(t) for t in library.list_tracks()]}


@app.post("/api/library/upload")
async def upload_track(
    file: UploadFile = File(...), user=Depends(require_api_user), _csrf=Depends(auth.verify_api_csrf)
) -> dict:
    if not file.filename:
        raise HTTPException(status_code=400, detail="Missing filename")
    buffer = bytearray()
    total_bytes = 0
    while chunk := await file.read(1024 * 1024):
        total_bytes += len(chunk)
        if total_bytes > MAX_UPLOAD_BYTES:
            raise HTTPException(status_code=413, detail="Upload exceeds the 500 MB limit")
        buffer.extend(chunk)
    if not buffer:
        raise HTTPException(status_code=400, detail="Empty upload")
    library = get_library(user["id"])
    track = library.add_upload(file.filename, bytes(buffer))
    if track is None:
        raise HTTPException(status_code=400, detail="Could not read uploaded audio file")
    return _track_payload(track)


@app.delete("/api/tracks/{track_id}")
def delete_track(
    track_id: str, user=Depends(require_api_user), _csrf=Depends(auth.verify_api_csrf)
) -> dict:
    library = get_library(user["id"])
    if not library.remove(track_id):
        raise HTTPException(status_code=404, detail="Track not found")
    return {"removed": track_id}


@app.put("/api/tracks/{track_id}/lyrics")
def save_track_lyrics(
    track_id: str,
    payload: TrackLyricsRequest,
    user=Depends(require_api_user),
    _csrf=Depends(auth.verify_api_csrf),
) -> dict:
    lyrics = payload.lyrics.strip()
    if not lyrics:
        raise HTTPException(status_code=400, detail="Lyrics cannot be empty")
    track = get_library(user["id"]).set_custom_lyrics(track_id, lyrics)
    if track is None:
        raise HTTPException(status_code=404, detail="Track not found")
    return {"custom_lyrics": track.custom_lyrics}


@app.get("/api/tracks/{track_id}/cover")
def track_cover(
    track_id: str, size: int = Query(default=512, ge=64, le=1024), user=Depends(require_api_user)
) -> Response:
    library = get_library(user["id"])
    if library.get(track_id) is None:
        raise HTTPException(status_code=404, detail="Track not found")
    payload = library.cover_jpeg(track_id, size)
    return Response(
        content=payload,
        media_type="image/jpeg",
        headers={
            "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
            "Content-Length": str(len(payload)),
        },
    )


@app.get("/api/tracks/{track_id}/stream")
def track_stream(request: Request, track_id: str, user=Depends(require_api_user)) -> Response:
    library = get_library(user["id"])
    track = library.get(track_id)
    if track is None:
        raise HTTPException(status_code=404, detail="Track not found")

    data, filename = library.audio_bytes(track_id)
    if data is None or filename is None:
        raise HTTPException(status_code=404, detail="Track not found")

    media_type = mimetypes.guess_type(filename)[0] or "audio/mpeg"
    size = len(data)
    range_header = request.headers.get("range")
    if not range_header:
        headers = {
            "Accept-Ranges": "bytes",
            "Content-Length": str(size),
            "Content-Disposition": f'inline; filename="{filename}"',
            "Cache-Control": "private, max-age=3600",
        }
        return Response(content=data, media_type=media_type, headers=headers)

    range_match = _parse_range_header(range_header, size)
    if range_match is None:
        return Response(status_code=416, headers={"Content-Range": f"bytes */{size}", "Accept-Ranges": "bytes"})

    start, end = range_match
    chunk = data[start : end + 1]
    headers = {
        "Accept-Ranges": "bytes",
        "Content-Range": f"bytes {start}-{end}/{size}",
        "Content-Length": str(len(chunk)),
        "Content-Disposition": f'inline; filename="{filename}"',
        "Cache-Control": "private, max-age=3600",
    }
    return Response(content=chunk, status_code=206, media_type=media_type, headers=headers)


@app.get("/api/tracks/{track_id}/tag-head")
def track_tag_head(track_id: str, user=Depends(require_api_user)) -> Response:
    """Return the start of the audio file so the client can parse embedded ID3.

    Lyrics (SYLT/USLT) and the MPEG frame header used for frame-count timestamps
    both live near the start of the file. Serving just that prefix lets the UI
    reuse its existing ID3 parser without downloading the whole track.
    """
    library = get_library(user["id"])
    if library.get(track_id) is None:
        raise HTTPException(status_code=404, detail="Track not found")
    max_bytes = 2 * 1024 * 1024
    data, _ = library.audio_bytes(track_id, max_bytes=max_bytes)
    return Response(
        content=data or b"",
        media_type="application/octet-stream",
        headers={"Cache-Control": "private, max-age=3600"},
    )


if STATIC_DIR.is_dir():
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


def local_ip() -> str:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("8.8.8.8", 80))
            return sock.getsockname()[0]
    except OSError:
        return "127.0.0.1"


def main() -> None:
    import uvicorn

    parser = argparse.ArgumentParser(description="Run Auralis")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()

    print("\n  ♪ Auralis")
    print(f"  http://127.0.0.1:{args.port}")
    print(f"  http://{local_ip()}:{args.port}\n")
    uvicorn.run("server:app", host=args.host, port=args.port)


if __name__ == "__main__":
    main()
