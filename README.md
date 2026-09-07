# Vervfy

A self-hosted music player for the web, built because I wanted a personal music library that actually felt like mine — not something buried inside a streaming app's algorithm.

Upload your own files, organize them into playlists, look up lyrics and artist info, and listen through a player that doesn't feel like an afterthought.

---

## What it does

Vervfy is a small FastAPI backend paired with a vanilla JS frontend — no framework, no build step, just HTML, CSS, and JavaScript doing the work. The idea is simple: you own the files, you own the library, and the whole thing runs on your own machine (or server) if you want it to.

Here's roughly what's in there right now:

**Library**
Drag-and-drop uploads (whole folders, where the browser allows it), automatic metadata reading, album art extraction — and if a track has no cover, one gets generated so your library doesn't look empty. You can search, remove tracks, and stream everything straight from the backend.

**Player**
The basics you'd expect — play/pause, next/previous, seeking, volume, mute — plus a queue system with an "up next" view, shuffle and repeat, a mini player for when you want it out of the way, and keyboard shortcuts for everything (see below).

**Organization**
Favorite tracks, build playlists, and keep it all sorted per user. Libraries are kept fully separate between accounts.

**Lyrics**
This ended up being one of the more involved parts. Vervfy checks embedded ID3 lyrics first (plain and synced), then LRC files, then falls back to an online lookup through LRCLIB if nothing's found locally. Lyrics scroll in sync with playback and highlight the current line. If none of that turns anything up, you can just paste or type lyrics in yourself.

**Visualizer**
A Web Audio API–based visualizer that reacts to whatever's currently playing.

**Accounts**
Its own auth system — registration, login/logout, bcrypt-hashed passwords, session-based auth, CSRF protection, and basic login throttling so it's not trivial to brute-force. Every user gets their own isolated library.

**Artist info**
When available, Vervfy pulls in extra context about the artist you're listening to — bio, genre, mood, formation year, followers, label, that sort of thing — from public catalogs, and caches it so it's not hitting external APIs on every page load.

**As a web app**
It's built to feel like an app, not a website: responsive on both desktop and mobile, a mini player, offline-friendly bits via a service worker and IndexedDB, and full keyboard navigation.

---

## Stack

**Backend** — Python, FastAPI, Uvicorn, SQLAlchemy, PostgreSQL (Supabase), Alembic, bcrypt, Starlette sessions, Jinja2, python-multipart

**Audio/media** — Mutagen for metadata and ID3 handling, Pillow for artwork

**Frontend** — HTML5, CSS3, vanilla JS, Web Audio API, IndexedDB, Service Worker — no framework required

---

## Project layout

```text
vervfy/
├── auth.py            # accounts, sessions, CSRF, throttling
├── library.py         # tracks, metadata, artwork, lyrics storage
├── server.py           # the FastAPI app itself — routes, streaming, uploads
├── requirements.txt
│
├── static/
│   ├── index.html
│   ├── app.js
│   ├── styles.css
│   ├── auth.css
│   ├── sw.js
│   └── logo.jpeg
│
├── templates/
│   ├── login.html
│   └── register.html
│
├── data/
│
├── start.sh
├── stop.sh
├── open_app.sh
├── install_launcher.sh
└── README.md
```

`server.py` is the entry point and handles most of the request routing — auth, uploads, streaming, lyrics, artwork, artist lookups. `auth.py` and `library.py` split off the account logic and library logic respectively, mostly so `server.py` doesn't turn into a 2,000-line file.

---

## Getting it running

You'll need Python 3.10+ and a browser. That's really it.

```bash
git clone https://github.com/samvitorsilva/vervfy.git
cd vervfy
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Then just:

```bash
./start.sh
```

That script will set up the virtual environment and install dependencies if it needs to, then start the server and pop the app open in your browser. By default it's running at `http://127.0.0.1:8765`.

To shut it down: `./stop.sh`

If you'd rather run it manually:

```bash
python server.py --port 8765
# or
uvicorn server:app --host 0.0.0.0 --port 8765
```

---

## Persistent data and deployment

Vervfy now stores accounts, bcrypt password hashes, tracks/audio, cover art,
custom lyrics, favorites, and playlists in PostgreSQL. `data/` is only used
for the local-development session-key fallback and is not required on Render.
No database URL or credentials are committed to the repository.

1. Create a Supabase project and copy its PostgreSQL connection string.
2. In Render, set `DATABASE_URL` to that value (use the Supabase pooler URL if
   Render cannot reach the direct host), `AURALIS_SECRET_KEY` to a stable random
   64+ character secret, and `AURALIS_HTTPS_ONLY=1`.
3. Set the Render build command to `pip install -r requirements.txt` and start
   command to `alembic upgrade head && uvicorn server:app --host 0.0.0.0 --port $PORT`.

The migration is idempotent and must run before the app starts. Browser-only
favorites/playlists are imported to PostgreSQL automatically on the user's
first login after deployment. For an existing local server, make a backup and
run `DATABASE_URL='...' python scripts/migrate_local_data.py data`; it copies
legacy users/tracks without deleting or modifying the old SQLite/files.

```text
Supabase PostgreSQL
├── users
├── tracks (audio and cover bytes, metadata, lyrics)
├── favorites
├── playlists
└── playlist_tracks
```

Each account gets its own folder — uploads and covers included. None of it gets shipped off to a third party; the only outside calls Vervfy makes are optional ones, for lyrics lookup and artist info, and playback works fine without them.

**Don't commit these:**

```text
data/users.db
data/.secret_key
data/users/
.env
.venv/
__pycache__/
```

If you're deploying this somewhere public, use real secret management instead of hardcoding anything — environment variables at minimum.

---

## API

A few of the main endpoints, for anyone poking around:

```text
GET    /api/me
GET    /api/csrf
GET    /api/health

GET    /api/tracks
POST   /api/library/upload
DELETE /api/tracks/{track_id}

GET    /api/tracks/{track_id}/stream
GET    /api/tracks/{track_id}/cover

PUT    /api/tracks/{track_id}/lyrics

GET    /api/artists/photo
GET    /api/artists/profile

POST   /api/account/password
```

Anything touching your library or account needs an authenticated session.

---

## Keyboard shortcuts

| Key | Does what |
|---|---|
| `Space` | Play / pause |
| `←` `→` | Seek back / forward |
| `Shift + ←` `→` | Previous / next track |
| `↑` `↓` | Volume up / down |
| `M` | Mute |
| `F` | Favorite the current track |
| `/` | Jump to search |
| `N` | Open mini player |
| `L` | Open lyrics |
| `V` | Open visualizer |
| `Esc` | Close whatever's open |
| `?` | Show this list in-app |

---

## How lyrics get resolved

Vervfy checks sources in this order before giving up and asking you to paste something in manually:

```text
ID3 USLT (plain embedded lyrics)
ID3 SYLT (synced embedded lyrics)
LRC files
Plain text files
LRCLIB (online lookup)
```

Timestamps from LRC/SYLT sources get parsed client-side and matched up against playback as it happens.

---

## Artist info

When Vervfy looks up an artist, it tries to actually match the right one rather than grabbing whatever the first search result is — and caches what it finds so it's not re-fetching on every visit. If nothing solid turns up, it just quietly skips that section instead of blocking playback over it.

---

## What's next

Things I'd like to get to eventually:

- [x] Cloud deployment support (Supabase PostgreSQL + Render)
- [ ] Multi-device sync
- [ ] More metadata providers
- [ ] Smarter playlists
- [ ] Album/artist detail pages
- [ ] Better offline support
- [ ] Installable PWA
- [ ] Wider format support
- [ ] Better library sorting/filtering
- [ ] Some way to share a library publicly

---

Vervfy's an ongoing side project, not a polished product. If something's broken or missing, that's probably just because I haven't gotten to it yet.
