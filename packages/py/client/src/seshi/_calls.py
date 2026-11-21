"""Each API call as data: the request to send and how to read the answer. The sync and async
clients only move the bytes, so every rule about a route (its status codes, what is None, what
is refused) is written once, here."""

from __future__ import annotations

import gzip
import json
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Generic, TypeVar
from urllib.parse import quote

import httpx
from pydantic import BaseModel, TypeAdapter

from . import models as m
from ._routes import ROUTES, Route
from ._version import __version__
from .errors import (
    ConfigRejected,
    Forbidden,
    OffsetMismatch,
    PreconditionFailed,
    ServerError,
    SessionConflict,
    SessionRejected,
    StoreError,
)

T = TypeVar("T")
M = TypeVar("M", bound=BaseModel)

DEFAULT_USER_AGENT = f"seshi-python/{__version__}"
DEFAULT_TIMEOUT = 120.0
"""Seconds per request: a large transcript can take the server a while to normalize and
verify. The server's own idle timeout."""
DEFAULT_GZIP_FROM = 8 * 1024
RETRACT_HEADER = "X-Seshi-Retract"
"""The header a retraction, or an org-key replace, carries the session's secret in (F9.7)."""

QueryValue = str | int | bool | datetime | list[str] | None


@dataclass(frozen=True)
class Answer:
    status: int
    body: Any
    headers: httpx.Headers


@dataclass(frozen=True)
class Call(Generic[T]):
    operation: str
    read: Callable[[Answer], T]
    path_params: Mapping[str, str] = field(default_factory=dict)
    query: Mapping[str, QueryValue] = field(default_factory=dict)
    body: Any = None
    headers: Mapping[str, str] = field(default_factory=dict)
    content: bytes | None = None
    """A body sent as it is (`application/octet-stream`), instead of `body` as JSON."""

    @property
    def route(self) -> Route:
        return ROUTES[self.operation]


@dataclass(frozen=True)
class Settings:
    server: str
    token: str | None
    user: str | None
    user_agent: str
    gzip_from: int
    timeout: float | None
    """Seconds per request; 0 or None disables. Set on each request, so it holds whatever
    httpx client sends it."""


def _query_value(value: str | int | bool | datetime) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, datetime):
        return rfc3339(value)
    return str(value)


def rfc3339(value: datetime) -> str:
    """A time as seshi writes it: UTC, milliseconds, `Z` (`2026-11-14T09:00:00.000Z`). A naive
    time is taken as UTC."""
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    utc = value.astimezone(timezone.utc)
    return utc.strftime("%Y-%m-%dT%H:%M:%S.") + f"{utc.microsecond // 1000:03d}Z"


def prepare(call: Call[Any], settings: Settings) -> httpx.Request:
    """The request a call sends. Fails on a parameter the route table does not list, so the
    table `tests/test_spec_drift.py` checks is the one the client uses."""
    route = call.route
    path = route.path
    for name, value in call.path_params.items():
        placeholder = "{" + name + "}"
        if placeholder not in path:
            raise AssertionError(f"{call.operation}: no path parameter {name}")
        path = path.replace(placeholder, quote(value, safe=""))
    unknown = set(call.query) - set(route.query)
    if unknown:
        raise AssertionError(f"{call.operation}: query parameters {sorted(unknown)} not in routes")
    known_headers = {h.lower() for h in route.headers}
    unknown_headers = {h for h in call.headers if h.lower() not in known_headers}
    if unknown_headers:
        raise AssertionError(f"{call.operation}: headers {sorted(unknown_headers)} not in routes")

    headers = {"user-agent": settings.user_agent, **call.headers}
    if route.auth and settings.token is not None:
        headers["authorization"] = f"Bearer {settings.token}"
        if settings.user is not None:
            headers["x-seshi-user"] = settings.user
    content: bytes | None = call.content
    if call.content is not None:
        headers["content-type"] = "application/octet-stream"
    elif call.body is not None:
        headers["content-type"] = "application/json"
        content = json.dumps(call.body, separators=(",", ":"), ensure_ascii=False).encode()
        if len(content) >= settings.gzip_from:
            headers["content-encoding"] = "gzip"
            content = gzip.compress(content)
    params: list[tuple[str, str | int | float | bool | None]] = [
        (k, _query_value(item))
        for k, v in call.query.items()
        if v is not None
        for item in (v if isinstance(v, list) else [v])
    ]
    return httpx.Request(
        route.method,
        settings.server + path,
        params=params,
        headers=headers,
        content=content,
        extensions={"timeout": httpx.Timeout(settings.timeout or None).as_dict()},
    )


def read(response: httpx.Response) -> Answer:
    text = response.text
    body: Any = None
    if text:
        try:
            body = json.loads(text)
        except ValueError:
            if response.is_success:
                raise ServerError(
                    response.status_code, "bad_response", f"not JSON: {text[:200]}"
                ) from None
    return Answer(response.status_code, body, response.headers)


def unreachable(server: str, err: Exception) -> StoreError:
    error = StoreError(f"cannot reach {server}: {err}")
    error.__cause__ = err
    return error


def _error(body: Any) -> dict[str, Any]:
    error = body.get("error") if isinstance(body, dict) else None
    return error if isinstance(error, dict) else {}


def error_code(body: Any) -> str | None:
    code = _error(body).get("code")
    return code if isinstance(code, str) else None


def refuse(answer: Answer, offset: int = 0) -> Exception:
    """The error an answer that is not the call's success means."""
    error = _error(answer.body)
    code = str(error.get("code") or "unknown")
    message = str(error.get("message") or f"HTTP {answer.status}")
    status = answer.status
    if status == 409 and code == "offset_mismatch":
        expected = error.get("expected")
        return OffsetMismatch(offset, expected if isinstance(expected, int) else 0)
    if status == 409 and code == "conflict":
        return SessionConflict(message)
    if status == 403 and code == "forbidden":
        return Forbidden(message)
    if status == 422:
        return SessionRejected(code, message)
    if status == 502:
        return StoreError(message)
    return ServerError(status, code, message)


# --- Reading answers ------------------------------------------------------------------------


def _expect(answer: Answer, *statuses: int, offset: int = 0) -> Any:
    if answer.status not in statuses:
        raise refuse(answer, offset)
    return answer.body


def _model(model: type[M], *statuses: int) -> Callable[[Answer], M]:
    return lambda answer: model.model_validate(_expect(answer, *(statuses or (200,))))


def _or_none(model: type[M], *none_on: int) -> Callable[[Answer], M | None]:
    def read_answer(answer: Answer) -> M | None:
        if answer.status in none_on:
            return None
        return model.model_validate(_expect(answer, 200))

    return read_answer


def _dump(value: BaseModel | Mapping[str, Any], model: type[BaseModel]) -> dict[str, Any]:
    """The body `model` sends: `value` checked as one, whatever it was given as (another model
    is checked by its fields, so a stray field is refused here, not by the server)."""
    if isinstance(value, model):
        checked: BaseModel = value
    elif isinstance(value, BaseModel):
        checked = model.model_validate(value.model_dump(by_alias=True, exclude_none=True))
    else:
        checked = model.model_validate(value)
    return checked.model_dump(mode="json", by_alias=True, exclude_none=True)


def _session(format: str, session_id: str) -> dict[str, str]:
    return {"format": format, "session_id": session_id}


_INGEST_RESULT: TypeAdapter[m.Stored | m.NotWritten] = TypeAdapter(m.IngestResult)
_TRACES: dict[str | None, type[BaseModel]] = {
    None: m.Trace,
    "seshi": m.Trace,
    "letta": m.LettaTrace,
    "otlp": m.OtlpTrace,
    "atif": m.AtifDocument,
}


# --- The calls ------------------------------------------------------------------------------


def health() -> Call[m.Health]:
    return Call("health", _model(m.Health))


def auth_config() -> Call[m.AuthConfig]:
    return Call("authConfig", _model(m.AuthConfig))


def exchange(request: m.ExchangeRequest | Mapping[str, Any]) -> Call[m.ExchangeResult]:
    return Call("exchange", _model(m.ExchangeResult), body=_dump(request, m.ExchangeRequest))


def me() -> Call[m.Identity]:
    return Call("me", _model(m.Identity))


def owners(after: str | None, limit: int | None) -> Call[m.OwnersPage]:
    return Call("listOwners", _model(m.OwnersPage), query={"after": after, "limit": limit})


def ingest(
    upload: m.Upload | Mapping[str, Any],
    retract_secret: str | None,
    idempotency_key: str | None,
) -> Call[m.Stored | m.NotWritten]:
    body = _dump(upload, m.Upload)
    offset = int(body.get("offset", 0))
    headers: dict[str, str] = {}
    if retract_secret is not None:
        headers[RETRACT_HEADER] = retract_secret
    if idempotency_key is not None:
        headers["Idempotency-Key"] = idempotency_key

    def read_answer(answer: Answer) -> m.Stored | m.NotWritten:
        return _INGEST_RESULT.validate_python(_expect(answer, 200, 201, offset=offset))

    return Call("ingest", read_answer, body=body, headers=headers)


def get_session(format: str, session_id: str, owner: str | None) -> Call[m.SessionMetadata | None]:
    return Call(
        "getSession",
        _or_none(m.SessionMetadata, 404),
        path_params=_session(format, session_id),
        query={"owner": owner},
    )


def get_trace(
    format: str,
    session_id: str,
    hash: str | None,
    render: m.RenderFormat | None,
    owner: str | None,
) -> Call[Any]:
    return Call(
        "getTrace",
        _or_none(_TRACES[render], 404, 410),
        path_params=_session(format, session_id),
        query={"owner": owner, "hash": hash, "render": render},
    )


def _archive(owner: str, archive_id: str) -> dict[str, str]:
    return {"owner": owner, "archive_id": archive_id}


def get_session_by_archive(owner: str, archive_id: str) -> Call[m.SessionMetadata | None]:
    return Call(
        "getSessionByArchive",
        _or_none(m.SessionMetadata, 404),
        path_params=_archive(owner, archive_id),
    )


def get_trace_by_archive(
    owner: str, archive_id: str, hash: str | None, render: m.RenderFormat | None
) -> Call[Any]:
    return Call(
        "getTraceByArchive",
        _or_none(_TRACES[render], 404, 410),
        path_params=_archive(owner, archive_id),
        query={"hash": hash, "render": render},
    )


def list_sessions(owner: str | None, after: str | None, limit: int | None) -> Call[m.SessionsPage]:
    return Call(
        "listSessions",
        _model(m.SessionsPage),
        query={"owner": owner, "after": after, "limit": limit},
    )


def stale_sessions(after: str | None, limit: int | None) -> Call[m.StaleSessionsPage]:
    return Call(
        "staleSessions", _model(m.StaleSessionsPage), query={"after": after, "limit": limit}
    )


def tombstone(
    format: str, session_id: str, owner: str | None, retract_secret: str | None
) -> Call[m.Removed | None]:
    return Call(
        "tombstone",
        _or_none(m.Removed, 404),
        path_params=_session(format, session_id),
        query={"owner": owner},
        headers={RETRACT_HEADER: retract_secret} if retract_secret is not None else {},
    )


def set_visibility(
    format: str, session_id: str, visibility: m.Visibility, owner: str | None
) -> Call[m.SessionMetadata | None]:
    return Call(
        "setVisibility",
        _or_none(m.SessionMetadata, 404),
        path_params=_session(format, session_id),
        query={"owner": owner},
        body=_dump({"visibility": visibility}, m.VisibilityChange),
    )


def reviews(format: str, session_id: str, owner: str | None) -> Call[list[m.ReviewDecision] | None]:
    def read_answer(answer: Answer) -> list[m.ReviewDecision] | None:
        if answer.status == 404:
            return None
        return m.ReviewsPage.model_validate(_expect(answer, 200)).reviews

    return Call(
        "sessionReviews",
        read_answer,
        path_params=_session(format, session_id),
        query={"owner": owner},
    )


def reviews_by_archive(owner: str, archive_id: str) -> Call[list[m.ReviewDecision] | None]:
    def read_answer(answer: Answer) -> list[m.ReviewDecision] | None:
        if answer.status == 404:
            return None
        return m.ReviewsPage.model_validate(_expect(answer, 200)).reviews

    return Call("sessionReviewsByArchive", read_answer, path_params=_archive(owner, archive_id))


def changes(
    owner: str | None, after: str | None, since: str | datetime | None, limit: int | None
) -> Call[m.ChangesPage]:
    return Call(
        "changes",
        _model(m.ChangesPage),
        query={"owner": owner, "after": after, "since": since, "limit": limit},
    )


def all_changes(
    after: str | None, since: str | datetime | None, limit: int | None
) -> Call[m.AllChangesPage]:
    return Call(
        "allChanges",
        _model(m.AllChangesPage),
        query={"after": after, "since": since, "limit": limit},
    )


def search(request: m.SearchRequest) -> Call[m.SearchResults]:
    query: dict[str, QueryValue] = dict(request.model_dump(exclude_none=True))
    return Call("search", _model(m.SearchResults), query=query)


def redaction_rules() -> Call[m.RedactionRules]:
    return Call("redactionRules", _model(m.RedactionRules))


def redaction_rules_since(etag: str | None) -> Call[m.RedactionRulesAnswer | None]:
    def read_answer(answer: Answer) -> m.RedactionRulesAnswer | None:
        if answer.status == 304 and etag:
            return None
        document = m.RedactionRules.model_validate(_expect(answer, 200))
        return m.RedactionRulesAnswer(document=document, etag=answer.headers.get("etag"))

    return Call("redactionRules", read_answer, headers={"If-None-Match": etag} if etag else {})


def capture_rules() -> Call[m.CaptureRules]:
    return Call("captureRules", _model(m.CaptureRules))


def capture_rules_since(etag: str | None) -> Call[m.CaptureRulesAnswer | None]:
    def read_answer(answer: Answer) -> m.CaptureRulesAnswer | None:
        if answer.status == 304 and etag:
            return None
        document = m.CaptureRules.model_validate(_expect(answer, 200))
        return m.CaptureRulesAnswer(document=document, etag=answer.headers.get("etag"))

    return Call("captureRules", read_answer, headers={"If-None-Match": etag} if etag else {})


def create_token(request: m.TokenRequest | Mapping[str, Any]) -> Call[m.CreatedToken]:
    return Call("createToken", _model(m.CreatedToken, 201), body=_dump(request, m.TokenRequest))


def list_tokens(owner: str | None, kind: m.TokenKind | None, all: bool) -> Call[list[m.TokenInfo]]:
    return Call(
        "listTokens",
        lambda answer: m.TokenList.model_validate(_expect(answer, 200)).tokens,
        query={"owner": owner, "kind": kind, "all": True if all else None},
    )


def revoke_token(id: str) -> Call[m.TokenInfo | None]:
    def read_answer(answer: Answer) -> m.TokenInfo | None:
        if answer.status == 404:
            return None
        return m.RevokedToken.model_validate(_expect(answer, 200)).token

    return Call("revokeToken", read_answer, path_params={"id": id})


def revoke_owner_tokens(owner: str, kind: m.TokenKind | None) -> Call[list[m.TokenInfo]]:
    return Call(
        "revokeOwnerTokens",
        lambda answer: m.RevokedTokens.model_validate(_expect(answer, 200)).revoked,
        body=_dump(m.OwnerRevocation(owner=owner, kind=kind), m.OwnerRevocation),
    )


def jobs() -> Call[m.JobsStatus]:
    return Call("adminJobs", _model(m.JobsStatus))


def config_status() -> Call[m.ConfigStatus]:
    return Call("adminReloadStatus", _model(m.ConfigStatus))


def reload() -> Call[m.ReloadResult]:
    def read_answer(answer: Answer) -> m.ReloadResult:
        body = answer.body
        if (
            answer.status in (200, 422)
            and isinstance(body, dict)
            and "reload" in body
            and "config" in body
        ):
            return m.ReloadResult.model_validate(
                {"reload": body["reload"], "config": body["config"]}
            )
        raise refuse(answer)

    return Call("adminReload", read_answer)


def sources(days: int | None) -> Call[list[m.SourceStatus]]:
    return Call(
        "adminSources",
        lambda answer: m.SourceList.model_validate(_expect(answer, 200)).sources,
        query={"days": days},
    )


def _unknown_source_is_none(model: type[M]) -> Callable[[Answer], M | None]:
    def read_answer(answer: Answer) -> M | None:
        if answer.status == 404 and error_code(answer.body) == "unknown_source":
            return None
        return model.model_validate(_expect(answer, 200))

    return read_answer


def source(id: str, days: int | None) -> Call[m.SourceDetail | None]:
    return Call(
        "adminSource",
        _unknown_source_is_none(m.SourceDetail),
        path_params={"id": id},
        query={"days": days},
    )


def records(
    kind: m.RecordKind,
    id: str,
    since: str | datetime | None,
    after: str | None,
    limit: int | None,
) -> Call[m.RecordsPage | None]:
    return Call(
        "adminSourceRecords",
        _unknown_source_is_none(m.RecordsPage),
        path_params={"id": id, "kind": kind},
        query={"since": since, "after": after, "limit": limit},
    )


# --- The runtime config (server.runtime_config = store) -------------------------------------


def _condition(if_match: str | None, create: bool) -> dict[str, str]:
    """The headers of a conditional write: `If-Match` the ETag read, or `If-None-Match: *` to
    create only."""
    if if_match is not None and create:
        raise ValueError("pass if_match or create, not both")
    if if_match is not None:
        return {"If-Match": if_match if if_match.startswith('"') else f'"{if_match}"'}
    return {"If-None-Match": "*"} if create else {}


def _runtime_write(model: type[M], *statuses: int) -> Callable[[Answer], M]:
    def read_answer(answer: Answer) -> M:
        if answer.status in (statuses or (200,)):
            return model.model_validate(answer.body)
        error = _error(answer.body)
        code = str(error.get("code") or "unknown")
        message = str(error.get("message") or f"HTTP {answer.status}")
        if answer.status == 412:
            raise PreconditionFailed(message)
        if answer.status == 422:
            problems = error.get("problems")
            raise ConfigRejected(
                code, message, [str(p) for p in problems] if isinstance(problems, list) else []
            )
        raise refuse(answer)

    return read_answer


def runtime_config(wait: str | None) -> Call[m.RuntimeConfigStatus]:
    return Call("adminConfig", _model(m.RuntimeConfigStatus), query={"wait": wait})


def patch_runtime_config(
    set: Mapping[str, Any] | None, unset: list[str] | None, if_match: str | None, create: bool
) -> Call[m.RuntimeWrite]:
    return Call(
        "patchAdminConfig",
        _runtime_write(m.RuntimeWrite),
        body=_dump(
            m.RuntimeConfigPatch(set=dict(set) if set else None, unset=unset), m.RuntimeConfigPatch
        ),
        headers=_condition(if_match, create),
    )


def put_config_file(
    name: str, content: bytes, if_match: str | None, create: bool
) -> Call[m.RuntimeFileWrite]:
    return Call(
        "putAdminConfigFile",
        _runtime_write(m.RuntimeFileWrite),
        path_params={"name": name},
        content=content,
        headers=_condition(if_match, create),
    )


def delete_config_file(name: str, if_match: str | None) -> Call[m.RuntimeFileWrite | None]:
    def read_answer(answer: Answer) -> m.RuntimeFileWrite | None:
        if answer.status == 404 and error_code(answer.body) == "no_such_file":
            return None
        return _runtime_write(m.RuntimeFileWrite)(answer)

    return Call(
        "deleteAdminConfigFile",
        read_answer,
        path_params={"name": name},
        headers=_condition(if_match, False),
    )


def put_source(
    id: str, source: Mapping[str, Any], if_match: str | None, create: bool
) -> Call[m.StoredSourceWrite]:
    return Call(
        "putAdminSource",
        _runtime_write(m.StoredSourceWrite, 200, 201),
        path_params={"id": id},
        body=dict(source),
        headers=_condition(if_match, create),
    )


def delete_source(id: str, if_match: str | None) -> Call[m.SourceDeleted | None]:
    def read_answer(answer: Answer) -> m.SourceDeleted | None:
        if answer.status == 404 and error_code(answer.body) == "unknown_source":
            return None
        return _runtime_write(m.SourceDeleted)(answer)

    return Call(
        "deleteAdminSource",
        read_answer,
        path_params={"id": id},
        headers=_condition(if_match, False),
    )


def reseal_secrets() -> Call[m.ResealResult]:
    return Call("resealSecrets", _runtime_write(m.ResealResult))
