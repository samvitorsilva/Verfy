# Auralis

Local music player built from `auralis.html`, with a small Python server that **saves songs you add**.

## Run

```bash
./start.sh
```

Opens at http://127.0.0.1:8765. Stop with `./stop.sh`.

One-time app menu install:

```bash
./install_launcher.sh
```

## Layout

- `static/` — UI (`index.html`, `styles.css`, `app.js`) split from `auralis.html`
- `server.py` / `library.py` — local API; uploads land in `data/uploads/`
- `data/library.json` — saved track index

## Add music

Use **Add music**, drag-and-drop, or **Add folder**. Files are copied into `data/uploads/` and reload automatically next launch.
