"""The key layout: the contract between every writer and every reader. See ``spec/layout.md``.

::

    sessionstorage.json                                     layout marker
    owners/<owner>/.probe                                   a writer's write check
    owners/<owner>/sessions/<archive_id>/metadata.json
    owners/<owner>/sessions/<archive_id>/trace.<content_hash>.json.gz
    owners/<owner>/sessions/<archive_id>/raw.<n>.<jsonl|json>.gz
    owners/<owner>/changes/<stamp>-<content_hash|tombstone>.json

Keys are relative to the store's root (a directory, or a bucket prefix). This module is the
only one that spells them, the same way ``store/layout.ts`` is for the TypeScript SDK; the two
agree byte for byte, which the golden-bucket tests check.
"""

from __future__ import annotations

import hashlib
import re
from datetime import UTC, datetime
from typing import Literal, NamedTuple

from sessiondb.errors import LayoutError

_OWNER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
# <stamp>-<hash|tombstone>.json at the end of a key under changes/.
_CHANGE_KEY = re.compile(r"/changes/(\d{8}T\d{6}\.\d{3}Z)-([0-9a-f]{64}|tombstone)\.json$")

LAYOUT_KEY = "sessionstorage.json"

RawFormat = Literal["jsonl", "json"]


def assert_owner(owner: str) -> str:
    """An owner name is one path segment: letters, digits, ``.``, ``_``, ``-``; 128 at most."""
    if not _OWNER.match(owner):
        raise LayoutError(f"invalid owner: {owner!r}")
    return owner


def archive_id(owner: str, agent: str, session_id: str) -> str:
    """``sha256(owner + "\\n" + agent + "\\n" + session_id)``: deterministic, so every upload for
    one session lands in one directory; derived, so no native id or path appears in a key."""
    return hashlib.sha256(f"{owner}\n{agent}\n{session_id}".encode()).hexdigest()


def change_stamp(at: datetime) -> str:
    """The change-key timestamp: RFC 3339 UTC to the millisecond with ``-`` and ``:`` dropped,
    so keys sort by time and are valid on every filesystem:
    ``2026-10-21T21:04:05.123Z`` → ``20261021T210405.123Z``. A naive datetime is taken as
    UTC."""
    if at.tzinfo is None:
        at = at.replace(tzinfo=UTC)
    utc = at.astimezone(UTC)
    return utc.strftime("%Y%m%dT%H%M%S.") + f"{utc.microsecond // 1000:03d}Z"


class ParsedChangeKey(NamedTuple):
    at: datetime
    # None for a tombstone.
    content_hash: str | None


def parse_change_key(key: str) -> ParsedChangeKey | None:
    """``(at, content_hash)`` of a change key, or None for a key that is not one (a stray object
    under ``changes/`` must not stop a feed)."""
    m = _CHANGE_KEY.search(key)
    if not m:
        return None
    at = datetime.strptime(m.group(1), "%Y%m%dT%H%M%S.%fZ").replace(tzinfo=UTC)
    return ParsedChangeKey(at, None if m.group(2) == "tombstone" else m.group(2))


class Keys:
    """Key builders for one owner. ``Keys("acme").metadata(archive)`` and so on."""

    __slots__ = ("owner",)

    def __init__(self, owner: str) -> None:
        self.owner = assert_owner(owner)

    @property
    def layout(self) -> str:
        return LAYOUT_KEY

    @property
    def root(self) -> str:
        return f"owners/{self.owner}"

    @property
    def probe(self) -> str:
        return f"{self.root}/.probe"

    @property
    def sessions(self) -> str:
        return f"{self.root}/sessions/"

    @property
    def changes(self) -> str:
        return f"{self.root}/changes/"

    def session(self, archive: str) -> str:
        return f"{self.root}/sessions/{archive}"

    def metadata(self, archive: str) -> str:
        return f"{self.session(archive)}/metadata.json"

    def trace(self, archive: str, content_hash: str) -> str:
        return f"{self.session(archive)}/trace.{content_hash}.json.gz"

    def raw(self, archive: str, part: int, fmt: RawFormat) -> str:
        return f"{self.session(archive)}/raw.{part}.{fmt}.gz"

    def change(self, at: datetime, content_hash: str | None) -> str:
        return f"{self.changes}{change_stamp(at)}-{content_hash or 'tombstone'}.json"
