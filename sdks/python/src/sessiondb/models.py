"""What a sessionstorage bucket holds, and what a sessiondb server answers.

Every object in the layout carries a ``schema`` string; the models refuse versions they do
not know, so a layout bump never silently reads the wrong shape. Fields the writer may add
later are ignored, so a newer writer does not break an older reader. The shapes are
``spec/openapi.yaml``'s; the TypeScript SDK's ``schemas/`` are the same contract typed for it.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, ClassVar, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from sessiondb.layout import RawFormat

METADATA_SCHEMA = "sessionstorage/metadata/1"
CHANGE_SCHEMA = "sessionstorage/change/1"
LAYOUT_SCHEMA = "sessionstorage/layout/1"
TRACE_SCHEMA = "sessionstorage/trace/1"

SessionStatus = Literal["stored", "redacted"]
ChangeKind = Literal["published", "tombstone"]
EventRole = Literal[
    "user", "assistant", "tool_call", "tool_result", "system", "observation", "reasoning"
]


class _Model(BaseModel):
    model_config = ConfigDict(extra="ignore", populate_by_name=True)


class _Object(_Model):
    """An object of the layout: carries the ``schema`` string of the one shape this reader
    knows for it."""

    SCHEMA: ClassVar[str]
    schema_: str = Field(alias="schema")

    @field_validator("schema_")
    @classmethod
    def _known_schema(cls, v: str) -> str:
        if v != cls.SCHEMA:
            raise ValueError(f"unknown schema {v!r}, this reader knows {cls.SCHEMA!r}")
        return v


# --- the layout's objects ---------------------------------------------------------------------


class LayoutMarker(_Object):
    """``<prefix>/sessionstorage.json``: written once when a prefix is first used, and what a
    reader checks before trusting anything under it."""

    SCHEMA = LAYOUT_SCHEMA
    created_at: datetime
    created_by: str


class Continuation(_Model):
    """A trace that is the tail of a session already stored: where its records start in the
    whole session, and a hash of everything before."""

    from_record: int = Field(ge=0)
    prefix_sha256: str = Field(min_length=64, max_length=64)


class SessionTraceRef(_Model):
    content_hash: str
    created_at: datetime
    records: int
    continuation: Continuation | None = None


class RawPart(_Model):
    """One stored part of the native transcript, and where it sits in the log."""

    part: int
    format: RawFormat
    size: int
    sha256: str
    created_at: datetime
    offset: int = 0
    length: int = 0


class NormalizedState(_Model):
    """How much of the log has been normalized: where the next chunk starts."""

    bytes: int
    records: int
    prefix_sha256: str
    hash_state: str | None = None


class SessionMetadata(_Object):
    """``metadata.json``: the live pointer for one session. A session exists from its first raw
    part on; ``head`` and ``source`` are absent until a trace is stored, and ``head`` again
    once the session is redacted."""

    SCHEMA = METADATA_SCHEMA
    owner: str
    archive_id: str
    session_id: str
    agent: str
    source: str | None = None
    project: str | None = None
    branch: str | None = None
    parent_session_id: str | None = None
    status: SessionStatus
    head: str | None = None
    traces: list[SessionTraceRef] = Field(default_factory=list)
    raw: list[RawPart] = Field(default_factory=list)
    raw_format: RawFormat | None = None
    normalized: NormalizedState | None = None
    created_at: datetime
    updated_at: datetime


class ChangeEntry(_Object):
    """One line of the feed: a trace published, or a session tombstoned."""

    SCHEMA = CHANGE_SCHEMA
    kind: ChangeKind
    at: datetime
    owner: str
    archive_id: str
    session_id: str
    # The trace the entry is about; a tombstone names the session's head then, or null.
    content_hash: str | None = None
    continuation: Continuation | None = None


class TraceEvent(_Model):
    """One unit of a trace. ``index`` is stable for the life of the object; ``text`` is the
    canonical string every excerpt of the session is validated against."""

    index: int
    role: EventRole
    text: str
    timestamp: datetime | None = None
    tool_name: str | None = None
    tool_call_id: str | None = None
    ok: bool | None = None


class Trace(_Object):
    """``trace.<content_hash>.json.gz``: the normalized, redacted records, the events derived
    from them, and what the normalizer knew about the session."""

    SCHEMA = TRACE_SCHEMA
    content_hash: str
    source: str
    agent: str
    project: str | None = None
    branch: str | None = None
    session_id: str | None = None
    started_at: datetime | None = None
    ended_at: datetime | None = None
    records: list[dict[str, Any]]
    events: list[TraceEvent] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)

    @property
    def continuation(self) -> Continuation | None:
        raw = self.metadata.get("continuation")
        return None if raw is None else Continuation.model_validate(raw)


# --- pages and identities ---------------------------------------------------------------------


class Change(_Model):
    """A feed entry with its key: the key is the cursor for everything up to and including
    it."""

    key: str
    entry: ChangeEntry


class ChangesPage(_Model):
    entries: list[Change]
    # The last key on the page; pass as ``after``. None when the page is empty.
    cursor: str | None = None
    truncated: bool


class SessionsPage(_Model):
    sessions: list[SessionMetadata]
    cursor: str | None = None
    truncated: bool


class StorageView(_Model):
    """Where the sessions go, as a reader would need to know it. Never a secret."""

    url: str
    region: str | None = None
    account_id: str | None = None
    endpoint: str | None = None


class Identity(_Model):
    owner: str
    storage: StorageView


# --- the server's answers to an upload --------------------------------------------------------


class RawStatus(_Model):
    status: Literal["stored", "exists"]
    part: int


class Shipped(_Model):
    """What the last answer for a session said, sent back so a whole upload of a session
    already stored ships only its tail."""

    records: int = Field(ge=0)
    prefix_sha256: str


class IngestResult(_Model):
    """The server's answer to an upload. ``status`` is ``stored`` (a trace was written),
    ``duplicate`` (the content was already there) or ``trivial`` (stored raw, nothing in it
    worth a trace); the rest is what the client keeps for the next upload of the session."""

    status: Literal["stored", "duplicate", "trivial"]
    records_total: int
    prefix_sha256: str
    bytes_total: int
    raw: RawStatus
    # Set for ``stored`` and ``duplicate``.
    archive_id: str | None = None
    content_hash: str | None = None
    session_id: str | None = None
    records: int | None = None
    events: int | None = None

    @property
    def shipped(self) -> Shipped:
        return Shipped(records=self.records_total, prefix_sha256=self.prefix_sha256)


class TombstoneResult(_Model):
    removed: int
