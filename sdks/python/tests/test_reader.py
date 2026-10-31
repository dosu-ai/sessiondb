"""Reading the golden bucket back: what the TypeScript SDK wrote is what the reader gets."""

import gzip
import json
from datetime import UTC, datetime

import pytest

from sessiondb import (
    LAYOUT_SCHEMA,
    FsStore,
    LayoutError,
    StoreSessionDB,
    archive_id,
    connect,
    parse_change_key,
)
from tests.conftest import AUTH, OWNER, PERF, RAW_ONLY, RAW_ONLY_JSON, REFACTOR


def by_id(manifest, session_id, *, note=None):
    for s in manifest["sessions"]:
        if s["session_id"] == session_id and s.get("note") == note:
            return s
    raise KeyError(session_id)


# --- the layout ---------------------------------------------------------------------------------


def test_check_reads_the_marker(db):
    marker = db.check()
    assert marker is not None
    assert marker.schema_ == LAYOUT_SCHEMA
    assert marker.created_by == "golden-bucket"


def test_an_empty_prefix_has_no_marker(tmp_path):
    db = StoreSessionDB(FsStore(tmp_path), OWNER)
    assert db.check() is None
    assert db.changes().entries == []
    assert db.list_sessions().sessions == []


def test_an_unknown_layout_schema_is_refused(bucket, db):
    bucket.put(
        "sessionstorage.json",
        json.dumps(
            {
                "schema": "sessionstorage/layout/2",
                "created_at": "2026-01-01T00:00:00Z",
                "created_by": "x",
            }
        ).encode(),
    )
    with pytest.raises(LayoutError, match=r"sessionstorage\.json: schema: unknown schema"):
        db.check()


def test_me_names_the_owner_and_the_store(bucket, db):
    me = db.me()
    assert me.owner == OWNER
    assert me.storage.url == bucket.url
    assert me.storage.url.startswith("file://")


# --- the change feed ----------------------------------------------------------------------------


def test_the_feed_is_every_publish_and_tombstone_in_time_order(db, manifest):
    page = db.changes()
    assert not page.truncated
    assert page.cursor == page.entries[-1].key
    kinds = [c.entry.kind for c in page.entries]
    assert kinds == ["published", "published", "published", "published", "tombstone"]
    keys = [c.key for c in page.entries]
    assert keys == sorted(keys)
    for change in page.entries:
        parsed = parse_change_key(change.key)
        assert parsed is not None
        assert parsed.at == change.entry.at
        # A tombstone's key has no hash; its entry names the head at the time.
        expected = change.entry.content_hash if change.entry.kind == "published" else None
        assert parsed.content_hash == expected
        assert change.entry.owner == OWNER
    hashes = [c.entry.content_hash for c in page.entries if c.entry.kind == "published"]
    assert hashes == [
        by_id(manifest, AUTH)["content_hash"],
        by_id(manifest, REFACTOR, note="tombstoned")["content_hash"],
        by_id(manifest, PERF)["content_hash"],
        by_id(manifest, AUTH, note="continuation")["content_hash"],
    ]
    tomb = page.entries[-1].entry
    assert tomb.session_id == REFACTOR
    assert tomb.content_hash == by_id(manifest, REFACTOR, note="tombstoned")["content_hash"]


def test_a_continuation_entry_says_where_it_starts(db, manifest):
    grown = by_id(manifest, AUTH, note="continuation")
    [entry] = [
        c.entry for c in db.changes().entries if c.entry.content_hash == grown["content_hash"]
    ]
    assert entry.continuation is not None
    assert entry.continuation.from_record == by_id(manifest, AUTH)["records"]


def test_the_cursor_continues_the_feed(db):
    first = db.changes(limit=2)
    assert first.truncated
    assert len(first.entries) == 2
    rest = db.changes(after=first.cursor)
    assert not rest.truncated
    assert [c.key for c in first.entries] + [c.key for c in rest.entries] == [
        c.key for c in db.changes().entries
    ]


def test_since_starts_from_a_time(db):
    everything = db.changes().entries
    third_at = everything[2].entry.at
    # From a time: every entry stamped at or after it (a key is its stamp and more, so it sorts
    # after the bare stamp), the same as the TypeScript reader.
    assert [c.key for c in db.changes(since=third_at).entries] == [c.key for c in everything[2:]]
    after = datetime.fromtimestamp(third_at.timestamp() + 0.001, tz=UTC)
    assert [c.key for c in db.changes(since=after).entries] == [c.key for c in everything[3:]]
    assert db.changes(since=datetime(2030, 1, 1, tzinfo=UTC)).entries == []


def test_iter_changes_walks_the_pages(db, monkeypatch):
    monkeypatch.setattr("sessiondb.reader.PAGE_LIMIT", 2)
    keys = [c.key for c in db.iter_changes()]
    assert keys == [c.key for c in db.changes().entries]
    assert [c.key for c in db.iter_changes(limit=3)] == keys[:3]
    assert [c.key for c in db.iter_changes(after=keys[1], limit=10)] == keys[2:]


def test_strays_and_vanished_entries_do_not_stop_the_feed(bucket, db):
    bucket.put("owners/acme/changes/README.txt", b"not a change")
    # A key listed whose object is gone by the time it is read (a write in flight).
    in_flight = "owners/acme/changes/20261021T210412.000Z-" + "0" * 64 + ".json"
    real_get = bucket.get
    bucket.put(in_flight, b"{}")
    bucket.get = lambda key: None if key == in_flight else real_get(key)  # type: ignore[method-assign]
    page = db.changes()
    assert len(page.entries) == 5
    assert all(c.key != in_flight for c in page.entries)
    # The cursor still passes both, so neither is listed again.
    assert page.cursor == "owners/acme/changes/README.txt" or page.cursor > in_flight


def test_a_change_with_an_unknown_schema_is_a_layout_error(bucket, db):
    key = "owners/acme/changes/20261021T210419.000Z-" + "1" * 64 + ".json"
    bucket.put(key, json.dumps({"schema": "sessionstorage/change/9", "kind": "published"}).encode())
    with pytest.raises(LayoutError, match=key):
        db.changes()


def test_count_changes_after(db):
    keys = [c.key for c in db.changes().entries]
    assert db.count_changes_after(None) == 5
    assert db.count_changes_after(keys[2]) == 2
    assert db.count_changes_after(keys[-1]) == 0


# --- sessions -----------------------------------------------------------------------------------


def test_list_sessions_is_every_pointer(db):
    page = db.list_sessions()
    assert not page.truncated
    ids = sorted(s.session_id for s in page.sessions)
    assert ids == sorted([AUTH, REFACTOR, PERF, RAW_ONLY, RAW_ONLY_JSON])
    assert list(db.iter_sessions()) == page.sessions


def test_list_sessions_pages_by_key(db, monkeypatch):
    monkeypatch.setattr("sessiondb.reader.PAGE_LIMIT", 3)
    pages = []
    cursor = None
    while True:
        page = db.list_sessions(after=cursor, limit=3)
        pages.append(page)
        cursor = page.cursor
        if not page.truncated:
            break
    assert len(pages) > 1
    assert sorted(s.session_id for p in pages for s in p.sessions) == sorted(
        s.session_id for s in db.list_sessions().sessions
    )


def test_a_pointer_has_its_traces_and_raw_parts(db, manifest):
    pointer = db.get_session("claude-code", AUTH)
    assert pointer is not None
    first, grown = by_id(manifest, AUTH), by_id(manifest, AUTH, note="continuation")
    assert pointer.archive_id == first["archive_id"] == archive_id(OWNER, "claude-code", AUTH)
    assert pointer.status == "stored"
    assert pointer.source == pointer.agent == "claude-code"
    assert pointer.project == "github.com/acme/widget"
    assert pointer.head == grown["content_hash"]
    assert [t.content_hash for t in pointer.traces] == [
        first["content_hash"],
        grown["content_hash"],
    ]
    assert pointer.traces[0].continuation is None
    assert pointer.traces[1].continuation is not None
    assert pointer.traces[1].continuation.from_record == first["records"]
    assert pointer.traces[1].records == grown["records"]
    assert pointer.raw_format == "jsonl"
    assert [p.part for p in pointer.raw] == [0]
    assert pointer.raw[0].offset == 0 and pointer.raw[0].length > 0
    assert pointer.normalized is not None
    # The continuation's records repeat the meta record, so the session is one shorter.
    assert pointer.normalized.records == first["records"] + grown["records"] - 1
    assert pointer.normalized.prefix_sha256
    assert db.get_metadata(pointer.archive_id) == pointer


def test_a_session_not_stored_is_none(db):
    assert db.get_session("claude-code", "nope") is None
    assert db.get_trace("claude-code", "nope") is None
    assert db.get_metadata("0" * 64) is None


def test_a_raw_only_session_has_a_pointer_and_no_trace(db):
    for session_id, fmt in ((RAW_ONLY, "jsonl"), (RAW_ONLY_JSON, "json")):
        agent = "claude-code" if fmt == "jsonl" else "opencode"
        pointer = db.get_session(agent, session_id)
        assert pointer is not None
        assert pointer.head is None
        assert pointer.source is None
        assert pointer.traces == []
        assert pointer.raw_format == fmt
        assert len(pointer.raw) == 1
        assert pointer.normalized is not None
        assert db.get_trace(agent, session_id) is None


def test_a_tombstoned_session_is_redacted(db, manifest):
    pointer = db.get_session("claude-code", REFACTOR)
    assert pointer is not None
    assert pointer.status == "redacted"
    assert pointer.head is None
    assert db.get_trace("claude-code", REFACTOR) is None
    gone = by_id(manifest, REFACTOR, note="tombstoned")
    # The object itself is gone: a reader following an old change entry gets None, not an error.
    assert db.read_trace(gone["archive_id"], gone["content_hash"]) is None


# --- traces -------------------------------------------------------------------------------------


def test_the_head_trace_reads_back(db, manifest):
    grown = by_id(manifest, AUTH, note="continuation")
    trace = db.get_trace("claude-code", AUTH)
    assert trace is not None
    assert trace.content_hash == grown["content_hash"]
    assert trace.source == "claude-code"
    assert trace.session_id == AUTH
    assert len(trace.records) == grown["records"]
    assert trace.records[0]["role"] == "meta"
    assert trace.events and trace.events[0].index == 0
    assert all(
        e.role
        in {"user", "assistant", "tool_call", "tool_result", "system", "observation", "reasoning"}
        for e in trace.events
    )
    assert trace.continuation is not None
    assert trace.continuation.from_record == by_id(manifest, AUTH)["records"]
    assert trace.metadata["normalizer"]["name"]


def test_a_trace_by_hash_and_the_whole_session(db, manifest):
    first = by_id(manifest, AUTH)
    trace = db.get_trace("claude-code", AUTH, first["content_hash"])
    assert trace is not None
    assert trace.content_hash == first["content_hash"]
    assert trace.continuation is None
    assert len(trace.records) == first["records"]
    pointer = db.get_session("claude-code", AUTH)
    assert pointer is not None
    whole = db.read_traces(pointer)
    assert [t.content_hash for t in whole] == [t.content_hash for t in pointer.traces]
    # Concatenated in order, the traces are the session: the continuation's records follow the
    # first's, and the first's records are the whole session's prefix.
    assert (
        len(whole[0].records) + len(whole[1].records) == pointer.normalized.records + 1
    )  # +1: meta repeats


def test_a_trace_that_is_not_gzip_is_a_layout_error(bucket, db, manifest):
    perf = by_id(manifest, PERF)
    key = db.keys.trace(perf["archive_id"], perf["content_hash"])
    bucket.put(key, b"not gzip")
    with pytest.raises(LayoutError, match="not gzip"):
        db.read_trace(perf["archive_id"], perf["content_hash"])


def test_a_trace_with_an_unknown_schema_is_refused(bucket, db, manifest):
    perf = by_id(manifest, PERF)
    key = db.keys.trace(perf["archive_id"], perf["content_hash"])
    body = json.loads(gzip.decompress(bucket.get(key)))
    body["schema"] = "sessionstorage/trace/2"
    bucket.put(key, gzip.compress(json.dumps(body).encode()))
    with pytest.raises(LayoutError, match="unknown schema"):
        db.read_trace(perf["archive_id"], perf["content_hash"])


def test_following_the_feed_reads_every_trace(db, manifest):
    """The consumer's loop: for each published entry, the pointer and the trace."""
    read = []
    for change in db.iter_changes():
        entry = change.entry
        if entry.kind != "published":
            continue
        pointer = db.get_metadata(entry.archive_id)
        assert pointer is not None
        trace = db.read_trace(entry.archive_id, entry.content_hash)
        if trace is None:
            assert pointer.status == "redacted"
            continue
        read.append((entry.session_id, trace.content_hash, len(trace.records)))
    assert read == [
        (s["session_id"], s["content_hash"], s["records"])
        for s in manifest["sessions"]
        if s["status"] == "stored" and s.get("note") != "tombstoned"
    ]


# --- connect ------------------------------------------------------------------------------------


def test_connect_over_a_store(bucket):
    db = connect(store=bucket, owner=OWNER)
    assert isinstance(db, StoreSessionDB)
    assert db.me().owner == OWNER
    with pytest.raises(ValueError, match="owner"):
        connect(store=bucket)  # type: ignore[call-overload]
    with pytest.raises(ValueError):
        connect()  # type: ignore[call-overload]
