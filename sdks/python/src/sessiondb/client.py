"""One client API, two backends.

``connect(store=..., owner=...)`` reads a store directly, with the caller's credential: the
change feed, pointers, traces. ``connect(server=..., token=...)`` talks to a sessiondb server
over HTTP, under the owner the token names, and can also store sessions: the server runs the
redaction and normalization pipeline against the bucket it owns. Reads look the same either
way, so a consumer (a poller, a backend) picks a backend from its configuration and is
otherwise indifferent.
"""

from __future__ import annotations

import gzip
import json
from collections.abc import Mapping
from datetime import datetime
from typing import TYPE_CHECKING, Any, Protocol, overload
from urllib.parse import quote

from pydantic import BaseModel, ValidationError

from sessiondb.errors import OffsetMismatch, SessionRejected, StoreError, Unauthorized
from sessiondb.layout import RawFormat
from sessiondb.models import (
    ChangesPage,
    Identity,
    IngestResult,
    SessionMetadata,
    SessionsPage,
    Shipped,
    StorageView,
    TombstoneResult,
    Trace,
)
from sessiondb.reader import StoreSessionDB
from sessiondb.store.base import ObjectStore
from sessiondb.version import VERSION

if TYPE_CHECKING:
    import httpx


class SessionReader(Protocol):
    """What both backends can do: read."""

    def me(self) -> Identity: ...
    def get_session(self, agent: str, session_id: str) -> SessionMetadata | None: ...
    def get_trace(self, agent: str, session_id: str, hash: str | None = None) -> Trace | None: ...
    def list_sessions(self, *, after: str | None = None, limit: int = ...) -> SessionsPage: ...
    def changes(
        self, *, after: str | None = None, since: datetime | None = None, limit: int = ...
    ) -> ChangesPage: ...


class ServerError(StoreError):
    """A response the server gave that is not one of the pipeline's own refusals: a bad
    request, an internal error, a route that is not there."""

    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.status = status
        self.code = code


class ServerSessionDB:
    """The server's API over ``httpx``. Every refusal the server maps to a status comes back as
    the error the pipeline would have raised. Needs the ``server`` extra."""

    def __init__(
        self,
        server: str,
        token: str,
        *,
        timeout: float | None = 120,
        gzip_from: int = 8 * 1024,
        user_agent: str | None = None,
        client: httpx.Client | None = None,
    ) -> None:
        """``timeout`` is per request; a large transcript can take the server a while to
        normalize and verify (120 s is the server's own idle timeout). Bodies past
        ``gzip_from`` bytes are sent ``Content-Encoding: gzip``. ``user_agent`` names the
        program in the server's logs. Pass ``client`` to bring a configured ``httpx.Client``
        (a test transport, a proxy)."""
        try:
            import httpx
        except ImportError as e:  # pragma: no cover - import guard
            raise StoreError(
                "connect(server=...) needs httpx: pip install 'dosu-sessiondb[server]'", cause=e
            ) from e
        self.server = server.rstrip("/")
        self._token = token
        self._gzip_from = gzip_from
        self._headers = {
            "authorization": f"Bearer {token}",
            "user-agent": user_agent or f"dosu-sessiondb/{VERSION}",
        }
        self._client = client or httpx.Client(timeout=timeout)

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> ServerSessionDB:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    # --- transport ------------------------------------------------------------------------

    def _request(
        self,
        method: str,
        path: str,
        *,
        body: Mapping[str, Any] | None = None,
        query: Mapping[str, str | int | None] | None = None,
    ) -> tuple[int, Any]:
        headers = dict(self._headers)
        content: bytes | None = None
        if body is not None:
            headers["content-type"] = "application/json"
            content = json.dumps(body, separators=(",", ":")).encode()
            if len(content) >= self._gzip_from:
                headers["content-encoding"] = "gzip"
                content = gzip.compress(content)
        params = {k: str(v) for k, v in (query or {}).items() if v is not None}
        try:
            response = self._client.request(
                method, f"{self.server}{path}", headers=headers, content=content, params=params
            )
        except Exception as e:
            raise StoreError(f"cannot reach {self.server}: {e}", cause=e) from e
        parsed: Any = None
        if response.content:
            try:
                parsed = response.json()
            except ValueError:
                # A proxy's own error page is a refusal with no envelope, reported by status
                # alone; a 2xx that is not JSON is not the server at all.
                if response.is_success:
                    raise ServerError(
                        response.status_code, "bad_response", f"not JSON: {response.text[:200]}"
                    ) from None
        return response.status_code, parsed

    @staticmethod
    def _refuse(status: int, body: Any, offset: int = 0) -> None:
        error = (body or {}).get("error") or {} if isinstance(body, dict) else {}
        code = error.get("code") or "unknown"
        message = error.get("message") or f"HTTP {status}"
        if status == 409 and code == "offset_mismatch":
            raise OffsetMismatch(int(error.get("expected") or 0), offset, message)
        if status == 422:
            raise SessionRejected(code, message)
        if status == 401:
            raise Unauthorized(message)
        if status == 502:
            raise StoreError(message)
        raise ServerError(status, code, message)

    @staticmethod
    def _parse[M: BaseModel](model: type[M], body: Any) -> M:
        try:
            return model.model_validate(body)
        except ValidationError as e:
            detail = e.errors()[0]["msg"]
            raise ServerError(200, "bad_response", f"unexpected shape: {detail}") from e

    @staticmethod
    def _session_path(agent: str, session_id: str) -> str:
        return f"/v1/sessions/{quote(agent, safe='')}/{quote(session_id, safe='')}"

    # --- the API --------------------------------------------------------------------------

    def me(self) -> Identity:
        status, body = self._request("GET", "/v1/me")
        if status != 200:
            self._refuse(status, body)
        return self._parse(Identity, body)

    def ingest(
        self,
        *,
        agent: str,
        session_id: str,
        transcript: str,
        format: RawFormat = "jsonl",
        offset: int = 0,
        project: str | None = None,
        branch: str | None = None,
        parent_session_id: str | None = None,
        fork_of: str | None = None,
        shipped: Shipped | None = None,
    ) -> IngestResult:
        """Store a session, whole (``offset`` 0) or as a chunk from ``offset``. Raises
        ``SessionRejected`` for a transcript that cannot be stored, ``OffsetMismatch`` for a
        chunk that does not start where the log ends, ``StoreError`` when the bucket or the
        server fails."""
        upload: dict[str, Any] = {
            "agent": agent,
            "session_id": session_id,
            "transcript": transcript,
            "format": format,
            "offset": offset,
        }
        for key, value in (
            ("project", project),
            ("branch", branch),
            ("parent_session_id", parent_session_id),
            ("fork_of", fork_of),
        ):
            if value is not None:
                upload[key] = value
        if shipped is not None:
            upload["shipped"] = shipped.model_dump()
        status, body = self._request("POST", "/v1/sessions", body=upload)
        if status not in (200, 201):
            self._refuse(status, body, offset)
        return self._parse(IngestResult, body)

    def get_session(self, agent: str, session_id: str) -> SessionMetadata | None:
        status, body = self._request("GET", self._session_path(agent, session_id))
        if status == 404:
            return None
        if status != 200:
            self._refuse(status, body)
        return self._parse(SessionMetadata, body)

    def get_trace(self, agent: str, session_id: str, hash: str | None = None) -> Trace | None:
        status, body = self._request(
            "GET", f"{self._session_path(agent, session_id)}/trace", query={"hash": hash}
        )
        if status in (404, 410):
            return None
        if status != 200:
            self._refuse(status, body)
        return self._parse(Trace, body)

    def list_sessions(self, *, after: str | None = None, limit: int = 100) -> SessionsPage:
        status, body = self._request("GET", "/v1/sessions", query={"after": after, "limit": limit})
        if status != 200:
            self._refuse(status, body)
        return self._parse(SessionsPage, body)

    def tombstone(self, agent: str, session_id: str) -> TombstoneResult | None:
        """Drop the session's objects and append a tombstone; None for one not stored."""
        status, body = self._request("DELETE", self._session_path(agent, session_id))
        if status == 404:
            return None
        if status != 200:
            self._refuse(status, body)
        return self._parse(TombstoneResult, body)

    def changes(
        self,
        *,
        after: str | None = None,
        since: datetime | None = None,
        limit: int = 100,
    ) -> ChangesPage:
        status, body = self._request(
            "GET",
            "/v1/changes",
            query={
                "after": after,
                "since": since.isoformat() if since is not None else None,
                "limit": limit,
            },
        )
        if status != 200:
            self._refuse(status, body)
        return self._parse(ChangesPage, body)


# --- choosing ---------------------------------------------------------------------------------


@overload
def connect(
    *, store: ObjectStore, owner: str, storage: StorageView | None = None
) -> StoreSessionDB: ...


@overload
def connect(*, server: str, token: str, **options: Any) -> ServerSessionDB: ...


def connect(
    *,
    store: ObjectStore | None = None,
    owner: str | None = None,
    storage: StorageView | None = None,
    server: str | None = None,
    token: str | None = None,
    **options: Any,
) -> StoreSessionDB | ServerSessionDB:
    """A reader over a store (``store`` and ``owner``), or a client of a server (``server``
    and ``token``)."""
    if store is not None:
        if owner is None:
            raise ValueError("connect(store=...) needs owner=")
        return StoreSessionDB(store, owner, storage=storage)
    if server is not None:
        if token is None:
            raise ValueError("connect(server=...) needs token=")
        return ServerSessionDB(server, token, **options)
    raise ValueError("connect() needs store= and owner=, or server= and token=")
