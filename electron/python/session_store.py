#!/usr/bin/env python3
"""
SessionStore — persistent conversation history for Henry AI.

A self-contained SQLite-backed store for chat sessions with FTS5 full-text
search and per-session token/cost accounting. It powers:

  * Storing & resuming past conversations (sessions)
  * Full-text search across all message history
  * Token + cost tracking per session

Design highlights (adapted, with no external dependencies — Python stdlib only):
  * WAL journal mode for concurrent readers + one writer, with an automatic
    fallback to DELETE mode on filesystems where WAL is unsupported (NFS/SMB/
    some FUSE mounts).
  * FTS5 virtual tables for fast text search. A second ``trigram`` table gives
    correct substring matching for CJK scripts that the default tokenizer
    splits into single characters.
  * Concurrent-write safety via ``BEGIN IMMEDIATE`` plus application-level
    jitter retry, which staggers competing writers and avoids the convoy
    effect SQLite's built-in busy handler can produce.
  * Periodic best-effort WAL checkpoint to keep the WAL file from growing
    unbounded.

It also exposes a small JSON CLI (see ``main()``) so it can be driven as a
subprocess from the Electron main process, or exercised directly from a
terminal for testing.

CLI usage (reads a JSON payload from stdin, writes a JSON result to stdout):

    echo '{"id":"s1","title":"Hello"}' | python session_store.py create --db /tmp/sessions.db
    echo '{"session_id":"s1","role":"user","content":"hi there"}' \
        | python session_store.py add-message --db /tmp/sessions.db
    echo '{"query":"hi"}' | python session_store.py search --db /tmp/sessions.db
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import random
import re
import sqlite3
import sys
import threading
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, TypeVar

try:  # zoneinfo is stdlib on 3.9+
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover - very old runtimes
    ZoneInfo = None  # type: ignore[assignment]

logger = logging.getLogger("henry.session_store")

T = TypeVar("T")


# ===========================================================================
# Secret redaction (stdlib logging only)
# ===========================================================================

class RedactingFormatter(logging.Formatter):
    """Logging formatter that scrubs common secret patterns from log records.

    Adapted to a compact, self-contained form: masks vendor API-key prefixes,
    ``KEY=value`` env assignments, JSON credential fields, Authorization
    headers, JWTs, and private-key blocks before they reach any handler.
    Short tokens are fully masked; longer ones keep a head/tail for
    debuggability.
    """

    _PLACEHOLDER = "***REDACTED***"

    # Known API-key prefixes -> mask the prefix + contiguous token chars.
    _PREFIX_PATTERNS = [
        r"sk-[A-Za-z0-9_-]{10,}",          # OpenAI / Anthropic (sk-ant-*) / OpenRouter
        r"sk_live_[A-Za-z0-9]{10,}",       # Stripe secret key (live)
        r"sk_test_[A-Za-z0-9]{10,}",       # Stripe secret key (test)
        r"rk_live_[A-Za-z0-9]{10,}",       # Stripe restricted key
        r"ghp_[A-Za-z0-9]{10,}",           # GitHub PAT (classic)
        r"github_pat_[A-Za-z0-9_]{10,}",   # GitHub PAT (fine-grained)
        r"gh[ousr]_[A-Za-z0-9]{10,}",      # GitHub OAuth / server / refresh tokens
        r"xox[baprs]-[A-Za-z0-9-]{10,}",   # Slack tokens
        r"AIza[A-Za-z0-9_-]{30,}",         # Google API keys
        r"AKIA[A-Z0-9]{16}",               # AWS Access Key ID
        r"hf_[A-Za-z0-9]{10,}",            # HuggingFace token
        r"npm_[A-Za-z0-9]{10,}",           # npm access token
        r"xai-[A-Za-z0-9]{30,}",           # xAI (Grok) API key
        r"gsk_[A-Za-z0-9]{10,}",           # Groq Cloud API key
    ]
    _PREFIX_RE = re.compile(
        r"(?<![A-Za-z0-9_-])(" + "|".join(_PREFIX_PATTERNS) + r")(?![A-Za-z0-9_-])"
    )

    # KEY=value where KEY looks secret-ish.
    _SECRET_ENV_NAMES = r"(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)"
    _ENV_ASSIGN_RE = re.compile(
        rf"([A-Z0-9_]{{0,50}}{_SECRET_ENV_NAMES}[A-Z0-9_]{{0,50}})\s*=\s*(['\"]?)(\S+)\2"
    )

    # "apiKey": "value", "token": "value", etc.
    _JSON_KEY_NAMES = (
        r"(?:api_?[Kk]ey|token|secret|password|access_token|refresh_token"
        r"|auth_token|bearer)"
    )
    _JSON_FIELD_RE = re.compile(
        rf'("{_JSON_KEY_NAMES}")\s*:\s*"([^"]+)"', re.IGNORECASE
    )

    _AUTH_HEADER_RE = re.compile(r"(Authorization:\s*Bearer\s+)(\S+)", re.IGNORECASE)
    _JWT_RE = re.compile(r"eyJ[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_=-]{4,}){0,2}")
    _PRIVATE_KEY_RE = re.compile(
        r"-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----"
    )

    @classmethod
    def _mask(cls, value: str, *, head: int = 4, tail: int = 4) -> str:
        if not value:
            return value
        if len(value) < head + tail + 4:
            return cls._PLACEHOLDER
        return f"{value[:head]}…{value[-tail:]}"

    @classmethod
    def redact(cls, text: str) -> str:
        if not text:
            return text
        text = cls._PRIVATE_KEY_RE.sub(cls._PLACEHOLDER, text)
        text = cls._PREFIX_RE.sub(lambda m: cls._mask(m.group(1)), text)
        text = cls._JWT_RE.sub(lambda m: cls._mask(m.group(0)), text)
        text = cls._AUTH_HEADER_RE.sub(lambda m: f"{m.group(1)}{cls._PLACEHOLDER}", text)
        text = cls._ENV_ASSIGN_RE.sub(
            lambda m: f"{m.group(1)}={cls._PLACEHOLDER}", text
        )
        text = cls._JSON_FIELD_RE.sub(lambda m: f'{m.group(1)}: "{cls._PLACEHOLDER}"', text)
        return text

    def format(self, record: logging.LogRecord) -> str:
        return self.redact(super().format(record))


def _configure_logging(level: int = logging.INFO) -> None:
    """Attach a RedactingFormatter to a stderr handler (stdout stays clean
    for the JSON protocol)."""
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(
        RedactingFormatter("%(asctime)s %(levelname)s %(name)s: %(message)s")
    )
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(level)


# ===========================================================================
# Local clock (inlined timezone-aware helper)
# ===========================================================================

def local_clock() -> datetime:
    """Return the current time as a timezone-aware datetime.

    Resolution order for the zone:
      1. ``HENRY_TIMEZONE`` environment variable (IANA name, e.g. ``Asia/Tokyo``)
      2. the host's local timezone

    An invalid zone name logs a warning and falls back to local time — the
    store never crashes on a bad timezone string.
    """
    name = os.getenv("HENRY_TIMEZONE", "").strip()
    if name and ZoneInfo is not None:
        try:
            return datetime.now(ZoneInfo(name))
        except Exception as exc:  # noqa: BLE001 - any zoneinfo failure
            logger.warning("Invalid HENRY_TIMEZONE %r: %s; using local time", name, exc)
    return datetime.now().astimezone()


# ===========================================================================
# Message content convention (forward-compatible with the agent layer)
# ===========================================================================
# A message's ``content`` is EITHER a plain string (text-only) OR a list of
# typed "blocks", so one message can represent tool use and agent actions — not
# just text. This is the canonical shape every writer (chat UI, tool runner,
# scheduler, future computer-use layer) should use, so the whole corpus stays
# uniform:
#
#   {"type": "text",        "text": str}
#   {"type": "tool_use",    "id": str, "name": str, "input": dict}
#   {"type": "tool_result", "tool_use_id": str, "content": Any, "is_error": bool}
#   {"type": "image",       "uri"|"artifact_id": str, "alt": str}    # reference, never inline bytes
#   {"type": "action",      "kind": str, "target": str, "params": dict,
#                            "status": str, "duration_ms": int}      # desktop / web / API automation
#   {"type": "observation", "source": str, "data": Any}             # screenshot ref, DOM, API response
#
# The store is permissive — it never rejects an unknown block shape. List/dict
# content is JSON-encoded on write (see SessionStore._encode_content), and a
# flattened, human-readable projection is stored alongside in
# ``messages.content_text`` so FTS indexes the *text* of blocks rather than the
# raw JSON envelope. The matching block-builder helpers live on the TypeScript
# side (electron/ipc/sessionStore.ts) for the agent layer to import.

CONTENT_BLOCK_TYPES = (
    "text", "tool_use", "tool_result", "image", "action", "observation",
)


def _stringify(value: Any) -> str:
    """Compact, searchable string for an arbitrary JSON-ish value."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value, ensure_ascii=False, separators=(" ", " "))
    except (TypeError, ValueError):
        return str(value)


def _block_text(block: Any) -> str:
    """Extract searchable text from a single content block."""
    if not isinstance(block, dict):
        return _stringify(block)
    btype = block.get("type")
    if btype == "text":
        return str(block.get("text") or "")
    if btype == "tool_use":
        return " ".join(filter(None, [
            str(block.get("name") or ""), _stringify(block.get("input")),
        ]))
    if btype == "tool_result":
        return flatten_content_text(block.get("content"))
    if btype == "image":
        return str(block.get("alt") or "")  # uri/artifact_id intentionally not indexed
    if btype == "action":
        return " ".join(filter(None, [
            str(block.get("kind") or ""), str(block.get("target") or ""),
            _stringify(block.get("params")),
        ]))
    if btype == "observation":
        return _stringify(block.get("data"))
    # Unknown/empty block: index whatever text-ish fields it carries.
    return _stringify(block)


def flatten_content_text(content: Any) -> str:
    """Project message content (string or block list) to plain searchable text.

    Populates ``messages.content_text`` so FTS matches the meaningful text of
    tool/action blocks instead of the encoded JSON envelope.
    """
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(t for t in (_block_text(b) for b in content) if t).strip()
    if isinstance(content, dict):
        return _block_text(content)
    return _stringify(content)


# ===========================================================================
# WAL-compatibility fallback
# ===========================================================================
# SQLite's WAL mode needs shared-memory + fcntl byte-range locks that don't
# work reliably on network filesystems (NFS, SMB/CIFS, some FUSE). On those,
# ``PRAGMA journal_mode=WAL`` raises OperationalError("locking protocol"); we
# fall back to DELETE (the pre-WAL default) which works everywhere, at the
# cost of reader/writer concurrency.

_WAL_INCOMPAT_MARKERS = ("locking protocol", "not authorized")
_wal_fallback_warned = False


def apply_wal_with_fallback(conn: sqlite3.Connection) -> str:
    """Set ``journal_mode=WAL``, falling back to DELETE on incompatible FS.

    Returns the journal mode actually set ("wal" or "delete").
    """
    global _wal_fallback_warned
    try:
        current = conn.execute("PRAGMA journal_mode").fetchone()
        if current and str(current[0]).lower() == "wal":
            return "wal"
    except sqlite3.OperationalError:
        pass

    try:
        conn.execute("PRAGMA journal_mode=WAL")
        return "wal"
    except sqlite3.OperationalError as exc:
        if not any(marker in str(exc).lower() for marker in _WAL_INCOMPAT_MARKERS):
            raise
        if not _wal_fallback_warned:
            _wal_fallback_warned = True
            logger.warning(
                "WAL journal_mode unsupported on this filesystem (%s) — falling "
                "back to journal_mode=DELETE (works on NFS/SMB/FUSE, lower "
                "concurrency). See https://www.sqlite.org/wal.html",
                exc,
            )
        conn.execute("PRAGMA journal_mode=DELETE")
        return "delete"


# ===========================================================================
# Schema
# ===========================================================================

SCHEMA_VERSION = 2

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    title TEXT,
    origin TEXT,
    model TEXT,
    model_config TEXT,
    system_prompt TEXT,
    parent_session_id TEXT,
    started_at REAL NOT NULL,
    ended_at REAL,
    end_reason TEXT,
    message_count INTEGER DEFAULT 0,
    tool_call_count INTEGER DEFAULT 0,
    api_call_count INTEGER DEFAULT 0,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cache_read_tokens INTEGER DEFAULT 0,
    cache_write_tokens INTEGER DEFAULT 0,
    reasoning_tokens INTEGER DEFAULT 0,
    estimated_cost_usd REAL,
    actual_cost_usd REAL,
    cost_status TEXT,
    cost_source TEXT,
    pricing_version TEXT,
    cwd TEXT,
    archived INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (parent_session_id) REFERENCES sessions(id)
);

CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    role TEXT NOT NULL,
    kind TEXT,
    content TEXT,
    content_text TEXT,
    tool_call_id TEXT,
    tool_calls TEXT,
    tool_name TEXT,
    timestamp REAL NOT NULL,
    token_count INTEGER,
    finish_reason TEXT,
    reasoning TEXT,
    active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS state_meta (
    key TEXT PRIMARY KEY,
    value TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_messages_session_active
    ON messages(session_id, active, timestamp);
"""

# FTS5 over the inline content || tool_name || tool_calls so a single MATCH
# covers message text and tool activity. Kept in sync with the messages table
# via AFTER INSERT/DELETE/UPDATE triggers.
FTS_SQL = """
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(content);

CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content) VALUES (
        new.id,
        COALESCE(new.content_text, '') || ' ' || COALESCE(new.tool_name, '') || ' ' || COALESCE(new.tool_calls, '')
    );
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages BEGIN
    DELETE FROM messages_fts WHERE rowid = old.id;
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_update AFTER UPDATE ON messages BEGIN
    DELETE FROM messages_fts WHERE rowid = old.id;
    INSERT INTO messages_fts(rowid, content) VALUES (
        new.id,
        COALESCE(new.content_text, '') || ' ' || COALESCE(new.tool_name, '') || ' ' || COALESCE(new.tool_calls, '')
    );
END;
"""

# Trigram FTS5 table for CJK substring search. The default unicode61 tokenizer
# splits CJK characters into single-character tokens, breaking phrase matching;
# the trigram tokenizer creates overlapping 3-byte sequences so substring
# queries work for any script.
FTS_TRIGRAM_SQL = """
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts_trigram USING fts5(
    content,
    tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS messages_fts_trigram_insert AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts_trigram(rowid, content) VALUES (
        new.id,
        COALESCE(new.content_text, '') || ' ' || COALESCE(new.tool_name, '') || ' ' || COALESCE(new.tool_calls, '')
    );
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_trigram_delete AFTER DELETE ON messages BEGIN
    DELETE FROM messages_fts_trigram WHERE rowid = old.id;
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_trigram_update AFTER UPDATE ON messages BEGIN
    DELETE FROM messages_fts_trigram WHERE rowid = old.id;
    INSERT INTO messages_fts_trigram(rowid, content) VALUES (
        new.id,
        COALESCE(new.content_text, '') || ' ' || COALESCE(new.tool_name, '') || ' ' || COALESCE(new.tool_calls, '')
    );
END;
"""

_FTS_TRIGGERS = (
    "messages_fts_insert",
    "messages_fts_delete",
    "messages_fts_update",
    "messages_fts_trigram_insert",
    "messages_fts_trigram_delete",
    "messages_fts_trigram_update",
)


# ===========================================================================
# SessionStore
# ===========================================================================

class SessionStore:
    """SQLite-backed session storage with FTS5 search.

    Thread-safe for the common pattern of multiple reader threads and a single
    writer via WAL mode. Each writing method runs inside ``_execute_write``
    (BEGIN IMMEDIATE + jitter retry); reads take a short lock around the cursor.
    """

    # ── Write-contention tuning ──
    # Keep SQLite's own timeout short and handle retries at the application
    # level with random jitter, which staggers competing writers and avoids
    # the convoy effect of SQLite's deterministic busy-handler backoff.
    _WRITE_MAX_RETRIES = 15
    _WRITE_RETRY_MIN_S = 0.020   # 20ms
    _WRITE_RETRY_MAX_S = 0.150   # 150ms
    _CHECKPOINT_EVERY_N_WRITES = 50

    # sqlite3 can only bind str/bytes/int/float/None. Structured content
    # (multimodal lists, dicts) is JSON-encoded behind this sentinel prefix.
    _CONTENT_JSON_PREFIX = "\x00json:"

    MAX_TITLE_LENGTH = 200

    def __init__(self, db_path: Path, read_only: bool = False):
        self.db_path = Path(db_path)
        self.read_only = read_only
        self._lock = threading.Lock()
        self._write_count = 0
        self._fts_enabled = False
        self._fts_unavailable_warned = False

        if read_only:
            self._conn = sqlite3.connect(
                f"file:{self.db_path}?mode=ro",
                uri=True,
                check_same_thread=False,
                timeout=1.0,
                isolation_level=None,
            )
            self._conn.row_factory = sqlite3.Row
            # Discover whether FTS is usable for read-only search.
            self._fts_enabled = self._fts_table_exists("messages_fts")
            return

        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(
            str(self.db_path),
            check_same_thread=False,
            timeout=1.0,
            # None = we manage transactions explicitly (BEGIN IMMEDIATE).
            isolation_level=None,
        )
        self._conn.row_factory = sqlite3.Row
        apply_wal_with_fallback(self._conn)
        self._conn.execute("PRAGMA foreign_keys=ON")
        self._init_schema()

    # ── FTS5 capability probing ──────────────────────────────────────────

    @staticmethod
    def _is_fts5_unavailable_error(exc: sqlite3.OperationalError) -> bool:
        err = str(exc).lower()
        return "no such module" in err and "fts5" in err

    def _warn_fts5_unavailable(self, exc: sqlite3.OperationalError) -> None:
        self._fts_enabled = False
        if self._fts_unavailable_warned:
            return
        self._fts_unavailable_warned = True
        logger.warning(
            "SQLite FTS5 unavailable; full-text session search disabled "
            "(underlying error: %s)",
            exc,
        )

    def _sqlite_supports_fts5(self, cursor: sqlite3.Cursor) -> bool:
        try:
            cursor.execute("CREATE VIRTUAL TABLE temp._fts5_probe USING fts5(x)")
            cursor.execute("DROP TABLE temp._fts5_probe")
            return True
        except sqlite3.OperationalError as exc:
            if not self._is_fts5_unavailable_error(exc):
                raise
            self._warn_fts5_unavailable(exc)
            return False

    def _fts_table_exists(self, name: str) -> bool:
        try:
            row = self._conn.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
                (name,),
            ).fetchone()
            return row is not None
        except sqlite3.OperationalError:
            return False

    @staticmethod
    def _drop_fts_triggers(cursor: sqlite3.Cursor) -> None:
        for trigger in _FTS_TRIGGERS:
            try:
                cursor.execute(f"DROP TRIGGER IF EXISTS {trigger}")
            except sqlite3.OperationalError:
                pass

    def _ensure_fts_schema(self, cursor: sqlite3.Cursor, ddl: str) -> bool:
        try:
            cursor.executescript(ddl)
            return True
        except sqlite3.OperationalError as exc:
            if not self._is_fts5_unavailable_error(exc):
                raise
            self._warn_fts5_unavailable(exc)
            return False

    # ── Schema init ──────────────────────────────────────────────────────

    # Columns that may be missing on databases created by an earlier schema
    # version. Adding a column is a cheap, backward-compatible ALTER, so new
    # fields land here and are reconciled on every open (Beets/sqlite-utils
    # pattern) — no version-gated migration chain needed for plain additions.
    _EXPECTED_COLUMNS = {
        "sessions": {"origin": "TEXT"},
        "messages": {"kind": "TEXT", "content_text": "TEXT"},
    }

    def _reconcile_columns(self, cursor: sqlite3.Cursor) -> None:
        for table, cols in self._EXPECTED_COLUMNS.items():
            existing = {
                r[1] for r in cursor.execute(f'PRAGMA table_info("{table}")').fetchall()
            }
            for name, decl in cols.items():
                if name not in existing:
                    try:
                        cursor.execute(f"ALTER TABLE {table} ADD COLUMN {name} {decl}")
                    except sqlite3.OperationalError as exc:
                        logger.debug("ADD COLUMN %s.%s skipped: %s", table, name, exc)

    def _backfill_content_text(self, cursor: sqlite3.Cursor) -> None:
        """Populate messages.content_text from existing content (v1→v2).

        When FTS triggers are in place, each UPDATE reindexes that row via the
        AFTER UPDATE trigger, so this doubles as the FTS rebuild.
        """
        rows = cursor.execute(
            "SELECT id, content FROM messages WHERE content_text IS NULL"
        ).fetchall()
        for r in rows:
            text = flatten_content_text(self._decode_content(r["content"]))
            cursor.execute(
                "UPDATE messages SET content_text = ? WHERE id = ?", (text, r["id"])
            )

    def _init_schema(self) -> None:
        cursor = self._conn.cursor()
        cursor.executescript(SCHEMA_SQL)
        # Add any columns missing on a pre-existing database (idempotent).
        self._reconcile_columns(cursor)

        row = cursor.execute("SELECT version FROM schema_version LIMIT 1").fetchone()
        if row is None:
            cursor.execute(
                "INSERT INTO schema_version (version) VALUES (?)", (SCHEMA_VERSION,)
            )
            stored_version = SCHEMA_VERSION
        else:
            stored_version = row["version"] if isinstance(row, sqlite3.Row) else row[0]

        # Unique title index — best effort (titles are optional/nullable).
        try:
            cursor.execute(
                "CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_title_unique "
                "ON sessions(title) WHERE title IS NOT NULL"
            )
        except sqlite3.OperationalError:
            pass

        # v2 switched FTS to index messages.content_text (the flattened block
        # text) instead of the raw content column. On a pre-v2 DB the old
        # triggers reference new.content, so drop them and let the FTS DDL
        # recreate them; the content_text backfill below then reindexes every
        # row through the new AFTER UPDATE trigger.
        needs_fts_migration = stored_version < 2

        if self._sqlite_supports_fts5(cursor):
            if needs_fts_migration:
                self._drop_fts_triggers(cursor)
            self._fts_enabled = self._ensure_fts_schema(cursor, FTS_SQL)
            if self._fts_enabled:
                self._ensure_fts_schema(cursor, FTS_TRIGRAM_SQL)
            if needs_fts_migration:
                self._backfill_content_text(cursor)
        else:
            # Triggers targeting unreadable virtual tables would break message
            # writes — drop them so core persistence keeps working. Still
            # backfill content_text so the column is correct for a future
            # FTS-capable runtime.
            self._drop_fts_triggers(cursor)
            if needs_fts_migration:
                self._backfill_content_text(cursor)

        if stored_version < SCHEMA_VERSION:
            cursor.execute(
                "UPDATE schema_version SET version = ?", (SCHEMA_VERSION,)
            )

        self._conn.commit()

    # ── Core write helper ────────────────────────────────────────────────

    def _execute_write(self, fn: Callable[[sqlite3.Connection], T]) -> T:
        """Run a write transaction with BEGIN IMMEDIATE + jitter retry.

        ``fn`` receives the connection and performs the DML; it must NOT
        commit (handled here). On "database is locked"/"busy" we release the
        Python lock, sleep a random 20-150ms, and retry — breaking the convoy
        pattern of SQLite's deterministic backoff.
        """
        last_err: Optional[Exception] = None
        for attempt in range(self._WRITE_MAX_RETRIES):
            try:
                with self._lock:
                    self._conn.execute("BEGIN IMMEDIATE")
                    try:
                        result = fn(self._conn)
                        self._conn.commit()
                    except BaseException:
                        try:
                            self._conn.rollback()
                        except Exception:
                            pass
                        raise
                self._write_count += 1
                if self._write_count % self._CHECKPOINT_EVERY_N_WRITES == 0:
                    self._try_wal_checkpoint()
                return result
            except sqlite3.OperationalError as exc:
                msg = str(exc).lower()
                if ("locked" in msg or "busy" in msg) and attempt < self._WRITE_MAX_RETRIES - 1:
                    last_err = exc
                    time.sleep(random.uniform(self._WRITE_RETRY_MIN_S, self._WRITE_RETRY_MAX_S))
                    continue
                raise
        raise last_err or sqlite3.OperationalError("database is locked after max retries")

    def _try_wal_checkpoint(self) -> None:
        """Best-effort TRUNCATE WAL checkpoint. Never raises."""
        try:
            with self._lock:
                self._conn.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
        except Exception:
            pass

    def close(self) -> None:
        with self._lock:
            if self._conn:
                try:
                    self._conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
                except Exception:
                    pass
                self._conn.close()
                self._conn = None  # type: ignore[assignment]

    # ── Content (de)serialization ────────────────────────────────────────

    @classmethod
    def _encode_content(cls, content: Any) -> Any:
        """Serialize structured (list/dict) content for sqlite; scalars pass
        through unchanged."""
        if content is None or isinstance(content, (str, bytes, int, float)):
            return content
        try:
            return cls._CONTENT_JSON_PREFIX + json.dumps(content)
        except (TypeError, ValueError):
            return str(content)

    @classmethod
    def _decode_content(cls, content: Any) -> Any:
        """Reverse :meth:`_encode_content`; scalars pass through unchanged."""
        if isinstance(content, str) and content.startswith(cls._CONTENT_JSON_PREFIX):
            try:
                return json.loads(content[len(cls._CONTENT_JSON_PREFIX):])
            except (json.JSONDecodeError, TypeError):
                logger.warning("Failed to decode JSON content; returning raw string")
                return content
        return content

    # =========================================================================
    # Session lifecycle
    # =========================================================================

    def _insert_session_row(
        self,
        session_id: str,
        *,
        title: Optional[str] = None,
        origin: Optional[str] = None,
        model: Optional[str] = None,
        model_config: Optional[Dict[str, Any]] = None,
        system_prompt: Optional[str] = None,
        parent_session_id: Optional[str] = None,
        cwd: Optional[str] = None,
    ) -> None:
        # ``origin`` records what triggered the session — 'chat', 'webhook',
        # 'schedule', 'api', 'automation', etc. Lets the agent layer
        # distinguish a user chat from a routine/webhook-driven run.
        def _do(conn: sqlite3.Connection) -> None:
            conn.execute(
                """INSERT OR IGNORE INTO sessions
                   (id, title, origin, model, model_config, system_prompt,
                    parent_session_id, cwd, started_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    session_id,
                    self.sanitize_title(title),
                    origin,
                    model,
                    json.dumps(model_config) if model_config else None,
                    system_prompt,
                    parent_session_id,
                    cwd,
                    time.time(),
                ),
            )

        self._execute_write(_do)

    def create_session(self, session_id: Optional[str] = None, **kwargs) -> str:
        """Create a new session record. Returns the session id (generated if
        not supplied)."""
        session_id = session_id or uuid.uuid4().hex
        self._insert_session_row(session_id, **kwargs)
        return session_id

    def end_session(self, session_id: str, end_reason: str = "ended") -> None:
        """Mark a session ended. No-op if already ended (first reason wins)."""
        def _do(conn: sqlite3.Connection) -> None:
            conn.execute(
                "UPDATE sessions SET ended_at = ?, end_reason = ? "
                "WHERE id = ? AND ended_at IS NULL",
                (time.time(), end_reason, session_id),
            )

        self._execute_write(_do)

    def reopen_session(self, session_id: str) -> None:
        """Clear ended_at/end_reason so a session can be resumed."""
        def _do(conn: sqlite3.Connection) -> None:
            conn.execute(
                "UPDATE sessions SET ended_at = NULL, end_reason = NULL WHERE id = ?",
                (session_id,),
            )

        self._execute_write(_do)

    def resume_session(self, session_id: str) -> Optional[Dict[str, Any]]:
        """Reopen a session and return it with its full active message history.

        Returns ``None`` if the session id does not exist (after prefix
        resolution).
        """
        resolved = self.resolve_session_id(session_id)
        if not resolved:
            return None
        self.reopen_session(resolved)
        session = self.get_session(resolved)
        if session is None:
            return None
        session["messages"] = self.get_messages(resolved)
        return session

    def branch_session(
        self,
        parent_session_id: str,
        *,
        new_session_id: Optional[str] = None,
        copy_messages: bool = True,
        title: Optional[str] = None,
    ) -> Optional[str]:
        """Fork ``parent_session_id`` into a new child session.

        The parent is marked ended with reason ``branched``; the child carries
        ``parent_session_id`` for lineage. When ``copy_messages`` is true the
        parent's active messages are copied into the child so the conversation
        can continue from the same point. Returns the new session id, or
        ``None`` if the parent does not exist.
        """
        parent = self.get_session(self.resolve_session_id(parent_session_id) or "")
        if parent is None:
            return None
        parent_id = parent["id"]
        child_id = new_session_id or uuid.uuid4().hex

        self.end_session(parent_id, "branched")
        self._insert_session_row(
            child_id,
            title=title,
            model=parent.get("model"),
            system_prompt=parent.get("system_prompt"),
            parent_session_id=parent_id,
            cwd=parent.get("cwd"),
        )
        if parent.get("model_config"):
            self.update_session_meta(child_id, parent["model_config"])
        if copy_messages:
            messages = self.get_messages(parent_id)
            if messages:
                self.replace_messages(child_id, messages)
        return child_id

    def update_session_meta(
        self,
        session_id: str,
        model_config_json: str,
        model: Optional[str] = None,
    ) -> None:
        def _do(conn: sqlite3.Connection) -> None:
            conn.execute(
                "UPDATE sessions SET model_config = ?, model = COALESCE(?, model) WHERE id = ?",
                (model_config_json, model, session_id),
            )

        self._execute_write(_do)

    def update_session_model(self, session_id: str, model: str) -> None:
        def _do(conn: sqlite3.Connection) -> None:
            conn.execute(
                "UPDATE sessions SET model = ? WHERE id = ?", (model, session_id)
            )

        self._execute_write(_do)

    def update_session_cwd(self, session_id: str, cwd: str) -> None:
        if not session_id or not cwd:
            return

        def _do(conn: sqlite3.Connection) -> None:
            conn.execute("UPDATE sessions SET cwd = ? WHERE id = ?", (cwd, session_id))

        self._execute_write(_do)

    def set_session_archived(self, session_id: str, archived: bool) -> bool:
        def _do(conn: sqlite3.Connection) -> int:
            cur = conn.execute(
                "UPDATE sessions SET archived = ? WHERE id = ?",
                (1 if archived else 0, session_id),
            )
            return cur.rowcount

        return bool(self._execute_write(_do))

    # ── Titles ───────────────────────────────────────────────────────────

    @staticmethod
    def sanitize_title(title: Optional[str]) -> Optional[str]:
        """Trim, strip control characters, and length-limit a session title."""
        if title is None:
            return None
        title = title.strip()
        if not title:
            return None
        title = re.sub(r"[\x00-\x1f\x7f]", "", title)
        return title[: SessionStore.MAX_TITLE_LENGTH] or None

    def set_session_title(self, session_id: str, title: str) -> bool:
        clean = self.sanitize_title(title)
        if clean is None:
            return False

        def _do(conn: sqlite3.Connection) -> int:
            cur = conn.execute(
                "UPDATE sessions SET title = ? WHERE id = ?", (clean, session_id)
            )
            return cur.rowcount

        try:
            return bool(self._execute_write(_do))
        except sqlite3.IntegrityError:
            # Title collides with the unique index — caller can retry with a
            # different title.
            return False

    # ── Reads ────────────────────────────────────────────────────────────

    def get_session(self, session_id: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM sessions WHERE id = ?", (session_id,)
            ).fetchone()
        return dict(row) if row else None

    def resolve_session_id(self, session_id_or_prefix: str) -> Optional[str]:
        """Resolve an exact id, or a unique id prefix, to the full id."""
        if not session_id_or_prefix:
            return None
        exact = self.get_session(session_id_or_prefix)
        if exact:
            return exact["id"]
        escaped = (
            session_id_or_prefix.replace("\\", "\\\\")
            .replace("%", "\\%")
            .replace("_", "\\_")
        )
        with self._lock:
            matches = [
                row["id"]
                for row in self._conn.execute(
                    "SELECT id FROM sessions WHERE id LIKE ? ESCAPE '\\' "
                    "ORDER BY started_at DESC LIMIT 2",
                    (f"{escaped}%",),
                ).fetchall()
            ]
        return matches[0] if len(matches) == 1 else None

    def list_sessions(
        self,
        limit: int = 20,
        offset: int = 0,
        include_children: bool = False,
        include_archived: bool = False,
        archived_only: bool = False,
        min_message_count: int = 0,
    ) -> List[Dict[str, Any]]:
        """List sessions, newest activity first, with a preview + last_active.

        Each row includes a ``preview`` (first ~60 chars of the first user
        message) and ``last_active`` (latest message timestamp, falling back to
        ``started_at``). Child sessions (branches) are hidden unless
        ``include_children`` is set.
        """
        where: List[str] = []
        params: List[Any] = []

        if not include_children:
            where.append("s.parent_session_id IS NULL")
        if min_message_count > 0:
            where.append("s.message_count >= ?")
            params.append(min_message_count)
        if archived_only:
            where.append("s.archived = 1")
        elif not include_archived:
            where.append("s.archived = 0")

        where_sql = f"WHERE {' AND '.join(where)}" if where else ""
        query = f"""
            SELECT s.*,
                COALESCE(
                    (SELECT SUBSTR(REPLACE(REPLACE(m.content_text, X'0A', ' '), X'0D', ' '), 1, 63)
                     FROM messages m
                     WHERE m.session_id = s.id AND m.role = 'user' AND m.content_text IS NOT NULL
                     ORDER BY m.timestamp, m.id LIMIT 1),
                    ''
                ) AS _preview_raw,
                COALESCE(
                    (SELECT MAX(m2.timestamp) FROM messages m2 WHERE m2.session_id = s.id),
                    s.started_at
                ) AS last_active
            FROM sessions s
            {where_sql}
            ORDER BY last_active DESC, s.started_at DESC, s.id DESC
            LIMIT ? OFFSET ?
        """
        params.extend([limit, offset])
        with self._lock:
            rows = self._conn.execute(query, params).fetchall()

        sessions = []
        for row in rows:
            s = dict(row)
            raw = (s.pop("_preview_raw", "") or "").strip()
            s["preview"] = (raw[:60] + ("..." if len(raw) > 60 else "")) if raw else ""
            sessions.append(s)
        return sessions

    def session_count(
        self,
        include_children: bool = False,
        include_archived: bool = False,
        archived_only: bool = False,
    ) -> int:
        where: List[str] = []
        if not include_children:
            where.append("parent_session_id IS NULL")
        if archived_only:
            where.append("archived = 1")
        elif not include_archived:
            where.append("archived = 0")
        where_sql = f" WHERE {' AND '.join(where)}" if where else ""
        with self._lock:
            return self._conn.execute(
                f"SELECT COUNT(*) FROM sessions{where_sql}"
            ).fetchone()[0]

    def message_count(self, session_id: Optional[str] = None) -> int:
        with self._lock:
            if session_id:
                return self._conn.execute(
                    "SELECT COUNT(*) FROM messages WHERE session_id = ?", (session_id,)
                ).fetchone()[0]
            return self._conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0]

    # =========================================================================
    # Messages
    # =========================================================================

    def append_message(
        self,
        session_id: str,
        role: str,
        content: Any = None,
        kind: Optional[str] = None,
        tool_name: Optional[str] = None,
        tool_calls: Any = None,
        tool_call_id: Optional[str] = None,
        token_count: Optional[int] = None,
        finish_reason: Optional[str] = None,
        reasoning: Optional[str] = None,
    ) -> int:
        """Append a message to a session. Returns the message row id.

        Increments the session's ``message_count`` (and ``tool_call_count``
        when tool calls are present). Structured ``content`` (block lists, see
        the content convention near the top of this module) is JSON-encoded
        transparently, and a flattened ``content_text`` projection is stored
        for FTS. ``kind`` is an optional discriminator
        ('chat'/'tool_call'/'tool_result'/'action'/'observation') so agent
        actions can be queried without parsing JSON.
        """
        tool_calls_json = json.dumps(tool_calls) if tool_calls else None
        stored_content = self._encode_content(content)
        content_text = flatten_content_text(content)
        num_tool_calls = (
            (len(tool_calls) if isinstance(tool_calls, list) else 1)
            if tool_calls is not None
            else 0
        )

        def _do(conn: sqlite3.Connection) -> int:
            cur = conn.execute(
                """INSERT INTO messages
                   (session_id, role, kind, content, content_text, tool_call_id,
                    tool_calls, tool_name, timestamp, token_count, finish_reason,
                    reasoning)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    session_id,
                    role,
                    kind,
                    stored_content,
                    content_text,
                    tool_call_id,
                    tool_calls_json,
                    tool_name,
                    time.time(),
                    token_count,
                    finish_reason,
                    reasoning,
                ),
            )
            msg_id = cur.lastrowid
            if num_tool_calls > 0:
                conn.execute(
                    "UPDATE sessions SET message_count = message_count + 1, "
                    "tool_call_count = tool_call_count + ? WHERE id = ?",
                    (num_tool_calls, session_id),
                )
            else:
                conn.execute(
                    "UPDATE sessions SET message_count = message_count + 1 WHERE id = ?",
                    (session_id,),
                )
            return msg_id

        return self._execute_write(_do)

    def replace_messages(self, session_id: str, messages: List[Dict[str, Any]]) -> None:
        """Atomically replace every message for a session (used by branch/copy
        and transcript-rewrite flows)."""
        def _do(conn: sqlite3.Connection) -> None:
            conn.execute("DELETE FROM messages WHERE session_id = ?", (session_id,))
            now_ts = time.time()
            total_messages = 0
            total_tool_calls = 0
            for msg in messages:
                tool_calls = msg.get("tool_calls")
                tool_calls_json = json.dumps(tool_calls) if tool_calls else None
                conn.execute(
                    """INSERT INTO messages
                       (session_id, role, kind, content, content_text, tool_call_id,
                        tool_calls, tool_name, timestamp, token_count, finish_reason,
                        reasoning)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        session_id,
                        msg.get("role", "unknown"),
                        msg.get("kind"),
                        self._encode_content(msg.get("content")),
                        flatten_content_text(msg.get("content")),
                        msg.get("tool_call_id"),
                        tool_calls_json,
                        msg.get("tool_name"),
                        now_ts,
                        msg.get("token_count"),
                        msg.get("finish_reason"),
                        msg.get("reasoning"),
                    ),
                )
                total_messages += 1
                if tool_calls is not None:
                    total_tool_calls += (
                        len(tool_calls) if isinstance(tool_calls, list) else 1
                    )
                now_ts += 1e-6  # preserve insertion order under equal timestamps
            conn.execute(
                "UPDATE sessions SET message_count = ?, tool_call_count = ? WHERE id = ?",
                (total_messages, total_tool_calls, session_id),
            )

        self._execute_write(_do)

    def get_messages(
        self, session_id: str, include_inactive: bool = False
    ) -> List[Dict[str, Any]]:
        """Load a session's messages in insertion order.

        Ordered by AUTOINCREMENT id (true insertion order) rather than
        timestamp, which is robust against clock regressions.
        """
        active_clause = "" if include_inactive else " AND active = 1"
        with self._lock:
            rows = self._conn.execute(
                f"SELECT * FROM messages WHERE session_id = ?{active_clause} ORDER BY id",
                (session_id,),
            ).fetchall()
        result = []
        for row in rows:
            msg = dict(row)
            if "content" in msg:
                msg["content"] = self._decode_content(msg["content"])
            if msg.get("tool_calls"):
                try:
                    msg["tool_calls"] = json.loads(msg["tool_calls"])
                except (json.JSONDecodeError, TypeError):
                    msg["tool_calls"] = []
            result.append(msg)
        return result

    def list_tool_calls(self, limit: int = 200) -> List[Dict[str, Any]]:
        """Audit log: every tool-call message across all sessions, newest first.

        Backs the agent "Audit Log" panel (design §5). Each ``tool`` role message
        is written by the ToolRunner with ``content`` carrying ``{args, result}``
        and ``tool_name`` set. We join the session title so the UI can show which
        run a call belonged to. Ordered by id DESC (true insertion order) which
        is robust against clock regressions, then capped at ``limit``.
        """
        limit = max(1, min(int(limit or 200), 1000))
        with self._lock:
            rows = self._conn.execute(
                """SELECT m.id, m.session_id, m.role, m.content, m.tool_name,
                          m.tool_call_id, m.timestamp, s.title AS session_title
                   FROM messages m
                   LEFT JOIN sessions s ON s.id = m.session_id
                   WHERE m.role = 'tool'
                   ORDER BY m.id DESC
                   LIMIT ?""",
                (limit,),
            ).fetchall()
        result = []
        for row in rows:
            msg = dict(row)
            if "content" in msg:
                msg["content"] = self._decode_content(msg["content"])
            result.append(msg)
        return result

    def clear_tool_calls(self) -> int:
        """Delete every tool-call message (the audit log "Clear history" action).

        Removes only ``role = 'tool'`` rows, leaving the surrounding user/
        assistant conversation intact. Returns the number of rows deleted.
        """
        def _do(conn: sqlite3.Connection) -> int:
            cur = conn.execute("DELETE FROM messages WHERE role = 'tool'")
            return cur.rowcount or 0

        return self._execute_write(_do)

    # =========================================================================
    # Token / cost accounting
    # =========================================================================

    def update_token_counts(
        self,
        session_id: str,
        input_tokens: int = 0,
        output_tokens: int = 0,
        cache_read_tokens: int = 0,
        cache_write_tokens: int = 0,
        reasoning_tokens: int = 0,
        api_call_count: int = 0,
        model: Optional[str] = None,
        estimated_cost_usd: Optional[float] = None,
        actual_cost_usd: Optional[float] = None,
        cost_status: Optional[str] = None,
        cost_source: Optional[str] = None,
        pricing_version: Optional[str] = None,
        absolute: bool = False,
    ) -> None:
        """Update token counters and cost for a session.

        With ``absolute=False`` (default) values are **incremented** (per
        API-call deltas). With ``absolute=True`` they are **set directly**
        (caller holds cumulative totals). Backfills ``model`` only when unset.
        """
        # Ensure the row exists so the UPDATE isn't a silent no-op.
        self._insert_session_row(session_id, model=model)

        if absolute:
            sql = """UPDATE sessions SET
                   input_tokens = ?, output_tokens = ?,
                   cache_read_tokens = ?, cache_write_tokens = ?,
                   reasoning_tokens = ?,
                   api_call_count = ?,
                   estimated_cost_usd = COALESCE(?, estimated_cost_usd),
                   actual_cost_usd = COALESCE(?, actual_cost_usd),
                   cost_status = COALESCE(?, cost_status),
                   cost_source = COALESCE(?, cost_source),
                   pricing_version = COALESCE(?, pricing_version),
                   model = COALESCE(model, ?)
                   WHERE id = ?"""
        else:
            sql = """UPDATE sessions SET
                   input_tokens = input_tokens + ?,
                   output_tokens = output_tokens + ?,
                   cache_read_tokens = cache_read_tokens + ?,
                   cache_write_tokens = cache_write_tokens + ?,
                   reasoning_tokens = reasoning_tokens + ?,
                   api_call_count = COALESCE(api_call_count, 0) + ?,
                   estimated_cost_usd = COALESCE(estimated_cost_usd, 0) + COALESCE(?, 0),
                   actual_cost_usd = CASE WHEN ? IS NULL THEN actual_cost_usd
                                          ELSE COALESCE(actual_cost_usd, 0) + ? END,
                   cost_status = COALESCE(?, cost_status),
                   cost_source = COALESCE(?, cost_source),
                   pricing_version = COALESCE(?, pricing_version),
                   model = COALESCE(model, ?)
                   WHERE id = ?"""

        if absolute:
            params: tuple = (
                input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                reasoning_tokens, api_call_count,
                estimated_cost_usd, actual_cost_usd,
                cost_status, cost_source, pricing_version,
                model, session_id,
            )
        else:
            params = (
                input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                reasoning_tokens, api_call_count,
                estimated_cost_usd,
                actual_cost_usd, actual_cost_usd,
                cost_status, cost_source, pricing_version,
                model, session_id,
            )

        def _do(conn: sqlite3.Connection) -> None:
            conn.execute(sql, params)

        self._execute_write(_do)

    # =========================================================================
    # Full-text search
    # =========================================================================

    @staticmethod
    def _sanitize_fts5_query(query: str) -> str:
        """Sanitize user input for safe use in an FTS5 MATCH query.

        Preserves balanced quoted phrases, strips unmatched FTS5-special
        characters that would raise OperationalError, and quotes hyphenated /
        dotted terms so they match as phrases instead of splitting.
        """
        quoted_parts: List[str] = []

        def _preserve(m: "re.Match[str]") -> str:
            quoted_parts.append(m.group(0))
            return f"\x00Q{len(quoted_parts) - 1}\x00"

        sanitized = re.sub(r'"[^"]*"', _preserve, query)
        # ':' is FTS5's column-filter operator; with a single column it errors.
        sanitized = re.sub(r'[+{}():\"^]', " ", sanitized)
        sanitized = re.sub(r"\*+", "*", sanitized)
        sanitized = re.sub(r"(^|\s)\*", r"\1", sanitized)
        sanitized = re.sub(r"(?i)^(AND|OR|NOT)\b\s*", "", sanitized.strip())
        sanitized = re.sub(r"(?i)\s+(AND|OR|NOT)\s*$", "", sanitized.strip())
        sanitized = re.sub(r"\b(\w+(?:[._-]\w+)+)\b", r'"\1"', sanitized)
        for i, quoted in enumerate(quoted_parts):
            sanitized = sanitized.replace(f"\x00Q{i}\x00", quoted)
        return sanitized.strip()

    @staticmethod
    def _contains_cjk(text: str) -> bool:
        for ch in text:
            cp = ord(ch)
            if (0x4E00 <= cp <= 0x9FFF or 0x3400 <= cp <= 0x4DBF
                    or 0x20000 <= cp <= 0x2A6DF or 0x3000 <= cp <= 0x303F
                    or 0x3040 <= cp <= 0x309F or 0x30A0 <= cp <= 0x30FF
                    or 0xAC00 <= cp <= 0xD7AF):
                return True
        return False

    @classmethod
    def _count_cjk(cls, text: str) -> int:
        return sum(1 for ch in text if cls._contains_cjk(ch))

    def search_messages(
        self,
        query: str,
        role_filter: Optional[List[str]] = None,
        limit: int = 20,
        offset: int = 0,
        sort: Optional[str] = None,
        include_inactive: bool = False,
    ) -> List[Dict[str, Any]]:
        """Full-text search across messages using FTS5.

        Supports FTS5 syntax: keywords, "exact phrase", boolean (OR/NOT),
        prefix (deploy*). CJK queries route to the trigram table (>=3 CJK
        chars) or a LIKE fallback. Returns matches with a highlighted snippet,
        session metadata, and 1 message of surrounding context on each side.

        ``sort``: ``None`` = BM25 relevance, ``"newest"``/``"oldest"`` order by
        message timestamp with rank as tiebreaker.
        """
        if not self._fts_enabled or not query or not query.strip():
            return []
        query = self._sanitize_fts5_query(query)
        if not query:
            return []

        sort_norm = sort.strip().lower() if isinstance(sort, str) else None
        if sort_norm not in ("newest", "oldest"):
            sort_norm = None
        if sort_norm == "newest":
            order_by_sql = "ORDER BY m.timestamp DESC, rank"
        elif sort_norm == "oldest":
            order_by_sql = "ORDER BY m.timestamp ASC, rank"
        else:
            order_by_sql = "ORDER BY rank"

        def _role_clause(prefix: str, params: List[Any]) -> List[str]:
            clauses = []
            if role_filter:
                clauses.append(f"m.role IN ({','.join('?' for _ in role_filter)})")
                params.extend(role_filter)
            return clauses

        matches: List[Dict[str, Any]] = []

        if self._contains_cjk(query):
            raw = query.strip('"').strip()
            tokens = [t for t in raw.split() if t.upper() not in {"AND", "OR", "NOT"}]
            any_short = any(self._count_cjk(t) < 3 for t in tokens if self._contains_cjk(t))
            if self._count_cjk(raw) >= 3 and not any_short:
                parts = [
                    tok if tok.upper() in {"AND", "OR", "NOT"}
                    else '"' + tok.replace('"', '""') + '"'
                    for tok in raw.split()
                ]
                tri_query = " ".join(parts)
                where = ["messages_fts_trigram MATCH ?"]
                params: List[Any] = [tri_query]
                if not include_inactive:
                    where.append("m.active = 1")
                where += _role_clause("m", params)
                sql = f"""
                    SELECT m.id, m.session_id, m.role,
                           snippet(messages_fts_trigram, 0, '>>>', '<<<', '...', 40) AS snippet,
                           m.content, m.timestamp, m.tool_name,
                           s.title, s.model, s.started_at AS session_started
                    FROM messages_fts_trigram
                    JOIN messages m ON m.id = messages_fts_trigram.rowid
                    JOIN sessions s ON s.id = m.session_id
                    WHERE {' AND '.join(where)}
                    {order_by_sql}
                    LIMIT ? OFFSET ?
                """
                params.extend([limit, offset])
                with self._lock:
                    try:
                        matches = [dict(r) for r in self._conn.execute(sql, params).fetchall()]
                    except sqlite3.OperationalError:
                        matches = []
            else:
                tokens = tokens or [raw]
                token_clauses, params = [], []
                for tok in tokens:
                    esc = tok.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
                    token_clauses.append(
                        "(m.content_text LIKE ? ESCAPE '\\' OR m.tool_name LIKE ? ESCAPE '\\' "
                        "OR m.tool_calls LIKE ? ESCAPE '\\')"
                    )
                    params += [f"%{esc}%", f"%{esc}%", f"%{esc}%"]
                where = [f"({' OR '.join(token_clauses)})"]
                where += _role_clause("m", params)
                sql = f"""
                    SELECT m.id, m.session_id, m.role,
                           substr(m.content_text, max(1, instr(m.content_text, ?) - 40), 120) AS snippet,
                           m.content, m.timestamp, m.tool_name,
                           s.title, s.model, s.started_at AS session_started
                    FROM messages m
                    JOIN sessions s ON s.id = m.session_id
                    WHERE {' AND '.join(where)}
                    ORDER BY m.timestamp DESC
                    LIMIT ? OFFSET ?
                """
                params.extend([limit, offset])
                params = [tokens[0]] + params  # instr() snippet anchor
                with self._lock:
                    matches = [dict(r) for r in self._conn.execute(sql, params).fetchall()]
        else:
            where = ["messages_fts MATCH ?"]
            params = [query]
            if not include_inactive:
                where.append("m.active = 1")
            where += _role_clause("m", params)
            sql = f"""
                SELECT m.id, m.session_id, m.role,
                       snippet(messages_fts, 0, '>>>', '<<<', '...', 40) AS snippet,
                       m.content, m.timestamp, m.tool_name,
                       s.title, s.model, s.started_at AS session_started
                FROM messages_fts
                JOIN messages m ON m.id = messages_fts.rowid
                JOIN sessions s ON s.id = m.session_id
                WHERE {' AND '.join(where)}
                {order_by_sql}
                LIMIT ? OFFSET ?
            """
            params.extend([limit, offset])
            with self._lock:
                try:
                    matches = [dict(r) for r in self._conn.execute(sql, params).fetchall()]
                except sqlite3.OperationalError:
                    return []

        # Attach 1 message of context before + after each match.
        for match in matches:
            try:
                with self._lock:
                    ctx = self._conn.execute(
                        """WITH target AS (
                               SELECT session_id, timestamp, id FROM messages WHERE id = ?
                           )
                           SELECT role, content FROM (
                               SELECT m.id, m.timestamp, m.role, m.content
                               FROM messages m JOIN target t ON t.session_id = m.session_id
                               WHERE (m.timestamp < t.timestamp)
                                  OR (m.timestamp = t.timestamp AND m.id < t.id)
                               ORDER BY m.timestamp DESC, m.id DESC LIMIT 1
                           )
                           UNION ALL
                           SELECT role, content FROM messages WHERE id = ?
                           UNION ALL
                           SELECT role, content FROM (
                               SELECT m.id, m.timestamp, m.role, m.content
                               FROM messages m JOIN target t ON t.session_id = m.session_id
                               WHERE (m.timestamp > t.timestamp)
                                  OR (m.timestamp = t.timestamp AND m.id > t.id)
                               ORDER BY m.timestamp ASC, m.id ASC LIMIT 1
                           )""",
                        (match["id"], match["id"]),
                    ).fetchall()
                context = []
                for r in ctx:
                    decoded = self._decode_content(r["content"])
                    if isinstance(decoded, list):
                        text = " ".join(
                            p.get("text", "") for p in decoded
                            if isinstance(p, dict) and p.get("type") == "text"
                        ).strip()
                        preview = text or "[multimodal content]"
                    elif isinstance(decoded, str):
                        preview = decoded
                    else:
                        preview = ""
                    context.append({"role": r["role"], "content": preview[:200]})
                match["context"] = context
            except Exception:
                match["context"] = []
            match.pop("content", None)  # snippet is enough; saves payload size

        return matches

    # =========================================================================
    # Export / delete / maintenance
    # =========================================================================

    def export_session(self, session_id: str) -> Optional[Dict[str, Any]]:
        session = self.get_session(session_id)
        if not session:
            return None
        return {**session, "messages": self.get_messages(session_id)}

    def delete_session(self, session_id: str) -> bool:
        """Delete a session and all its messages. FTS rows are cleaned up by
        the delete triggers."""
        def _do(conn: sqlite3.Connection) -> int:
            conn.execute("DELETE FROM messages WHERE session_id = ?", (session_id,))
            cur = conn.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
            return cur.rowcount

        return bool(self._execute_write(_do))

    def get_meta(self, key: str) -> Optional[str]:
        with self._lock:
            row = self._conn.execute(
                "SELECT value FROM state_meta WHERE key = ?", (key,)
            ).fetchone()
        return row["value"] if row else None

    def set_meta(self, key: str, value: str) -> None:
        def _do(conn: sqlite3.Connection) -> None:
            conn.execute(
                "INSERT INTO state_meta (key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (key, value),
            )

        self._execute_write(_do)

    def stats(self) -> Dict[str, Any]:
        """Aggregate counts + token/cost totals across all sessions."""
        with self._lock:
            row = self._conn.execute(
                """SELECT COUNT(*) AS sessions,
                          COALESCE(SUM(message_count), 0) AS messages,
                          COALESCE(SUM(input_tokens), 0) AS input_tokens,
                          COALESCE(SUM(output_tokens), 0) AS output_tokens,
                          COALESCE(SUM(actual_cost_usd), 0) AS actual_cost_usd,
                          COALESCE(SUM(estimated_cost_usd), 0) AS estimated_cost_usd
                   FROM sessions"""
            ).fetchone()
        return {
            **dict(row),
            "fts_enabled": self._fts_enabled,
            "journal_mode": self.journal_mode(),
            "db_path": str(self.db_path),
        }

    def journal_mode(self) -> Optional[str]:
        try:
            with self._lock:
                row = self._conn.execute("PRAGMA journal_mode").fetchone()
            return str(row[0]).lower() if row else None
        except Exception:
            return None


# ===========================================================================
# CLI
# ===========================================================================

# Each command maps to a handler that receives (store, payload) and returns a
# JSON-serializable result. Payload comes from stdin as a JSON object.
def _cmd_create(store: SessionStore, p: Dict[str, Any]) -> Any:
    sid = store.create_session(
        p.get("id") or p.get("session_id"),
        title=p.get("title"),
        origin=p.get("origin"),
        model=p.get("model"),
        model_config=p.get("model_config"),
        system_prompt=p.get("system_prompt"),
        parent_session_id=p.get("parent_session_id"),
        cwd=p.get("cwd"),
    )
    return {"id": sid, "session": store.get_session(sid)}


def _cmd_end(store: SessionStore, p: Dict[str, Any]) -> Any:
    store.end_session(_require(p, "session_id"), p.get("end_reason", "ended"))
    return {"ok": True}


def _cmd_resume(store: SessionStore, p: Dict[str, Any]) -> Any:
    return store.resume_session(_require(p, "session_id"))


def _cmd_branch(store: SessionStore, p: Dict[str, Any]) -> Any:
    new_id = store.branch_session(
        _require(p, "session_id"),
        new_session_id=p.get("new_session_id"),
        copy_messages=p.get("copy_messages", True),
        title=p.get("title"),
    )
    return {"id": new_id, "session": store.get_session(new_id) if new_id else None}


def _cmd_list(store: SessionStore, p: Dict[str, Any]) -> Any:
    sessions = store.list_sessions(
        limit=int(p.get("limit", 20)),
        offset=int(p.get("offset", 0)),
        include_children=bool(p.get("include_children", False)),
        include_archived=bool(p.get("include_archived", False)),
        archived_only=bool(p.get("archived_only", False)),
        min_message_count=int(p.get("min_message_count", 0)),
    )
    return {
        "sessions": sessions,
        "total": store.session_count(
            include_children=bool(p.get("include_children", False)),
            include_archived=bool(p.get("include_archived", False)),
            archived_only=bool(p.get("archived_only", False)),
        ),
    }


def _cmd_search(store: SessionStore, p: Dict[str, Any]) -> Any:
    return {
        "results": store.search_messages(
            _require(p, "query"),
            role_filter=p.get("role_filter"),
            limit=int(p.get("limit", 20)),
            offset=int(p.get("offset", 0)),
            sort=p.get("sort"),
            include_inactive=bool(p.get("include_inactive", False)),
        )
    }


def _cmd_add_message(store: SessionStore, p: Dict[str, Any]) -> Any:
    sid = _require(p, "session_id")
    # Auto-create the session if it doesn't exist yet, so the renderer can add
    # the first message without a separate create round-trip.
    if store.get_session(sid) is None:
        store.create_session(sid, title=p.get("title"), origin=p.get("origin"))
    msg_id = store.append_message(
        sid,
        _require(p, "role"),
        content=p.get("content"),
        kind=p.get("kind"),
        tool_name=p.get("tool_name"),
        tool_calls=p.get("tool_calls"),
        tool_call_id=p.get("tool_call_id"),
        token_count=p.get("token_count"),
        finish_reason=p.get("finish_reason"),
        reasoning=p.get("reasoning"),
    )
    return {"id": msg_id}


def _cmd_get_messages(store: SessionStore, p: Dict[str, Any]) -> Any:
    return {
        "messages": store.get_messages(
            _require(p, "session_id"),
            include_inactive=bool(p.get("include_inactive", False)),
        )
    }


def _cmd_list_tool_calls(store: SessionStore, p: Dict[str, Any]) -> Any:
    return {"tool_calls": store.list_tool_calls(limit=int(p.get("limit", 200)))}


def _cmd_clear_tool_calls(store: SessionStore, p: Dict[str, Any]) -> Any:
    return {"deleted": store.clear_tool_calls()}


def _cmd_get(store: SessionStore, p: Dict[str, Any]) -> Any:
    return store.get_session(_require(p, "session_id"))


def _cmd_set_title(store: SessionStore, p: Dict[str, Any]) -> Any:
    return {"ok": store.set_session_title(_require(p, "session_id"), _require(p, "title"))}


def _cmd_archive(store: SessionStore, p: Dict[str, Any]) -> Any:
    return {"ok": store.set_session_archived(_require(p, "session_id"), bool(p.get("archived", True)))}


def _cmd_update_tokens(store: SessionStore, p: Dict[str, Any]) -> Any:
    store.update_token_counts(
        _require(p, "session_id"),
        input_tokens=int(p.get("input_tokens", 0)),
        output_tokens=int(p.get("output_tokens", 0)),
        cache_read_tokens=int(p.get("cache_read_tokens", 0)),
        cache_write_tokens=int(p.get("cache_write_tokens", 0)),
        reasoning_tokens=int(p.get("reasoning_tokens", 0)),
        api_call_count=int(p.get("api_call_count", 0)),
        model=p.get("model"),
        estimated_cost_usd=p.get("estimated_cost_usd"),
        actual_cost_usd=p.get("actual_cost_usd"),
        cost_status=p.get("cost_status"),
        cost_source=p.get("cost_source"),
        pricing_version=p.get("pricing_version"),
        absolute=bool(p.get("absolute", False)),
    )
    return {"ok": True, "session": store.get_session(p["session_id"])}


def _cmd_delete(store: SessionStore, p: Dict[str, Any]) -> Any:
    return {"ok": store.delete_session(_require(p, "session_id"))}


def _cmd_export(store: SessionStore, p: Dict[str, Any]) -> Any:
    return store.export_session(_require(p, "session_id"))


def _cmd_stats(store: SessionStore, p: Dict[str, Any]) -> Any:
    return store.stats()


_COMMANDS: Dict[str, Callable[[SessionStore, Dict[str, Any]], Any]] = {
    "create": _cmd_create,
    "end": _cmd_end,
    "resume": _cmd_resume,
    "branch": _cmd_branch,
    "list": _cmd_list,
    "search": _cmd_search,
    "add-message": _cmd_add_message,
    "get-messages": _cmd_get_messages,
    "list-tool-calls": _cmd_list_tool_calls,
    "clear-tool-calls": _cmd_clear_tool_calls,
    "get": _cmd_get,
    "set-title": _cmd_set_title,
    "archive": _cmd_archive,
    "update-tokens": _cmd_update_tokens,
    "delete": _cmd_delete,
    "export": _cmd_export,
    "stats": _cmd_stats,
}


def _require(payload: Dict[str, Any], key: str) -> Any:
    if key not in payload or payload[key] in (None, ""):
        raise ValueError(f"missing required field: {key}")
    return payload[key]


def _default_db_path() -> Path:
    env = os.getenv("HENRY_SESSION_DB")
    if env:
        return Path(env)
    return Path.home() / ".henry" / "sessions.db"


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="Henry AI SessionStore — JSON CLI over stdin/stdout."
    )
    parser.add_argument("command", choices=sorted(_COMMANDS.keys()))
    parser.add_argument(
        "--db", default=None,
        help="Path to the sessions SQLite database (default: $HENRY_SESSION_DB "
             "or ~/.henry/sessions.db)",
    )
    parser.add_argument(
        "--payload", default=None,
        help="Inline JSON payload. If omitted, JSON is read from stdin.",
    )
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args(argv)

    _configure_logging(logging.DEBUG if args.verbose else logging.WARNING)

    # Read the payload: --payload wins; otherwise stdin (empty stdin => {}).
    if args.payload is not None:
        raw = args.payload
    else:
        raw = sys.stdin.read() if not sys.stdin.isatty() else ""
    try:
        payload: Dict[str, Any] = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError as exc:
        print(json.dumps({"ok": False, "error": f"invalid JSON payload: {exc}"}))
        return 2
    if not isinstance(payload, dict):
        print(json.dumps({"ok": False, "error": "payload must be a JSON object"}))
        return 2

    db_path = Path(args.db) if args.db else _default_db_path()
    store = None
    try:
        store = SessionStore(db_path)
        result = _COMMANDS[args.command](store, payload)
        print(json.dumps({"ok": True, "result": result}, default=str))
        return 0
    except Exception as exc:  # noqa: BLE001 - surface any failure as JSON
        logger.exception("command %s failed", args.command)
        print(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}))
        return 1
    finally:
        if store is not None:
            store.close()


if __name__ == "__main__":
    sys.exit(main())
