"""Reading one owner's sessions out of a store: the change feed, a session's pointer, a trace.

This is the reader half of the TypeScript ``StoreSessionDB``, and all of it a consumer needs:
ingest (redaction, normalization) runs in the TypeScript SDK or in a sessiondb server, and a
Python program that wants to store a session talks to a server (``sessiondb.connect``). A
reader needs ``s3:ListBucket`` on the prefix and ``s3:GetObject`` under it, nothing more.

Tailing the feed: keep the last key processed as the cursor and, on each poll, list after it.
Entries are stamped by the clocks of the laptops that uploaded, so an entry can land behind the
cursor; a consumer that must not miss one re-reads a lag window behind its cursor
(``lag_start``) and dedupes by key.
"""

from __future__ import annotations

import gzip
from collections.abc import Iterator
from datetime import datetime, timedelta

from pydantic import BaseModel, ValidationError

from sessiondb.errors import LayoutError
from sessiondb.layout import Keys, archive_id, change_stamp, parse_change_key
from sessiondb.models import (
    Change,
    ChangeEntry,
    ChangesPage,
    Identity,
    LayoutMarker,
    SessionMetadata,
    SessionsPage,
    StorageView,
    Trace,
)
from sessiondb.store.base import PAGE_LIMIT, ObjectStore


def decode[M: BaseModel](model: type[M], raw: bytes, key: str) -> M:
    """Parse an object of the layout, or raise ``LayoutError`` naming the key."""
    try:
        return model.model_validate_json(raw)
    except ValidationError as e:
        first = e.errors()[0]
        where = ".".join(str(p) for p in first["loc"])
        msg = first["msg"].removeprefix("Value error, ")
        raise LayoutError(f"{key}: {where + ': ' if where else ''}{msg}") from e
    except ValueError as e:
        raise LayoutError(f"{key}: {e}") from e


def lag_start(cursor_at: datetime | None, lag: timedelta | float) -> datetime | None:
    """Where a poll re-reads from: the cursor's time minus the lag window (a ``timedelta`` or
    seconds). None for no cursor: read from the beginning."""
    if cursor_at is None:
        return None
    window = lag if isinstance(lag, timedelta) else timedelta(seconds=lag)
    return cursor_at - window


class StoreSessionDB:
    """One owner's sessions in a store, read-only."""

    def __init__(
        self, store: ObjectStore, owner: str, *, storage: StorageView | None = None
    ) -> None:
        self.store = store
        self.keys = Keys(owner)
        self.owner = self.keys.owner
        self.storage = storage or StorageView(url=store.url)

    def me(self) -> Identity:
        return Identity(owner=self.owner, storage=self.storage)

    # --- the layout -----------------------------------------------------------------------

    def layout(self) -> LayoutMarker | None:
        """The prefix's marker; None when the prefix was never written to."""
        raw = self.store.get(self.keys.layout)
        return None if raw is None else decode(LayoutMarker, raw, self.keys.layout)

    def check(self) -> LayoutMarker | None:
        """What connecting a reader should do once: the store lists (the credential and the
        bucket are right) and, when the prefix has been written to, its marker is a layout
        this reader knows. Raises ``LayoutError`` for one it does not; store errors
        propagate."""
        self.store.list(self.keys.changes, limit=1)
        return self.layout()

    # --- the change feed ------------------------------------------------------------------

    def changes(
        self,
        *,
        after: str | None = None,
        since: datetime | None = None,
        limit: int = PAGE_LIMIT,
    ) -> ChangesPage:
        """One page of the feed after a key (the cursor), or from a time. Keys that are not
        change keys are ignored, so a stray object cannot stop the feed; a key whose object is
        gone (a write in flight, a delete) is skipped. The page's ``cursor`` is the last key
        listed, skipped or not, so no key is listed twice."""
        prefix = self.keys.changes
        start_after = after
        if start_after is None and since is not None:
            start_after = f"{prefix}{change_stamp(since)}"
        page = self.store.list(prefix, start_after=start_after, limit=limit)
        entries: list[Change] = []
        for key in page.keys:
            if parse_change_key(key) is None:
                continue
            raw = self.store.get(key)
            if raw is None:
                continue
            entries.append(Change(key=key, entry=decode(ChangeEntry, raw, key)))
        return ChangesPage(
            entries=entries, cursor=page.keys[-1] if page.keys else None, truncated=page.truncated
        )

    def iter_changes(
        self,
        *,
        after: str | None = None,
        since: datetime | None = None,
        limit: int | None = None,
    ) -> Iterator[Change]:
        """Entries across pages, up to ``limit`` (all of them when None)."""
        seen = 0
        cursor = after
        first = True
        while limit is None or seen < limit:
            page_limit = PAGE_LIMIT if limit is None else min(PAGE_LIMIT, limit - seen)
            page = self.changes(after=cursor, since=since if first else None, limit=page_limit)
            first = False
            for change in page.entries:
                yield change
                seen += 1
                if limit is not None and seen >= limit:
                    return
            cursor = page.cursor
            if not page.truncated or cursor is None:
                return

    def count_changes_after(self, after: str | None, *, cap: int = PAGE_LIMIT) -> int:
        """How many feed keys follow a cursor, up to ``cap`` (one listing)."""
        page = self.store.list(self.keys.changes, start_after=after, limit=cap)
        return sum(1 for k in page.keys if parse_change_key(k) is not None)

    # --- sessions -------------------------------------------------------------------------

    def list_sessions(self, *, after: str | None = None, limit: int = PAGE_LIMIT) -> SessionsPage:
        """Every session's pointer under the owner, paged by key: a full scan. A reader that
        wants an index builds its own from the change feed."""
        page = self.store.list(self.keys.sessions, start_after=after, limit=limit)
        sessions: list[SessionMetadata] = []
        for key in page.keys:
            if not key.endswith("/metadata.json"):
                continue
            raw = self.store.get(key)
            if raw is not None:
                sessions.append(decode(SessionMetadata, raw, key))
        return SessionsPage(
            sessions=sessions,
            cursor=page.keys[-1] if page.keys else None,
            truncated=page.truncated,
        )

    def iter_sessions(self) -> Iterator[SessionMetadata]:
        cursor: str | None = None
        while True:
            page = self.list_sessions(after=cursor)
            yield from page.sessions
            cursor = page.cursor
            if not page.truncated or cursor is None:
                return

    def archive_id(self, agent: str, session_id: str) -> str:
        return archive_id(self.owner, agent, session_id)

    def get_session(self, agent: str, session_id: str) -> SessionMetadata | None:
        """The session's pointer, or None for one not stored."""
        return self.get_metadata(self.archive_id(agent, session_id))

    def get_metadata(self, archive: str) -> SessionMetadata | None:
        key = self.keys.metadata(archive)
        raw = self.store.get(key)
        return None if raw is None else decode(SessionMetadata, raw, key)

    def get_trace(self, agent: str, session_id: str, hash: str | None = None) -> Trace | None:
        """The head trace, or the one named by ``hash``; None for a session not stored, stored
        raw only (nothing worth a trace yet), or redacted."""
        metadata = self.get_session(agent, session_id)
        if metadata is None or metadata.status == "redacted":
            return None
        wanted = hash or metadata.head
        if wanted is None:
            return None
        return self.read_trace(metadata.archive_id, wanted)

    def read_trace(self, archive: str, content_hash: str) -> Trace | None:
        """A trace object by its archive and hash, as a change entry names it; None when it is
        not there (tombstoned since)."""
        key = self.keys.trace(archive, content_hash)
        raw = self.store.get(key)
        if raw is None:
            return None
        try:
            text = gzip.decompress(raw)
        except (OSError, EOFError) as e:
            raise LayoutError(f"{key}: not gzip ({e})") from e
        return decode(Trace, text, key)

    def read_traces(self, metadata: SessionMetadata) -> list[Trace]:
        """The whole session: its traces in ``traces`` order (the head, then continuations),
        those still in the store."""
        traces: list[Trace] = []
        for ref in metadata.traces:
            trace = self.read_trace(metadata.archive_id, ref.content_hash)
            if trace is not None:
                traces.append(trace)
        return traces
