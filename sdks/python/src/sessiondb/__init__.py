"""sessiondb for Python: read coding-agent sessions out of a sessionstorage bucket, or talk to
a sessiondb server.

    from sessiondb import connect, open_store

    db = connect(store=open_store("r2://bucket/prefix", account_id="...").store, owner="acme")
    page = db.changes(after=cursor)
    for change in page.entries:
        if change.entry.kind == "published":
            trace = db.read_trace(change.entry.archive_id, change.entry.content_hash)
"""

from sessiondb.client import ServerError, ServerSessionDB, SessionReader, connect
from sessiondb.errors import (
    LayoutError,
    OffsetMismatch,
    SessionDBError,
    SessionRejected,
    StoreError,
    Unauthorized,
)
from sessiondb.layout import (
    LAYOUT_KEY,
    Keys,
    ParsedChangeKey,
    RawFormat,
    archive_id,
    assert_owner,
    change_stamp,
    parse_change_key,
)
from sessiondb.models import (
    CHANGE_SCHEMA,
    LAYOUT_SCHEMA,
    METADATA_SCHEMA,
    TRACE_SCHEMA,
    Change,
    ChangeEntry,
    ChangeKind,
    ChangesPage,
    Continuation,
    EventRole,
    Identity,
    IngestResult,
    LayoutMarker,
    NormalizedState,
    RawPart,
    RawStatus,
    SessionMetadata,
    SessionsPage,
    SessionStatus,
    SessionTraceRef,
    Shipped,
    StorageView,
    TombstoneResult,
    Trace,
    TraceEvent,
)
from sessiondb.reader import StoreSessionDB, decode, lag_start
from sessiondb.store import (
    PAGE_LIMIT,
    FsStore,
    ListPage,
    ObjectStore,
    OpenedStore,
    S3Credentials,
    S3Store,
    S3Url,
    is_store_url,
    open_store,
    parse_s3_url,
)
from sessiondb.version import VERSION

__version__ = VERSION

__all__ = [
    "CHANGE_SCHEMA",
    "LAYOUT_KEY",
    "LAYOUT_SCHEMA",
    "METADATA_SCHEMA",
    "PAGE_LIMIT",
    "TRACE_SCHEMA",
    "VERSION",
    "Change",
    "ChangeEntry",
    "ChangeKind",
    "ChangesPage",
    "Continuation",
    "EventRole",
    "FsStore",
    "Identity",
    "IngestResult",
    "Keys",
    "LayoutError",
    "LayoutMarker",
    "ListPage",
    "NormalizedState",
    "ObjectStore",
    "OffsetMismatch",
    "OpenedStore",
    "ParsedChangeKey",
    "RawFormat",
    "RawPart",
    "RawStatus",
    "S3Credentials",
    "S3Store",
    "S3Url",
    "ServerError",
    "ServerSessionDB",
    "SessionDBError",
    "SessionMetadata",
    "SessionReader",
    "SessionRejected",
    "SessionStatus",
    "SessionTraceRef",
    "SessionsPage",
    "Shipped",
    "StorageView",
    "StoreError",
    "StoreSessionDB",
    "TombstoneResult",
    "Trace",
    "TraceEvent",
    "Unauthorized",
    "archive_id",
    "assert_owner",
    "change_stamp",
    "connect",
    "decode",
    "is_store_url",
    "lag_start",
    "open_store",
    "parse_change_key",
    "parse_s3_url",
]
