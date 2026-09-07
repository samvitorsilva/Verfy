"""Accounts: SQLite user store, password hashing, sessions, CSRF, login throttling."""

from __future__ import annotations

import re
import secrets
import sqlite3
import time
import uuid
from pathlib import Path

import bcrypt
from fastapi import HTTPException, Request

USERNAME_RE = re.compile(r"^[a-zA-Z0-9_.-]{3,32}$")


# ---------------------------------------------------------------- user store

class UserStore:
    """Tiny SQLite-backed user table. One row per account."""

    def __init__(self, db_path: str):
        self.db_path = db_path
        Path(db_path).parent.mkdir(parents=True, exist_ok=True)
        with self._conn() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS users (
                    id TEXT PRIMARY KEY,
                    username TEXT UNIQUE COLLATE NOCASE NOT NULL,
                    email TEXT UNIQUE,
                    password_hash TEXT NOT NULL,
                    created_at REAL NOT NULL
                )
                """
            )
            # Older databases predate the case-insensitive column collation.
            # The index applies the same rule without requiring a table rebuild.
            conn.execute(
                "CREATE UNIQUE INDEX IF NOT EXISTS users_username_nocase "
                "ON users(username COLLATE NOCASE)"
            )

    def _conn(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def create_user(self, username: str, email: str | None, password: str) -> dict:
        user_id = uuid.uuid4().hex
        password_hash = hash_password(password)
        # SQLite UNIQUE treats NULL as distinct but "" as a real value — blank
        # emails would otherwise collide on the second account that skips email.
        if email is not None:
            email = email.strip() or None
        with self._conn() as conn:
            try:
                conn.execute(
                    "INSERT INTO users (id, username, email, password_hash, created_at) "
                    "VALUES (?, ?, ?, ?, ?)",
                    (user_id, username, email, password_hash, time.time()),
                )
            except sqlite3.IntegrityError as exc:
                raise ValueError("That username or email is already taken") from exc
        return {"id": user_id, "username": username, "email": email}

    def get_by_username(self, username: str) -> sqlite3.Row | None:
        with self._conn() as conn:
            return conn.execute(
                "SELECT * FROM users WHERE username = ? COLLATE NOCASE", (username,)
            ).fetchone()

    def get_by_id(self, user_id: str) -> sqlite3.Row | None:
        with self._conn() as conn:
            return conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()

    def update_password(self, user_id: str, new_password_hash: str) -> None:
        with self._conn() as conn:
            conn.execute(
                "UPDATE users SET password_hash = ? WHERE id = ?", (new_password_hash, user_id)
            )

    def count(self) -> int:
        with self._conn() as conn:
            return conn.execute("SELECT COUNT(*) AS c FROM users").fetchone()["c"]


# ---------------------------------------------------------- password hashing

def hash_password(password: str) -> str:
    # bcrypt truncates >72 bytes silently; reject early instead of surprising
    # a user whose password 73+ bytes in effectively collapses to fewer chars.
    if len(password.encode("utf-8")) > 72:
        raise ValueError("Password is too long (max 72 bytes)")
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt(rounds=12)).decode("utf-8")


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode("utf-8"), password_hash.encode("utf-8"))
    except (ValueError, TypeError):
        return False


def validate_username(username: str) -> str | None:
    if not USERNAME_RE.match(username or ""):
        return "Username must be 3-32 characters: letters, numbers, _ . -"
    return None


def validate_password(password: str) -> str | None:
    if not password or len(password) < 8:
        return "Password must be at least 8 characters"
    if len(password.encode("utf-8")) > 72:
        return "Password must be under 72 bytes"
    return None


# ------------------------------------------------------------- login throttle

class LoginThrottle:
    """Basic in-memory brute-force guard: N failures -> temporary lockout per key.

    Keyed by (client IP, username) so one abusive IP can't lock out everyone,
    and one targeted username can't be hammered from many IPs unnoticed.
    In-memory is fine for a single-process deploy; swap for Redis if you
    ever run multiple workers.
    """

    MAX_ATTEMPTS = 5
    WINDOW_SECONDS = 15 * 60

    def __init__(self):
        self._failures: dict[str, list[float]] = {}

    def _key(self, ip: str, username: str) -> str:
        return f"{ip}:{username.lower()}"

    def is_locked(self, ip: str, username: str) -> bool:
        key = self._key(ip, username)
        now = time.time()
        attempts = [t for t in self._failures.get(key, []) if now - t < self.WINDOW_SECONDS]
        self._failures[key] = attempts
        return len(attempts) >= self.MAX_ATTEMPTS

    def record_failure(self, ip: str, username: str) -> None:
        key = self._key(ip, username)
        self._failures.setdefault(key, []).append(time.time())

    def clear(self, ip: str, username: str) -> None:
        self._failures.pop(self._key(ip, username), None)


# ------------------------------------------------------------------------ CSRF

def get_or_create_csrf_token(request: Request) -> str:
    token = request.session.get("csrf_token")
    if not token:
        token = secrets.token_urlsafe(32)
        request.session["csrf_token"] = token
    return token


def verify_csrf(request: Request, submitted_token: str) -> None:
    expected = request.session.get("csrf_token")
    if not expected or not submitted_token or not secrets.compare_digest(expected, submitted_token):
        raise HTTPException(status_code=403, detail="Invalid or expired form submission, please retry")


def verify_api_csrf(request: Request) -> None:
    """Same check as verify_csrf, but reads the token from a header
    (X-CSRF-Token) instead of a form field — for JSON fetch() calls from
    the SPA rather than <form> submissions."""
    verify_csrf(request, request.headers.get("x-csrf-token", ""))


# --------------------------------------------------------------------- misc

def client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"
