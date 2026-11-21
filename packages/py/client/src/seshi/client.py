"""`SeshiClient` and `AsyncSeshiClient`: the seshi API over httpx.

Both take the same options and have the same calls; the async one's are coroutines, and its
`iter_*` helpers async iterators. Every refusal the server maps to a status comes back as the
error the pipeline would have raised (`seshi.errors`).
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Iterator, Mapping
from datetime import datetime
from types import TracebackType
from typing import Any, Literal, TypeVar, overload

import httpx

from . import _calls as calls
from . import models as m
from ._calls import DEFAULT_GZIP_FROM, DEFAULT_TIMEOUT, DEFAULT_USER_AGENT, Call, Settings

T = TypeVar("T")


def _search_request(
    q: str,
    *,
    owner: str | None,
    agent: str | None,
    repo: str | None,
    branch: str | None,
    harness: str | None,
    agent_version: str | None,
    model: str | None,
    labels: Mapping[str, str] | None,
    source: str | None,
    since: str | datetime | None,
    until: str | datetime | None,
    sort: m.SearchSort | None,
    limit: int | None,
    matches: int | None,
    cursor: str | None,
) -> m.SearchRequest:
    return m.SearchRequest(
        q=q,
        owner=owner,
        agent=agent,
        repo=repo,
        branch=branch,
        harness=harness,
        agent_version=agent_version,
        model=model,
        label=[f"{key}={value}" for key, value in labels.items()] if labels else None,
        source=source,
        since=calls.rfc3339(since) if isinstance(since, datetime) else since,
        until=calls.rfc3339(until) if isinstance(until, datetime) else until,
        sort=sort,
        limit=limit,
        matches=matches,
        cursor=cursor,
    )


class _Base:
    def __init__(
        self,
        server: str,
        token: str | None,
        *,
        user: str | None,
        timeout: float | None,
        user_agent: str | None,
        gzip_from: int,
    ) -> None:
        self.server = server.rstrip("/")
        self._settings = Settings(
            server=self.server,
            token=token,
            user=user,
            user_agent=user_agent or DEFAULT_USER_AGENT,
            gzip_from=gzip_from,
            timeout=timeout,
        )

    def __repr__(self) -> str:
        return f"{type(self).__name__}(server={self.server!r})"


class SeshiClient(_Base):
    """A seshi server's API.

    `token` is a device, service, admin, session or static token, or the org key (with `user`,
    the username to write as, sent as `X-Seshi-User`). Without one, only `health`,
    `auth_config` and `exchange_id_token` answer.

    `timeout` is per request, in seconds (default 120, the server's own idle timeout; 0 or
    None disables), with an `http_client` of your own too. Bodies of `gzip_from` bytes or more
    (default 8 KiB) are sent `Content-Encoding: gzip`. `user_agent` names your program in the
    server's logs (default `seshi-python/<version>`). Pass `http_client` to bring your own
    `httpx.Client` (it is not closed by `close()`), or `transport` for a custom or mock
    transport; not both.

    Use it as a context manager, or call `close()`, to release its connections.
    """

    def __init__(
        self,
        server: str,
        token: str | None = None,
        *,
        user: str | None = None,
        timeout: float | None = DEFAULT_TIMEOUT,
        user_agent: str | None = None,
        gzip_from: int = DEFAULT_GZIP_FROM,
        http_client: httpx.Client | None = None,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        super().__init__(
            server, token, user=user, timeout=timeout, user_agent=user_agent, gzip_from=gzip_from
        )
        if http_client is not None and transport is not None:
            raise ValueError("pass http_client or transport, not both")
        self._owns_client = http_client is None
        self._http = http_client or httpx.Client(transport=transport)

    def close(self) -> None:
        if self._owns_client:
            self._http.close()

    def __enter__(self) -> SeshiClient:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        self.close()

    def _run(self, call: Call[T]) -> T:
        request = calls.prepare(call, self._settings)
        try:
            response = self._http.send(request)
        except httpx.TransportError as err:
            raise calls.unreachable(self.server, err) from err
        return call.read(calls.read(response))

    # --- Before there is a token ----------------------------------------------------------

    def health(self) -> m.Health:
        """`GET /healthz`: the server is up, and its release."""
        return self._run(calls.health())

    def auth_config(self) -> m.AuthConfig:
        """`GET /v1/auth/config`: whether the server takes the org key and which IdP it signs in
        through (X5.7). Sends no credential."""
        return self._run(calls.auth_config())

    def exchange_id_token(self, request: m.ExchangeRequest | Mapping[str, Any]) -> m.ExchangeResult:
        """`POST /v1/auth/exchange`: an IdP ID token for a session token, and a device token when
        the request names a machine (X5.2). Sends no credential. A token the server does not
        accept is `ServerError` 401; a server without an IdP, 404 `no_idp`."""
        return self._run(calls.exchange(request))

    # --- Identity -------------------------------------------------------------------------

    def me(self) -> m.Identity:
        """`GET /v1/me`: who the credential is, and which bucket the server writes."""
        return self._run(calls.me())

    def owners(self, *, after: str | None = None, limit: int | None = None) -> m.OwnersPage:
        """`GET /v1/owners`: the owners with sessions stored, a page at a time."""
        return self._run(calls.owners(after, limit))

    # --- Sessions -------------------------------------------------------------------------

    def ingest(
        self,
        upload: m.Upload | Mapping[str, Any],
        *,
        retract_secret: str | None = None,
        idempotency_key: str | None = None,
    ) -> m.Stored | m.NotWritten:
        """`POST /v1/sessions`: store a session, whole or as a chunk from the last answer's
        `bytes_total`. `retract_secret` (for a `replace` with the org key) goes in
        `X-Seshi-Retract`, never the body; `idempotency_key` in `Idempotency-Key`, where it wins
        over the upload's own. Raises `SessionRejected`, `OffsetMismatch`, `SessionConflict`,
        `Forbidden` or `StoreError` as the server refuses."""
        return self._run(calls.ingest(upload, retract_secret, idempotency_key))

    def get_session(
        self, format: str, session_id: str, *, owner: str | None = None
    ) -> m.SessionMetadata | None:
        """The session's metadata; None for one not stored, or one the caller may not read."""
        return self._run(calls.get_session(format, session_id, owner))

    @overload
    def get_trace(
        self,
        format: str,
        session_id: str,
        *,
        hash: str | None = ...,
        render: Literal["seshi"] | None = ...,
        owner: str | None = ...,
    ) -> m.Trace | None: ...
    @overload
    def get_trace(
        self,
        format: str,
        session_id: str,
        *,
        hash: str | None = ...,
        render: Literal["letta"],
        owner: str | None = ...,
    ) -> m.LettaTrace | None: ...
    @overload
    def get_trace(
        self,
        format: str,
        session_id: str,
        *,
        hash: str | None = ...,
        render: Literal["otlp"],
        owner: str | None = ...,
    ) -> m.OtlpTrace | None: ...
    @overload
    def get_trace(
        self,
        format: str,
        session_id: str,
        *,
        hash: str | None = ...,
        render: Literal["atif"],
        owner: str | None = ...,
    ) -> m.AtifDocument | None: ...
    def get_trace(
        self,
        format: str,
        session_id: str,
        *,
        hash: str | None = None,
        render: m.RenderFormat | None = None,
        owner: str | None = None,
    ) -> m.StoredTrace | None:
        """The head trace, or the one `hash` names, rendered as `render` (`seshi`, the stored
        canonical trace, by default); None for a session not stored, unreadable or redacted."""
        result: m.StoredTrace | None = self._run(
            calls.get_trace(format, session_id, hash, render, owner)
        )
        return result

    def list_sessions(
        self, *, owner: str | None = None, after: str | None = None, limit: int | None = None
    ) -> m.SessionsPage:
        """`GET /v1/sessions`: an owner's sessions (the caller's own by default), a page at a
        time. Any credential lists its own owner's; another owner's need `sessions:read`
        (`Forbidden` without it)."""
        return self._run(calls.list_sessions(owner, after, limit))

    def iter_sessions(
        self, *, owner: str | None = None, limit: int | None = None
    ) -> Iterator[m.SessionMetadata]:
        """Every session `list_sessions` lists, page after page; `limit` is the page size."""
        after: str | None = None
        while True:
            page = self.list_sessions(owner=owner, after=after, limit=limit)
            yield from page.sessions
            if not page.truncated or page.cursor is None:
                return
            after = page.cursor

    def stale_sessions(
        self, *, after: str | None = None, limit: int | None = None
    ) -> m.StaleSessionsPage:
        """`GET /v1/sessions/stale`: the caller's own sessions an older normalizer built (X4.9),
        to send again whole with `rebuild`. Needs `sessions:write`."""
        return self._run(calls.stale_sessions(after, limit))

    def tombstone(
        self,
        format: str,
        session_id: str,
        *,
        owner: str | None = None,
        retract_secret: str | None = None,
    ) -> m.Removed | None:
        """Delete the session: a tombstone in its owner's change feed (X5.3); None for one not
        stored. Needs `sessions:delete`. With `retract_secret` it is a retraction instead (F9.7),
        by the machine that uploaded the session with its upload credential; a refused one is
        `ServerError` 403 `bad_retract_secret` or `retract_disabled`."""
        return self._run(calls.tombstone(format, session_id, owner, retract_secret))

    def set_visibility(
        self, format: str, session_id: str, visibility: m.Visibility, *, owner: str | None = None
    ) -> m.SessionMetadata | None:
        """Change who may read a session (X5.10); the metadata as it now is, None for one not
        stored. The owner may, with a token that writes sessions (a device token) or reads them;
        an admin may change anyone's, naming `owner`. A redacted session is `ServerError` 410."""
        return self._run(calls.set_visibility(format, session_id, visibility, owner))

    def reviews(
        self, format: str, session_id: str, *, owner: str | None = None
    ) -> list[m.ReviewDecision] | None:
        """What model review decided for each stored write of the session, oldest first (F3.8);
        None for a session not stored."""
        return self._run(calls.reviews(format, session_id, owner))

    def get_session_by_archive(self, owner: str, archive_id: str) -> m.SessionMetadata | None:
        """The session's metadata by its owner and archive id, as change entries, search results
        and listings name it (that owner's folder exactly, no aliases folded in); None when not
        stored or not readable."""
        return self._run(calls.get_session_by_archive(owner, archive_id))

    @overload
    def get_trace_by_archive(
        self,
        owner: str,
        archive_id: str,
        *,
        hash: str | None = ...,
        render: Literal["seshi"] | None = ...,
    ) -> m.Trace | None: ...
    @overload
    def get_trace_by_archive(
        self,
        owner: str,
        archive_id: str,
        *,
        hash: str | None = ...,
        render: Literal["letta"],
    ) -> m.LettaTrace | None: ...
    @overload
    def get_trace_by_archive(
        self,
        owner: str,
        archive_id: str,
        *,
        hash: str | None = ...,
        render: Literal["otlp"],
    ) -> m.OtlpTrace | None: ...
    @overload
    def get_trace_by_archive(
        self,
        owner: str,
        archive_id: str,
        *,
        hash: str | None = ...,
        render: Literal["atif"],
    ) -> m.AtifDocument | None: ...
    def get_trace_by_archive(
        self,
        owner: str,
        archive_id: str,
        *,
        hash: str | None = None,
        render: m.RenderFormat | None = None,
    ) -> m.StoredTrace | None:
        """`get_trace` by owner and archive id."""
        result: m.StoredTrace | None = self._run(
            calls.get_trace_by_archive(owner, archive_id, hash, render)
        )
        return result

    def reviews_by_archive(self, owner: str, archive_id: str) -> list[m.ReviewDecision] | None:
        """`reviews` by owner and archive id."""
        return self._run(calls.reviews_by_archive(owner, archive_id))

    # --- Change feeds ---------------------------------------------------------------------

    def changes(
        self,
        *,
        owner: str | None = None,
        after: str | None = None,
        since: str | datetime | None = None,
        limit: int | None = None,
    ) -> m.ChangesPage:
        """`GET /v1/changes`: an owner's change feed (the caller's own by default) after the key
        `after`, or from the time `since`."""
        return self._run(calls.changes(owner, after, since, limit))

    def iter_changes(
        self,
        *,
        owner: str | None = None,
        after: str | None = None,
        since: str | datetime | None = None,
        limit: int | None = None,
    ) -> Iterator[m.Change]:
        """Every entry of `changes` from `after` (or `since`) to the end of the feed, page after
        page. Each entry's `key` is the cursor to resume from."""
        while True:
            page = self.changes(owner=owner, after=after, since=since, limit=limit)
            yield from page.entries
            if not page.truncated or page.cursor is None:
                return
            after = page.cursor

    def all_changes(
        self,
        *,
        after: str | None = None,
        since: str | datetime | None = None,
        limit: int | None = None,
    ) -> m.AllChangesPage:
        """`GET /v1/changes/all`: every owner's change feed as one, by stamp, then owner, then
        key; `after` is the last page's opaque `cursor`. Only for a service token or an admin
        (`Forbidden` for anyone else). `ServerError` 503 `index_building` while the server's
        search index is first built, 404 `search_disabled` with search off."""
        return self._run(calls.all_changes(after, since, limit))

    def iter_all_changes(
        self,
        *,
        after: str | None = None,
        since: str | datetime | None = None,
        limit: int | None = None,
    ) -> Iterator[m.OwnedChange]:
        """Every entry of `all_changes` up to the feed's `through`, page after page. To tail the
        feed, keep the last page's cursor (`all_changes`) and ask again later."""
        while True:
            page = self.all_changes(after=after, since=since, limit=limit)
            yield from page.entries
            if not page.truncated or page.cursor is None:
                return
            after = page.cursor

    # --- Search ---------------------------------------------------------------------------

    def search(
        self,
        q: str,
        *,
        owner: str | None = None,
        agent: str | None = None,
        repo: str | None = None,
        branch: str | None = None,
        harness: str | None = None,
        agent_version: str | None = None,
        model: str | None = None,
        labels: Mapping[str, str] | None = None,
        source: str | None = None,
        since: str | datetime | None = None,
        until: str | datetime | None = None,
        sort: m.SearchSort | None = None,
        limit: int | None = None,
        matches: int | None = None,
        cursor: str | None = None,
    ) -> m.SearchResults:
        """`GET /v1/search`: keyword search over the sessions this credential may read (F10). A
        query the server cannot run is `ServerError` 400 `bad_query`; 503 `index_building` while
        the index is first built; 404 `search_disabled` with search off."""
        request = _search_request(
            q,
            owner=owner,
            agent=agent,
            repo=repo,
            branch=branch,
            harness=harness,
            agent_version=agent_version,
            model=model,
            source=source,
            since=since,
            until=until,
            sort=sort,
            limit=limit,
            matches=matches,
            labels=labels,
            cursor=cursor,
        )
        return self._run(calls.search(request))

    # --- Redaction rules ------------------------------------------------------------------

    def redaction_rules(self) -> m.RedactionRules:
        """`GET /v1/redaction/rules`: the org's redaction rule packs, for redacting before upload
        (F2.4)."""
        return self._run(calls.redaction_rules())

    def redaction_rules_since(self, etag: str | None = None) -> m.RedactionRulesAnswer | None:
        """`redaction_rules` with HTTP caching: `etag`, from an earlier answer, goes as
        If-None-Match. None means the rules have not changed since; otherwise the document comes
        back with its own ETag."""
        return self._run(calls.redaction_rules_since(etag))

    # --- Capture rules --------------------------------------------------------------------

    def capture_rules(self) -> m.CaptureRules:
        """`GET /v1/capture/rules`: the org's exclude list (`[capture] exclude`) and tool-call
        redaction list (`[capture] redact_tool_calls`), which laptops apply before upload. A
        server older than the route raises `ServerError` 404."""
        return self._run(calls.capture_rules())

    def capture_rules_since(self, etag: str | None = None) -> m.CaptureRulesAnswer | None:
        """`capture_rules` with HTTP caching: `etag`, from an earlier answer, goes as
        If-None-Match. None means the list has not changed since; otherwise the document comes
        back with its own ETag."""
        return self._run(calls.capture_rules_since(etag))

    # --- Tokens (admins) ------------------------------------------------------------------

    def create_token(self, request: m.TokenRequest | Mapping[str, Any]) -> m.CreatedToken:
        """`POST /v1/tokens`: issue a token; its secret is in the answer only."""
        return self._run(calls.create_token(request))

    def list_tokens(
        self, *, owner: str | None = None, kind: m.TokenKind | None = None, all: bool = False
    ) -> list[m.TokenInfo]:
        """`GET /v1/tokens`: live tokens, or every one (revoked and expired too) with `all`."""
        return self._run(calls.list_tokens(owner, kind, all))

    def revoke_token(self, id: str) -> m.TokenInfo | None:
        """`DELETE /v1/tokens/{id}`: revoke one token; None for an unknown id."""
        return self._run(calls.revoke_token(id))

    def revoke_owner_tokens(self, owner: str, kind: m.TokenKind | None = None) -> list[m.TokenInfo]:
        """`POST /v1/tokens/revoke`: revoke every live token of an owner (offboarding, X5.11), or
        every one of a kind."""
        return self._run(calls.revoke_owner_tokens(owner, kind))

    # --- Admin ----------------------------------------------------------------------------

    def jobs(self) -> m.JobsStatus:
        """`GET /v1/admin/jobs`: the worker, its jobs and every source (X7.5)."""
        return self._run(calls.jobs())

    def config_status(self) -> m.ConfigStatus:
        """`GET /v1/admin/reload`: the running config's generation, hash and rule set, and how
        the last reload went."""
        return self._run(calls.config_status())

    def reload(self) -> m.ReloadResult:
        """`POST /v1/admin/reload`: have the server read its config files again and apply them,
        all or nothing (F1.5). A rejected reload is returned, not raised: its `reload.errors`
        say why, and the running config stays. A server started without a config file is
        `ServerError` 409 `not_reloadable`."""
        return self._run(calls.reload())

    def sources(self, *, days: int | None = None) -> list[m.SourceStatus]:
        """`GET /v1/admin/sources`: every configured source and `upload`, with health over
        `days`."""
        return self._run(calls.sources(days))

    def source(self, id: str, *, days: int | None = None) -> m.SourceDetail | None:
        """One source's status; None for an unknown source."""
        return self._run(calls.source(id, days))

    def records(
        self,
        kind: m.RecordKind,
        id: str,
        *,
        since: str | datetime | None = None,
        after: str | None = None,
        limit: int | None = None,
    ) -> m.RecordsPage | None:
        """A source's `failed` or `dropped` records, oldest first (X6.4); None for an unknown
        source."""
        return self._run(calls.records(kind, id, since, after, limit))

    # The runtime config (server.runtime_config = store; docs/config.md, "Runtime config in the
    # bucket"). Each write is checked by the server as a reload would check it before anything
    # is written (`ConfigRejected` otherwise, with each problem), made under the condition given
    # (`PreconditionFailed` when it does not hold), and applied on the server that took it at
    # once; the other instances apply it within `server.config_poll`.

    def runtime_config(self, *, wait: str | None = None) -> m.RuntimeConfigStatus:
        """`GET /v1/admin/config`: the bucket's runtime config, its version, the settings the
        server's files lock, and which live instances run it. `wait` (`"30s"`) waits for them
        all to."""
        return self._run(calls.runtime_config(wait))

    def patch_runtime_config(
        self,
        *,
        set: Mapping[str, Any] | None = None,
        unset: list[str] | None = None,
        if_match: str | None = None,
        create: bool = False,
    ) -> m.RuntimeWrite:
        """Change data-policy settings in the bucket's `config/seshi.toml`: `set` maps dotted
        paths (`"capture.exclude"`) to values, `unset` removes paths. `if_match` is the ETag
        `runtime_config().doc.etag` gave; `create=True` when there is none yet."""
        return self._run(calls.patch_runtime_config(set, unset, if_match, create))

    def put_config_file(
        self,
        name: str,
        content: bytes | str,
        *,
        if_match: str | None = None,
        create: bool = False,
    ) -> m.RuntimeFileWrite:
        """Write a file under `config/` (`packs/org.json`), checked when the doc names it."""
        data = content.encode() if isinstance(content, str) else content
        return self._run(calls.put_config_file(name, data, if_match, create))

    def delete_config_file(
        self, name: str, *, if_match: str | None = None
    ) -> m.RuntimeFileWrite | None:
        """Remove a file under `config/`; None when there is none. Refused (`ServerError` 409
        `in_use`) while the doc names it."""
        return self._run(calls.delete_config_file(name, if_match))

    def put_source(
        self,
        id: str,
        source: Mapping[str, Any],
        *,
        if_match: str | None = None,
        create: bool = False,
    ) -> m.StoredSourceWrite:
        """Store source `id` in the bucket: its settings as in `[[sources]]`. Secret values are
        sealed and never returned; a secret left out keeps its sealed value when the type
        stays the same."""
        return self._run(calls.put_source(id, source, if_match, create))

    def delete_source(self, id: str, *, if_match: str | None = None) -> m.SourceDeleted | None:
        """Remove a stored source; None when the bucket has none by that id. Its sessions,
        checkpoint and records stay."""
        return self._run(calls.delete_source(id, if_match))

    def reseal_secrets(self) -> m.ResealResult:
        """Seal every stored source's secrets again with `secrets.key_id`'s key."""
        return self._run(calls.reseal_secrets())


class AsyncSeshiClient(_Base):
    """`SeshiClient`, with coroutines: the same options and calls (see its documentation), and
    `iter_*` helpers that are async iterators. Pass `http_client` for your own
    `httpx.AsyncClient`, or `transport` for an `httpx.AsyncBaseTransport`. Use it as an async
    context manager, or await `aclose()`."""

    def __init__(
        self,
        server: str,
        token: str | None = None,
        *,
        user: str | None = None,
        timeout: float | None = DEFAULT_TIMEOUT,
        user_agent: str | None = None,
        gzip_from: int = DEFAULT_GZIP_FROM,
        http_client: httpx.AsyncClient | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        super().__init__(
            server, token, user=user, timeout=timeout, user_agent=user_agent, gzip_from=gzip_from
        )
        if http_client is not None and transport is not None:
            raise ValueError("pass http_client or transport, not both")
        self._owns_client = http_client is None
        self._http = http_client or httpx.AsyncClient(transport=transport)

    async def aclose(self) -> None:
        if self._owns_client:
            await self._http.aclose()

    async def __aenter__(self) -> AsyncSeshiClient:
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        await self.aclose()

    async def _run(self, call: Call[T]) -> T:
        request = calls.prepare(call, self._settings)
        try:
            response = await self._http.send(request)
        except httpx.TransportError as err:
            raise calls.unreachable(self.server, err) from err
        return call.read(calls.read(response))

    async def health(self) -> m.Health:
        """`GET /healthz`."""
        return await self._run(calls.health())

    async def auth_config(self) -> m.AuthConfig:
        """`GET /v1/auth/config`. Sends no credential."""
        return await self._run(calls.auth_config())

    async def exchange_id_token(
        self, request: m.ExchangeRequest | Mapping[str, Any]
    ) -> m.ExchangeResult:
        """`POST /v1/auth/exchange`. Sends no credential."""
        return await self._run(calls.exchange(request))

    async def me(self) -> m.Identity:
        """`GET /v1/me`."""
        return await self._run(calls.me())

    async def owners(self, *, after: str | None = None, limit: int | None = None) -> m.OwnersPage:
        """`GET /v1/owners`."""
        return await self._run(calls.owners(after, limit))

    async def ingest(
        self,
        upload: m.Upload | Mapping[str, Any],
        *,
        retract_secret: str | None = None,
        idempotency_key: str | None = None,
    ) -> m.Stored | m.NotWritten:
        """`POST /v1/sessions` (see `SeshiClient.ingest`)."""
        return await self._run(calls.ingest(upload, retract_secret, idempotency_key))

    async def get_session(
        self, format: str, session_id: str, *, owner: str | None = None
    ) -> m.SessionMetadata | None:
        """The session's metadata; None for one not stored or not readable."""
        return await self._run(calls.get_session(format, session_id, owner))

    @overload
    async def get_trace(
        self,
        format: str,
        session_id: str,
        *,
        hash: str | None = ...,
        render: Literal["seshi"] | None = ...,
        owner: str | None = ...,
    ) -> m.Trace | None: ...
    @overload
    async def get_trace(
        self,
        format: str,
        session_id: str,
        *,
        hash: str | None = ...,
        render: Literal["letta"],
        owner: str | None = ...,
    ) -> m.LettaTrace | None: ...
    @overload
    async def get_trace(
        self,
        format: str,
        session_id: str,
        *,
        hash: str | None = ...,
        render: Literal["otlp"],
        owner: str | None = ...,
    ) -> m.OtlpTrace | None: ...
    @overload
    async def get_trace(
        self,
        format: str,
        session_id: str,
        *,
        hash: str | None = ...,
        render: Literal["atif"],
        owner: str | None = ...,
    ) -> m.AtifDocument | None: ...
    async def get_trace(
        self,
        format: str,
        session_id: str,
        *,
        hash: str | None = None,
        render: m.RenderFormat | None = None,
        owner: str | None = None,
    ) -> m.StoredTrace | None:
        """The head trace, or `hash`, as `format`; None when not stored, unreadable or
        redacted."""
        result: m.StoredTrace | None = await self._run(
            calls.get_trace(format, session_id, hash, render, owner)
        )
        return result

    async def list_sessions(
        self, *, owner: str | None = None, after: str | None = None, limit: int | None = None
    ) -> m.SessionsPage:
        """`GET /v1/sessions`."""
        return await self._run(calls.list_sessions(owner, after, limit))

    async def iter_sessions(
        self, *, owner: str | None = None, limit: int | None = None
    ) -> AsyncIterator[m.SessionMetadata]:
        """Every session `list_sessions` lists, page after page."""
        after: str | None = None
        while True:
            page = await self.list_sessions(owner=owner, after=after, limit=limit)
            for session in page.sessions:
                yield session
            if not page.truncated or page.cursor is None:
                return
            after = page.cursor

    async def stale_sessions(
        self, *, after: str | None = None, limit: int | None = None
    ) -> m.StaleSessionsPage:
        """`GET /v1/sessions/stale`."""
        return await self._run(calls.stale_sessions(after, limit))

    async def tombstone(
        self,
        format: str,
        session_id: str,
        *,
        owner: str | None = None,
        retract_secret: str | None = None,
    ) -> m.Removed | None:
        """Delete (or, with `retract_secret`, retract) the session; None for one not stored."""
        return await self._run(calls.tombstone(format, session_id, owner, retract_secret))

    async def set_visibility(
        self, format: str, session_id: str, visibility: m.Visibility, *, owner: str | None = None
    ) -> m.SessionMetadata | None:
        """Change who may read a session; None for one not stored."""
        return await self._run(calls.set_visibility(format, session_id, visibility, owner))

    async def reviews(
        self, format: str, session_id: str, *, owner: str | None = None
    ) -> list[m.ReviewDecision] | None:
        """Model review's decisions for the session, oldest first; None for one not stored."""
        return await self._run(calls.reviews(format, session_id, owner))

    async def get_session_by_archive(self, owner: str, archive_id: str) -> m.SessionMetadata | None:
        """The session's metadata by its owner and archive id, as change entries, search results
        and listings name it (that owner's folder exactly, no aliases folded in); None when not
        stored or not readable."""
        return await self._run(calls.get_session_by_archive(owner, archive_id))

    @overload
    async def get_trace_by_archive(
        self,
        owner: str,
        archive_id: str,
        *,
        hash: str | None = ...,
        render: Literal["seshi"] | None = ...,
    ) -> m.Trace | None: ...
    @overload
    async def get_trace_by_archive(
        self,
        owner: str,
        archive_id: str,
        *,
        hash: str | None = ...,
        render: Literal["letta"],
    ) -> m.LettaTrace | None: ...
    @overload
    async def get_trace_by_archive(
        self,
        owner: str,
        archive_id: str,
        *,
        hash: str | None = ...,
        render: Literal["otlp"],
    ) -> m.OtlpTrace | None: ...
    @overload
    async def get_trace_by_archive(
        self,
        owner: str,
        archive_id: str,
        *,
        hash: str | None = ...,
        render: Literal["atif"],
    ) -> m.AtifDocument | None: ...
    async def get_trace_by_archive(
        self,
        owner: str,
        archive_id: str,
        *,
        hash: str | None = None,
        render: m.RenderFormat | None = None,
    ) -> m.StoredTrace | None:
        """`get_trace` by owner and archive id."""
        result: m.StoredTrace | None = await self._run(
            calls.get_trace_by_archive(owner, archive_id, hash, render)
        )
        return result

    async def reviews_by_archive(
        self, owner: str, archive_id: str
    ) -> list[m.ReviewDecision] | None:
        """`reviews` by owner and archive id."""
        return await self._run(calls.reviews_by_archive(owner, archive_id))

    async def changes(
        self,
        *,
        owner: str | None = None,
        after: str | None = None,
        since: str | datetime | None = None,
        limit: int | None = None,
    ) -> m.ChangesPage:
        """`GET /v1/changes`."""
        return await self._run(calls.changes(owner, after, since, limit))

    async def iter_changes(
        self,
        *,
        owner: str | None = None,
        after: str | None = None,
        since: str | datetime | None = None,
        limit: int | None = None,
    ) -> AsyncIterator[m.Change]:
        """Every entry of `changes` to the end of the feed, page after page."""
        while True:
            page = await self.changes(owner=owner, after=after, since=since, limit=limit)
            for entry in page.entries:
                yield entry
            if not page.truncated or page.cursor is None:
                return
            after = page.cursor

    async def all_changes(
        self,
        *,
        after: str | None = None,
        since: str | datetime | None = None,
        limit: int | None = None,
    ) -> m.AllChangesPage:
        """`GET /v1/changes/all` (see `SeshiClient.all_changes`)."""
        return await self._run(calls.all_changes(after, since, limit))

    async def iter_all_changes(
        self,
        *,
        after: str | None = None,
        since: str | datetime | None = None,
        limit: int | None = None,
    ) -> AsyncIterator[m.OwnedChange]:
        """Every entry of `all_changes` up to the feed's `through`, page after page."""
        while True:
            page = await self.all_changes(after=after, since=since, limit=limit)
            for entry in page.entries:
                yield entry
            if not page.truncated or page.cursor is None:
                return
            after = page.cursor

    async def search(
        self,
        q: str,
        *,
        owner: str | None = None,
        agent: str | None = None,
        repo: str | None = None,
        branch: str | None = None,
        harness: str | None = None,
        agent_version: str | None = None,
        model: str | None = None,
        labels: Mapping[str, str] | None = None,
        source: str | None = None,
        since: str | datetime | None = None,
        until: str | datetime | None = None,
        sort: m.SearchSort | None = None,
        limit: int | None = None,
        matches: int | None = None,
        cursor: str | None = None,
    ) -> m.SearchResults:
        """`GET /v1/search` (see `SeshiClient.search`)."""
        request = _search_request(
            q,
            owner=owner,
            agent=agent,
            repo=repo,
            branch=branch,
            harness=harness,
            agent_version=agent_version,
            model=model,
            source=source,
            since=since,
            until=until,
            sort=sort,
            limit=limit,
            matches=matches,
            labels=labels,
            cursor=cursor,
        )
        return await self._run(calls.search(request))

    async def redaction_rules(self) -> m.RedactionRules:
        """`GET /v1/redaction/rules`."""
        return await self._run(calls.redaction_rules())

    async def redaction_rules_since(self, etag: str | None = None) -> m.RedactionRulesAnswer | None:
        """`redaction_rules` with If-None-Match; None when unchanged."""
        return await self._run(calls.redaction_rules_since(etag))

    async def capture_rules(self) -> m.CaptureRules:
        """`GET /v1/capture/rules`."""
        return await self._run(calls.capture_rules())

    async def capture_rules_since(self, etag: str | None = None) -> m.CaptureRulesAnswer | None:
        """`capture_rules` with If-None-Match; None when unchanged."""
        return await self._run(calls.capture_rules_since(etag))

    async def create_token(self, request: m.TokenRequest | Mapping[str, Any]) -> m.CreatedToken:
        """`POST /v1/tokens`."""
        return await self._run(calls.create_token(request))

    async def list_tokens(
        self, *, owner: str | None = None, kind: m.TokenKind | None = None, all: bool = False
    ) -> list[m.TokenInfo]:
        """`GET /v1/tokens`."""
        return await self._run(calls.list_tokens(owner, kind, all))

    async def revoke_token(self, id: str) -> m.TokenInfo | None:
        """`DELETE /v1/tokens/{id}`; None for an unknown id."""
        return await self._run(calls.revoke_token(id))

    async def revoke_owner_tokens(
        self, owner: str, kind: m.TokenKind | None = None
    ) -> list[m.TokenInfo]:
        """`POST /v1/tokens/revoke`."""
        return await self._run(calls.revoke_owner_tokens(owner, kind))

    async def jobs(self) -> m.JobsStatus:
        """`GET /v1/admin/jobs`."""
        return await self._run(calls.jobs())

    async def config_status(self) -> m.ConfigStatus:
        """`GET /v1/admin/reload`."""
        return await self._run(calls.config_status())

    async def reload(self) -> m.ReloadResult:
        """`POST /v1/admin/reload`; a rejected reload is returned, not raised."""
        return await self._run(calls.reload())

    async def sources(self, *, days: int | None = None) -> list[m.SourceStatus]:
        """`GET /v1/admin/sources`."""
        return await self._run(calls.sources(days))

    async def source(self, id: str, *, days: int | None = None) -> m.SourceDetail | None:
        """One source's status; None for an unknown source."""
        return await self._run(calls.source(id, days))

    async def records(
        self,
        kind: m.RecordKind,
        id: str,
        *,
        since: str | datetime | None = None,
        after: str | None = None,
        limit: int | None = None,
    ) -> m.RecordsPage | None:
        """A source's failure or drop records; None for an unknown source."""
        return await self._run(calls.records(kind, id, since, after, limit))

    async def runtime_config(self, *, wait: str | None = None) -> m.RuntimeConfigStatus:
        """`GET /v1/admin/config`."""
        return await self._run(calls.runtime_config(wait))

    async def patch_runtime_config(
        self,
        *,
        set: Mapping[str, Any] | None = None,
        unset: list[str] | None = None,
        if_match: str | None = None,
        create: bool = False,
    ) -> m.RuntimeWrite:
        """`PATCH /v1/admin/config`."""
        return await self._run(calls.patch_runtime_config(set, unset, if_match, create))

    async def put_config_file(
        self,
        name: str,
        content: bytes | str,
        *,
        if_match: str | None = None,
        create: bool = False,
    ) -> m.RuntimeFileWrite:
        """`PUT /v1/admin/config/files/{name}`."""
        data = content.encode() if isinstance(content, str) else content
        return await self._run(calls.put_config_file(name, data, if_match, create))

    async def delete_config_file(
        self, name: str, *, if_match: str | None = None
    ) -> m.RuntimeFileWrite | None:
        """`DELETE /v1/admin/config/files/{name}`; None when there is none."""
        return await self._run(calls.delete_config_file(name, if_match))

    async def put_source(
        self,
        id: str,
        source: Mapping[str, Any],
        *,
        if_match: str | None = None,
        create: bool = False,
    ) -> m.StoredSourceWrite:
        """`PUT /v1/admin/sources/{id}`."""
        return await self._run(calls.put_source(id, source, if_match, create))

    async def delete_source(
        self, id: str, *, if_match: str | None = None
    ) -> m.SourceDeleted | None:
        """`DELETE /v1/admin/sources/{id}`; None when there is none."""
        return await self._run(calls.delete_source(id, if_match))

    async def reseal_secrets(self) -> m.ResealResult:
        """`POST /v1/admin/secrets/reseal`."""
        return await self._run(calls.reseal_secrets())


def auth_config(
    server: str,
    *,
    timeout: float | None = DEFAULT_TIMEOUT,
    user_agent: str | None = None,
    transport: httpx.BaseTransport | None = None,
) -> m.AuthConfig:
    """`GET /v1/auth/config` on `server`, before there is a token."""
    with SeshiClient(server, timeout=timeout, user_agent=user_agent, transport=transport) as client:
        return client.auth_config()


def exchange_id_token(
    server: str,
    request: m.ExchangeRequest | Mapping[str, Any],
    *,
    timeout: float | None = DEFAULT_TIMEOUT,
    user_agent: str | None = None,
    transport: httpx.BaseTransport | None = None,
) -> m.ExchangeResult:
    """`POST /v1/auth/exchange` on `server`: an IdP ID token for seshi tokens."""
    with SeshiClient(server, timeout=timeout, user_agent=user_agent, transport=transport) as client:
        return client.exchange_id_token(request)
