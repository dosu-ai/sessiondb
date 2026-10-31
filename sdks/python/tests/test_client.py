"""The server client, against a fake server that answers the way ``spec/openapi.yaml`` says.
The fake serves the golden bucket through the store reader, so a session read over HTTP is the
session read from the store."""

import gzip
import json
from datetime import UTC, datetime

import httpx
import pytest

from sessiondb import (
    OffsetMismatch,
    ServerError,
    ServerSessionDB,
    SessionRejected,
    StoreError,
    StoreSessionDB,
    Unauthorized,
    connect,
)
from tests.conftest import AUTH, OWNER, PERF, REFACTOR

TOKEN = "t0ken-t0ken-t0ken-t0ken"


class FakeServer:
    """Enough of the server's routes to exercise the client, over the golden bucket."""

    def __init__(self, db: StoreSessionDB) -> None:
        self.db = db
        self.requests: list[httpx.Request] = []
        self.uploads: list[dict] = []

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handle)

    @staticmethod
    def error(status: int, code: str, message: str, **extra) -> httpx.Response:
        return httpx.Response(status, json={"error": {"code": code, "message": message, **extra}})

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if request.headers.get("authorization") != f"Bearer {TOKEN}":
            return self.error(401, "unauthorized", "a valid token is required")
        path, params = request.url.path, request.url.params
        if path == "/v1/me":
            return httpx.Response(200, json=self.db.me().model_dump(mode="json", by_alias=True))
        if path == "/v1/changes":
            since = params.get("since")
            page = self.db.changes(
                after=params.get("after"),
                since=datetime.fromisoformat(since) if since else None,
                limit=int(params.get("limit", 100)),
            )
            return httpx.Response(200, json=page.model_dump(mode="json", by_alias=True))
        if path == "/v1/sessions" and request.method == "GET":
            page = self.db.list_sessions(
                after=params.get("after"), limit=int(params.get("limit", 100))
            )
            return httpx.Response(200, json=page.model_dump(mode="json", by_alias=True))
        if path == "/v1/sessions" and request.method == "POST":
            body = request.content
            if request.headers.get("content-encoding") == "gzip":
                body = gzip.decompress(body)
            upload = json.loads(body)
            self.uploads.append(upload)
            if upload["agent"] == "unknown-agent":
                return self.error(422, "unsupported_agent", "no normalizer for unknown-agent")
            if upload.get("offset", 0) == 999:
                return self.error(409, "offset_mismatch", "the log ends at 480", expected=480)
            if upload["session_id"] == "bucket-down":
                return self.error(502, "storage_error", "bucket unreachable")
            if upload["transcript"] == "hi":
                return httpx.Response(
                    200,
                    json={
                        "status": "trivial",
                        "records_total": 2,
                        "prefix_sha256": "a" * 64,
                        "bytes_total": 2,
                        "raw": {"status": "stored", "part": 0},
                    },
                )
            return httpx.Response(
                201,
                json={
                    "status": "stored",
                    "archive_id": "b" * 64,
                    "content_hash": "c" * 64,
                    "session_id": upload["session_id"],
                    "records": 9,
                    "events": 12,
                    "records_total": 9,
                    "prefix_sha256": "d" * 64,
                    "bytes_total": len(upload["transcript"]),
                    "raw": {"status": "stored", "part": 0},
                },
            )
        parts = path.split("/")
        if len(parts) >= 5 and parts[1:3] == ["v1", "sessions"]:
            agent, session_id = parts[3], parts[4]
            pointer = self.db.get_session(agent, session_id)
            if len(parts) == 5 and request.method == "GET":
                if pointer is None:
                    return self.error(404, "not_found", "no such session")
                return httpx.Response(200, json=pointer.model_dump(mode="json", by_alias=True))
            if len(parts) == 5 and request.method == "DELETE":
                if pointer is None:
                    return self.error(404, "not_found", "no such session")
                return httpx.Response(200, json={"removed": 2})
            if len(parts) == 6 and parts[5] == "trace":
                if pointer is None:
                    return self.error(404, "not_found", "no such session")
                if pointer.status == "redacted":
                    return self.error(410, "redacted", "the session was tombstoned")
                trace = self.db.get_trace(agent, session_id, params.get("hash"))
                if trace is None:
                    return self.error(404, "no_trace", "nothing worth a trace yet")
                return httpx.Response(200, json=trace.model_dump(mode="json", by_alias=True))
        if path == "/v1/boom":
            return httpx.Response(500, text="<html>upstream exploded</html>")
        if path == "/v1/not-json":
            return httpx.Response(200, text="ok")
        return self.error(404, "not_found", f"no route {path}")


@pytest.fixture
def server(db):
    return FakeServer(db)


@pytest.fixture
def client(server):
    return ServerSessionDB(
        "https://sessiondb.example.com/",
        TOKEN,
        client=httpx.Client(transport=server.transport()),
    )


def test_connect_picks_the_server_backend(server):
    db = connect(
        server="https://sessiondb.example.com",
        token=TOKEN,
        client=httpx.Client(transport=server.transport()),
    )
    assert isinstance(db, ServerSessionDB)
    assert db.server == "https://sessiondb.example.com"
    with pytest.raises(ValueError, match="token"):
        connect(server="https://x")  # type: ignore[call-overload]


def test_me_and_the_bearer_token(client, server):
    me = client.me()
    assert me.owner == OWNER
    assert me.storage.url.startswith("file://")
    request = server.requests[-1]
    assert request.headers["authorization"] == f"Bearer {TOKEN}"
    assert request.headers["user-agent"].startswith("dosu-sessiondb/")


def test_a_bad_token_is_unauthorized(server):
    bad = ServerSessionDB("https://x", "wrong", client=httpx.Client(transport=server.transport()))
    with pytest.raises(Unauthorized):
        bad.me()


def test_reads_over_http_equal_reads_from_the_store(client, db):
    assert client.changes() == db.changes()
    assert client.list_sessions() == db.list_sessions()
    assert client.get_session("claude-code", AUTH) == db.get_session("claude-code", AUTH)
    assert client.get_trace("claude-code", AUTH) == db.get_trace("claude-code", AUTH)
    first = db.get_session("claude-code", AUTH).traces[0].content_hash
    assert client.get_trace("claude-code", AUTH, first) == db.get_trace("claude-code", AUTH, first)


def test_changes_passes_the_cursor_and_the_window(client, server, db):
    everything = db.changes().entries
    page = client.changes(after=everything[1].key, limit=2)
    assert [c.key for c in page.entries] == [c.key for c in everything[2:4]]
    assert page.truncated
    assert server.requests[-1].url.params["after"] == everything[1].key
    assert server.requests[-1].url.params["limit"] == "2"
    since = client.changes(since=everything[3].entry.at)
    assert [c.key for c in since.entries] == [c.key for c in everything[3:]]
    assert server.requests[-1].url.params["since"] == everything[3].entry.at.isoformat()


def test_absent_sessions_and_traces_are_none(client):
    assert client.get_session("claude-code", "nope") is None
    assert client.get_trace("claude-code", "nope") is None
    # Tombstoned: 410.
    assert client.get_trace("claude-code", REFACTOR) is None
    assert client.tombstone("claude-code", "nope") is None


def test_session_ids_are_escaped_in_the_path(client, server):
    client.get_session("claude-code", "a/b c?d")
    assert (
        server.requests[-1]
        .url.raw_path.decode()
        .startswith("/v1/sessions/claude-code/a%2Fb%20c%3Fd")
    )


def test_tombstone(client):
    result = client.tombstone("claude-code", PERF)
    assert result is not None and result.removed == 2


def test_ingest_a_whole_session(client, server):
    result = client.ingest(
        agent="claude-code",
        session_id="s1",
        transcript='{"type":"user"}\n' * 10,
        project="github.com/acme/widget",
        branch="main",
    )
    assert result.status == "stored"
    assert result.content_hash == "c" * 64
    assert result.records == 9
    assert result.shipped.records == 9
    assert result.shipped.prefix_sha256 == "d" * 64
    upload = server.uploads[-1]
    assert upload == {
        "agent": "claude-code",
        "session_id": "s1",
        "transcript": '{"type":"user"}\n' * 10,
        "format": "jsonl",
        "offset": 0,
        "project": "github.com/acme/widget",
        "branch": "main",
    }
    assert server.requests[-1].headers["content-type"] == "application/json"
    assert "content-encoding" not in server.requests[-1].headers


def test_ingest_again_with_shipped_and_gzips_a_large_body(client, server):
    first = client.ingest(agent="claude-code", session_id="s1", transcript="x" * 10)
    big = "y" * 20_000
    result = client.ingest(
        agent="claude-code", session_id="s1", transcript=big, shipped=first.shipped
    )
    assert result.status == "stored"
    assert server.uploads[-1]["shipped"] == {"records": 9, "prefix_sha256": "d" * 64}
    assert server.requests[-1].headers["content-encoding"] == "gzip"


def test_a_trivial_upload(client):
    result = client.ingest(agent="claude-code", session_id="s2", transcript="hi")
    assert result.status == "trivial"
    assert result.content_hash is None
    assert result.raw.part == 0


def test_the_server_refusals_are_the_pipeline_errors(client):
    with pytest.raises(SessionRejected) as rejected:
        client.ingest(agent="unknown-agent", session_id="s", transcript="x")
    assert rejected.value.code == "unsupported_agent"
    with pytest.raises(OffsetMismatch) as mismatch:
        client.ingest(agent="claude-code", session_id="s", transcript="x", offset=999)
    assert mismatch.value.expected == 480
    assert mismatch.value.got == 999
    with pytest.raises(StoreError, match="bucket unreachable"):
        client.ingest(agent="claude-code", session_id="bucket-down", transcript="x")


def test_other_failures_are_server_errors(client):
    # A proxy's HTML error page: no envelope, so the status alone names it.
    status, body = client._request("GET", "/v1/boom")
    assert (status, body) == (500, None)
    with pytest.raises(ServerError) as boom:
        ServerSessionDB._refuse(status, body)
    assert boom.value.status == 500
    assert boom.value.code == "unknown"
    with pytest.raises(ServerError, match="not JSON"):
        client._request("GET", "/v1/not-json")


def test_an_unreachable_server_is_a_store_error():
    def down(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused")

    client = ServerSessionDB(
        "https://x", TOKEN, client=httpx.Client(transport=httpx.MockTransport(down))
    )
    with pytest.raises(StoreError, match="cannot reach https://x"):
        client.me()


def test_context_manager_closes(server):
    with ServerSessionDB(
        "https://x", TOKEN, client=httpx.Client(transport=server.transport())
    ) as c:
        assert c.me().owner == OWNER
    assert c._client.is_closed


def test_since_is_sent_as_rfc3339(client, server):
    client.changes(since=datetime(2026, 10, 21, 21, 4, 9, tzinfo=UTC))
    assert server.requests[-1].url.params["since"] == "2026-10-21T21:04:09+00:00"
