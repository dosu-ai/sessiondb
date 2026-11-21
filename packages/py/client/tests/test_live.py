"""The client against a real seshi server started from this repository (conftest.py): a folder
store, static tokens for alice and bob, the admin token and the org key `seshi admin init`
printed, search on, and an operator rule pack. Every call the client makes is made here once."""

from __future__ import annotations

import hashlib
import time
import uuid
from collections.abc import Callable, Iterator
from typing import TypeVar

import pytest

from seshi import (
    AllChangesPage,
    AsyncSeshiClient,
    ConfigRejected,
    Forbidden,
    LettaTrace,
    NotWritten,
    OffsetMismatch,
    OtlpTrace,
    PreconditionFailed,
    ServerError,
    SeshiClient,
    SessionConflict,
    SessionRejected,
    Stored,
    Trace,
    Upload,
    __version__,
    auth_config,
)
from seshi.models import AtifDocument

from .conftest import LiveServer
from .transcripts import record, transcript

pytestmark = pytest.mark.live
T = TypeVar("T")


def new_id() -> str:
    return str(uuid.uuid4())


def eventually(probe: Callable[[], T | None], what: str, seconds: float = 60) -> T:
    """`probe()` until it answers, for what the server builds in the background (the search
    index), retrying while that is not ready (`503 index_building`)."""
    deadline = time.monotonic() + seconds
    while True:
        try:
            found = probe()
            if found is not None:
                return found
        except ServerError as err:
            if err.status != 503:
                raise
        if time.monotonic() > deadline:
            pytest.fail(f"timed out waiting for {what}")
        time.sleep(0.5)


def stored(answer: Stored | NotWritten) -> Stored:
    assert isinstance(answer, Stored), f"expected a trace, got {answer.status}"
    return answer


@pytest.fixture
def alice(live_server: LiveServer) -> Iterator[SeshiClient]:
    with SeshiClient(live_server.url, live_server.alice) as client:
        yield client


@pytest.fixture
def admin(live_server: LiveServer) -> Iterator[SeshiClient]:
    with SeshiClient(live_server.url, live_server.admin_token) as client:
        yield client


def test_health_and_the_ways_in(live_server: LiveServer) -> None:
    with SeshiClient(live_server.url) as anonymous:
        health = anonymous.health()
        assert health.ok
        assert health.version == __version__
        config = anonymous.auth_config()
        assert config.org_key
        assert config.oidc is None
        with pytest.raises(ServerError) as raised:
            anonymous.exchange_id_token({"id_token": "not-a-jwt"})
        assert (raised.value.status, raised.value.code) == (404, "no_idp")
        with pytest.raises(ServerError) as raised:
            anonymous.me()
        assert raised.value.status == 401
    assert auth_config(live_server.url).delete_fresh_seconds > 0


def test_who_each_credential_is(live_server: LiveServer, alice: SeshiClient) -> None:
    me = alice.me()
    assert (me.owner, me.kind, me.owner_basis) == ("alice", "static", "verified")
    assert me.storage.url.startswith("file://")
    with SeshiClient(live_server.url, live_server.org_key, user="Erin@Example.com") as erin:
        who = erin.me()
        assert (who.owner, who.owner_basis) == ("erin@example.com", "claimed")
    with SeshiClient(live_server.url, "seshi_nope_0123456789abcdef") as stranger:
        with pytest.raises(ServerError) as raised:
            stranger.me()
        assert (raised.value.status, raised.value.code) == (401, "unauthorized")


def test_a_session_from_upload_to_tombstone(alice: SeshiClient) -> None:
    sid = new_id()
    log = transcript(sid)
    first = stored(alice.ingest(Upload(format="claude-code", session_id=sid, transcript=log)))
    assert first.status == "stored"
    assert first.bytes_total == len(log.encode())

    # A resend gets the answer its idempotency key got; under another key, nothing is new.
    again = alice.ingest(Upload(format="claude-code", session_id=sid, transcript=log))
    assert again == first
    other_key = alice.ingest(
        Upload(format="claude-code", session_id=sid, transcript=log), idempotency_key=new_id()
    )
    assert other_key.status == "unchanged"

    tail = transcript(sid, turns=1, start=1)
    second = stored(
        alice.ingest(
            Upload(format="claude-code", session_id=sid, transcript=tail, offset=first.bytes_total)
        )
    )
    assert second.records_total > first.records_total
    assert second.bytes_total == len((log + tail).encode())

    meta = alice.get_session("claude-code", sid)
    assert meta is not None
    assert meta.head == second.content_hash
    assert [t.content_hash for t in meta.traces] == [first.content_hash, second.content_hash]
    assert meta.writer.kind == "static"

    trace = alice.get_trace("claude-code", sid)
    assert isinstance(trace, Trace)
    assert trace.content_hash == second.content_hash
    assert trace.records[0].role == "meta"
    assert trace.metadata.continuation is not None
    head = alice.get_trace("claude-code", sid, hash=first.content_hash)
    assert head is not None
    assert head.content_hash == first.content_hash
    assert isinstance(alice.get_trace("claude-code", sid, render="letta"), LettaTrace)
    otlp = alice.get_trace("claude-code", sid, render="otlp")
    assert isinstance(otlp, OtlpTrace)
    assert otlp.resource_spans[0].scope_spans[0].spans
    assert isinstance(alice.get_trace("claude-code", sid, render="atif"), AtifDocument)

    assert sid in {s.session_id for s in alice.iter_sessions(limit=1)}
    page = alice.list_sessions(limit=1000)
    assert sid in {s.session_id for s in page.sessions}
    assert alice.reviews("claude-code", sid) == []

    changed = alice.set_visibility("claude-code", sid, "owner")
    assert changed is not None
    assert changed.visibility == "owner"
    kinds = [c.entry.kind for c in alice.iter_changes(limit=2) if c.entry.session_id == sid]
    assert kinds == ["published", "published", "visibility_changed"]

    removed = alice.tombstone("claude-code", sid)
    assert removed is not None
    assert removed.removed > 0
    gone = alice.get_session("claude-code", sid)
    assert gone is not None
    assert gone.status == "redacted"
    assert alice.get_trace("claude-code", sid) is None
    with pytest.raises(SessionRejected) as raised:
        alice.ingest(Upload(format="claude-code", session_id=sid, transcript=log))
    assert raised.value.code == "redacted"


def test_what_is_not_there(alice: SeshiClient) -> None:
    assert alice.get_session("claude-code", "never-stored") is None
    assert alice.get_trace("claude-code", "never-stored") is None
    assert alice.reviews("claude-code", "never-stored") is None
    assert alice.set_visibility("claude-code", "never-stored", "org") is None
    assert alice.tombstone("claude-code", "never-stored") is None


def test_the_server_refuses_as_the_pipeline_would(alice: SeshiClient) -> None:
    sid = new_id()
    with pytest.raises(OffsetMismatch) as mismatch:
        alice.ingest(Upload(format="claude-code", session_id=sid, transcript="{}\n", offset=10))
    assert (mismatch.value.offset, mismatch.value.expected) == (10, 0)

    short = alice.ingest(
        Upload(format="claude-code", session_id=sid, transcript=record("user", sid, "u", 0, "hi"))
    )
    assert isinstance(short, NotWritten)
    assert (short.status, short.bytes_total) == ("filtered", 0)

    stored(alice.ingest(Upload(format="claude-code", session_id=sid, transcript=transcript(sid))))
    other = transcript(sid, topic="billing")
    with pytest.raises(SessionConflict):
        alice.ingest(Upload(format="claude-code", session_id=sid, transcript=other))
    replaced = alice.ingest(
        Upload(format="claude-code", session_id=sid, transcript=other, replace=True)
    )
    assert replaced.status == "stored"

    with pytest.raises(SessionRejected) as rejected:
        alice.ingest(
            Upload(
                format="claude-code",
                session_id=sid,
                transcript=transcript(sid, start=1),
                offset=replaced.bytes_total,
                rebuild=True,
            )
        )
    assert rejected.value.code == "bad_chunk"


def test_a_large_upload_is_sent_gzipped(live_server: LiveServer) -> None:
    sid = new_id()
    log = transcript(sid, turns=6)
    assert len(log) > 8 * 1024
    with SeshiClient(live_server.url, live_server.alice, gzip_from=1024) as client:
        answer = stored(client.ingest(Upload(format="claude-code", session_id=sid, transcript=log)))
    assert answer.bytes_total == len(log.encode())


def test_another_owners_sessions(live_server: LiveServer, admin: SeshiClient) -> None:
    sid = new_id()
    with SeshiClient(live_server.url, live_server.bob) as bob:
        stored(bob.ingest(Upload(format="claude-code", session_id=sid, transcript=transcript(sid))))
        bob.set_visibility("claude-code", sid, "owner")
    meta = admin.get_session("claude-code", sid, owner="bob")
    assert meta is not None
    assert meta.owner == "bob"
    assert "bob" in admin.owners(limit=1000).owners
    assert sid in {s.session_id for s in admin.list_sessions(owner="bob").sessions}
    feed = admin.changes(owner="bob")
    assert sid in {c.entry.session_id for c in feed.entries}
    shared = admin.set_visibility("claude-code", sid, "org", owner="bob")
    assert shared is not None
    assert shared.visibility == "org"
    with SeshiClient(live_server.url, live_server.alice) as alice:
        assert alice.get_session("claude-code", sid, owner="bob") is not None
    assert admin.reviews("claude-code", sid, owner="bob") == []


def test_retraction_by_the_machine_that_uploaded(live_server: LiveServer) -> None:
    secret = "machine-secret-" + new_id()
    sid = new_id()
    with SeshiClient(live_server.url, live_server.org_key, user="frank@example.com") as frank:
        stored(
            frank.ingest(
                Upload(
                    format="claude-code",
                    session_id=sid,
                    transcript=transcript(sid),
                    retract_hash=hashlib.sha256(secret.encode()).hexdigest(),
                )
            )
        )
        with pytest.raises(ServerError) as raised:
            frank.tombstone("claude-code", sid, retract_secret="wrong")
        assert (raised.value.status, raised.value.code) == (403, "bad_retract_secret")
        removed = frank.tombstone("claude-code", sid, retract_secret=secret)
        assert removed is not None
        gone = frank.get_session("claude-code", sid)
        assert gone is not None
        assert gone.status == "redacted"


def test_tokens(live_server: LiveServer, admin: SeshiClient, alice: SeshiClient) -> None:
    created = admin.create_token({"kind": "device", "owner": "dana", "label": "laptop"})
    assert created.token.startswith("seshi_")
    assert (created.record.kind, created.record.owner) == ("device", "dana")
    assert created.record.id in {t.id for t in admin.list_tokens(owner="dana")}
    assert created.record.id in {t.id for t in admin.list_tokens(kind="device", all=True)}

    with SeshiClient(live_server.url, created.token) as dana:
        assert dana.me().kind == "device"
        # A device token reads its owner's own sessions (none yet), and no one else's (X5.10).
        assert dana.list_sessions().sessions == []
        with pytest.raises(Forbidden):
            dana.list_sessions(owner="alice")
    with pytest.raises(Forbidden):
        alice.create_token({"kind": "device", "owner": "alice"})

    revoked = admin.revoke_token(created.record.id)
    assert revoked is not None
    assert revoked.revoked
    assert admin.revoke_token("0000000000") is None
    assert created.record.id not in {t.id for t in admin.list_tokens(owner="dana")}

    service = admin.create_token({"kind": "service", "service": "reader"})
    assert service.record.owner == "svc:reader"
    assert [t.id for t in admin.revoke_owner_tokens("svc:reader")] == [service.record.id]


def test_search_and_every_owners_feed(live_server: LiveServer, admin: SeshiClient) -> None:
    sid = new_id()
    word = "zanzibar" + uuid.uuid4().hex[:8]
    with SeshiClient(live_server.url, live_server.alice) as alice:
        log = transcript(sid, topic=word)
        upload = Upload(
            format="claude-code", session_id=sid, transcript=log, repo="github.com/acme/widget"
        )
        stored(alice.ingest(upload))

        def found() -> str | None:
            results = alice.search(word, repo="widget", sort="recent", matches=1)
            hits = [r for r in results.results if r.session_id == sid]
            return hits[0].matches[0].snippet if hits else None

        snippet = eventually(found, "the session to be searchable")
        assert word in snippet.lower()

        with pytest.raises(ServerError) as raised:
            alice.search("")
        assert (raised.value.status, raised.value.code) == (400, "bad_query")
        with pytest.raises(Forbidden):
            alice.all_changes()

    # The feed serves entries stamped before the indexer last listed the owners, which it does
    # once a minute, so a session just stored may not be in it yet. The one conftest.py stored
    # before the server last started is.
    def feed() -> AllChangesPage | None:
        page = admin.all_changes(limit=1)
        return page if page.entries else None

    page = eventually(feed, "every owner's feed to be served")
    assert page.through
    entries = list(admin.iter_all_changes(limit=2))
    assert entries[0] == page.entries[0]
    assert len({e.key for e in entries}) == len(entries)
    assert all(e.key.startswith(f"owners/{e.owner}/changes/") for e in entries)
    assert {e.owner for e in entries} <= set(admin.owners(limit=1000).owners)
    assert (entries[0].owner, entries[0].entry.session_id) == ("alice", live_server.seed_session)
    # Every entry names its session's format, the one written before 0.16 too (filled in).
    assert all(e.entry.format == "claude-code" for e in entries)
    assert live_server.legacy_session in {e.entry.session_id for e in entries}
    if page.truncated:
        assert page.cursor is not None
        assert admin.all_changes(after=page.cursor, limit=1).entries[0] == entries[1]


def test_a_session_stored_before_format_was_named_reads_back(
    alice: SeshiClient, live_server: LiveServer
) -> None:
    sid = live_server.legacy_session
    metadata = alice.get_session("claude-code", sid)
    assert metadata is not None and metadata.format == "claude-code"
    assert "agent" not in (metadata.model_extra or {})
    # The archive id is what it was: the same owner, format and session hash to the same id.
    archive = hashlib.sha256(f"alice\nclaude-code\n{sid}".encode()).hexdigest()
    assert metadata.archive_id == archive
    trace = alice.get_trace("claude-code", sid)
    assert isinstance(trace, Trace) and trace.format == "claude-code"
    assert "agent" not in (trace.model_extra or {})
    entries = [c.entry for c in alice.iter_changes() if c.entry.session_id == sid]
    assert entries and all(e.format == "claude-code" for e in entries)
    # By the owner and archive id an entry names, the same session.
    assert alice.get_session_by_archive("alice", archive) == metadata
    by_archive = alice.get_trace_by_archive("alice", archive)
    assert isinstance(by_archive, Trace) and by_archive.content_hash == trace.content_hash
    assert isinstance(alice.get_trace_by_archive("alice", archive, render="otlp"), OtlpTrace)
    assert alice.reviews_by_archive("alice", archive) == []
    assert alice.get_session_by_archive("alice", "0" * 64) is None


def test_redaction_rules(alice: SeshiClient) -> None:
    rules = alice.redaction_rules()
    assert [p.id for p in rules.packs] == ["py-client"]
    assert rules.packs[0].rules[0].id == "py-secret"
    first = alice.redaction_rules_since()
    assert first is not None
    assert first.etag is not None
    assert first.document.rule_set == rules.rule_set
    assert alice.redaction_rules_since(first.etag) is None


def test_capture_rules(alice: SeshiClient) -> None:
    rules = alice.capture_rules()
    assert rules.exclude == []
    first = alice.capture_rules_since()
    assert first is not None
    assert first.etag is not None
    assert alice.capture_rules_since(first.etag) is None


def test_admin_status(admin: SeshiClient, alice: SeshiClient) -> None:
    jobs = admin.jobs()
    assert "api" in jobs.instance.roles
    sources = admin.sources(days=3)
    assert "upload" in {s.id for s in sources}
    upload = admin.source("upload")
    assert upload is not None
    assert upload.type == "upload"
    assert admin.source("no-such-source") is None
    page = admin.records("failed", "upload", limit=5)
    assert page is not None
    assert page.kind == "failed"
    assert admin.records("dropped", "no-such-source") is None
    with pytest.raises(Forbidden):
        alice.jobs()
    assert alice.stale_sessions().sessions == []


def test_reload(live_server: LiveServer, admin: SeshiClient) -> None:
    status = admin.config_status()
    assert status.reloadable
    unchanged = admin.reload()
    assert unchanged.reload.outcome == "unchanged"
    assert unchanged.config.generation == status.generation

    good = live_server.pack.read_text()
    live_server.pack.write_text(good.replace("PYSECRET-[0-9]{6}", "PYSECRET-("))
    try:
        rejected = admin.reload()
        assert rejected.reload.outcome == "rejected"
        assert rejected.reload.errors
        assert rejected.config.generation == status.generation
    finally:
        live_server.pack.write_text(good)
    assert admin.reload().reload.outcome == "unchanged"
    last = admin.config_status().last_reload
    assert last is not None
    assert last.trigger == "api"


def test_runtime_config(admin: SeshiClient, alice: SeshiClient) -> None:
    status = admin.runtime_config()
    assert status.runtime_config == "store"
    assert status.doc is not None

    # A member's Cursor key: sealed in the bucket, never shown again.
    created = admin.put_source(
        "cursor-py",
        {"type": "cursor-cloud", "enabled": False, "api_key": "key_py_cursor_secret"},
        create=True,
    )
    assert created.source["api_key"]["set"] is True
    assert "key_py_cursor_secret" not in created.model_dump_json()
    with pytest.raises(PreconditionFailed):
        admin.put_source("cursor-py", {"type": "otlp"}, create=True)
    detail = admin.source("cursor-py")
    assert detail is not None
    assert (detail.managed, detail.running, detail.etag) == ("store", True, created.etag)
    kept = admin.put_source("cursor-py", {"type": "cursor-cloud"}, if_match=created.etag)
    assert kept.source["api_key"]["fingerprint"] == created.source["api_key"]["fingerprint"]
    with pytest.raises(ConfigRejected) as rejected:
        admin.put_source("bad-py", {"type": "nope"})
    assert rejected.value.problems

    # The org's lists, and a pack the doc names.
    doc_etag = status.doc.etag
    written = admin.patch_runtime_config(
        set={"capture.exclude": ["acme/py-secret"]},
        **({"if_match": doc_etag} if doc_etag else {"create": True}),
    )
    assert "acme/py-secret" in alice.capture_rules().exclude
    with pytest.raises(PreconditionFailed):
        admin.patch_runtime_config(set={"filter.min_chars": 3}, if_match="stale")
    assert admin.put_config_file("packs/py.json", '{"patterns": ["PYRT-[0-9]{4}"]}').name
    admin.patch_runtime_config(set={"redaction.packs": ["packs/py.json"]}, if_match=written.etag)
    with pytest.raises(ServerError) as in_use:
        admin.delete_config_file("packs/py.json")
    assert in_use.value.code == "in_use"
    admin.patch_runtime_config(unset=["redaction.packs", "capture.exclude"])
    assert admin.delete_config_file("packs/py.json") is not None
    assert admin.delete_config_file("packs/py.json") is None

    assert admin.reseal_secrets().current == ["cursor-py"]
    assert admin.runtime_config(wait="5s").converged
    deleted = admin.delete_source("cursor-py")
    assert deleted is not None and deleted.deleted
    assert admin.delete_source("cursor-py") is None
    with pytest.raises(Forbidden):
        alice.runtime_config()


@pytest.mark.anyio
async def test_the_async_client(live_server: LiveServer) -> None:
    sid = new_id()
    async with AsyncSeshiClient(live_server.url, live_server.alice) as db:
        assert (await db.health()).ok
        assert (await db.me()).owner == "alice"
        log = transcript(sid)
        answer = stored(
            await db.ingest(Upload(format="claude-code", session_id=sid, transcript=log))
        )
        with pytest.raises(OffsetMismatch) as raised:
            await db.ingest(Upload(format="claude-code", session_id=sid, transcript=log, offset=3))
        assert raised.value.expected == answer.bytes_total
        trace = await db.get_trace("claude-code", sid)
        assert trace is not None
        assert trace.content_hash == answer.content_hash
        keys = [c.key async for c in db.iter_changes(limit=3) if c.entry.session_id == sid]
        assert len(keys) == 1
        sessions = [s.session_id async for s in db.iter_sessions(limit=2)]
        assert sid in sessions
