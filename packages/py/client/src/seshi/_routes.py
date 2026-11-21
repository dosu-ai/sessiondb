"""Every route of `spec/openapi.yaml` this client calls, by operationId, with the query and
header parameters it handles.

The clients build every request from this table (`_calls.py` checks each call's parameters
against it), and `tests/test_spec_drift.py` checks the table against the spec: a route the spec
gains, drops or moves, or a parameter it adds or removes, fails the test until the client
covers it or `UNCOVERED` says why it does not.
"""

from __future__ import annotations

from dataclasses import dataclass

SESSION = "/v1/sessions/{format}/{session_id}"
ARCHIVE = "/v1/owners/{owner}/sessions/{archive_id}"


@dataclass(frozen=True)
class Route:
    method: str
    path: str
    """The OpenAPI path template; `{name}` segments are percent-encoded when filled in."""
    query: tuple[str, ...] = ()
    headers: tuple[str, ...] = ()
    """Header parameters the client handles, as the spec spells them."""
    auth: bool = True
    """Sends the credential. The three routes made before there is one do not."""


ROUTES: dict[str, Route] = {
    "health": Route("GET", "/healthz", auth=False),
    "authConfig": Route("GET", "/v1/auth/config", auth=False),
    "exchange": Route("POST", "/v1/auth/exchange", auth=False),
    "me": Route("GET", "/v1/me"),
    "listOwners": Route("GET", "/v1/owners", query=("after", "limit")),
    "ingest": Route("POST", "/v1/sessions", headers=("Idempotency-Key", "X-Seshi-Retract")),
    "listSessions": Route("GET", "/v1/sessions", query=("owner", "after", "limit")),
    "staleSessions": Route("GET", "/v1/sessions/stale", query=("after", "limit")),
    "getSession": Route("GET", SESSION, query=("owner",)),
    "setVisibility": Route("PATCH", SESSION, query=("owner",)),
    "tombstone": Route("DELETE", SESSION, query=("owner",), headers=("X-Seshi-Retract",)),
    "getTrace": Route("GET", f"{SESSION}/trace", query=("owner", "hash", "render")),
    "sessionReviews": Route("GET", f"{SESSION}/reviews", query=("owner",)),
    "getSessionByArchive": Route("GET", ARCHIVE),
    "getTraceByArchive": Route("GET", f"{ARCHIVE}/trace", query=("hash", "render")),
    "sessionReviewsByArchive": Route("GET", f"{ARCHIVE}/reviews"),
    "changes": Route("GET", "/v1/changes", query=("owner", "after", "since", "limit")),
    "allChanges": Route("GET", "/v1/changes/all", query=("after", "since", "limit")),
    "search": Route(
        "GET",
        "/v1/search",
        query=(
            "q",
            "owner",
            "agent",
            "repo",
            "branch",
            "harness",
            "agent_version",
            "model",
            "label",
            "source",
            "since",
            "until",
            "sort",
            "limit",
            "matches",
            "cursor",
        ),
    ),
    "redactionRules": Route("GET", "/v1/redaction/rules", headers=("If-None-Match",)),
    "captureRules": Route("GET", "/v1/capture/rules", headers=("If-None-Match",)),
    "createToken": Route("POST", "/v1/tokens"),
    "listTokens": Route("GET", "/v1/tokens", query=("owner", "kind", "all")),
    "revokeOwnerTokens": Route("POST", "/v1/tokens/revoke"),
    "revokeToken": Route("DELETE", "/v1/tokens/{id}"),
    "adminJobs": Route("GET", "/v1/admin/jobs"),
    "adminSources": Route("GET", "/v1/admin/sources", query=("days",)),
    "adminSource": Route("GET", "/v1/admin/sources/{id}", query=("days",)),
    "adminSourceRecords": Route(
        "GET", "/v1/admin/sources/{id}/{kind}", query=("since", "after", "limit")
    ),
    "adminReloadStatus": Route("GET", "/v1/admin/reload"),
    "adminReload": Route("POST", "/v1/admin/reload"),
    "adminConfig": Route("GET", "/v1/admin/config", query=("wait",)),
    "patchAdminConfig": Route("PATCH", "/v1/admin/config", headers=("If-Match", "If-None-Match")),
    "putAdminConfigFile": Route(
        "PUT", "/v1/admin/config/files/{name}", headers=("If-Match", "If-None-Match")
    ),
    "deleteAdminConfigFile": Route(
        "DELETE", "/v1/admin/config/files/{name}", headers=("If-Match",)
    ),
    "putAdminSource": Route("PUT", "/v1/admin/sources/{id}", headers=("If-Match", "If-None-Match")),
    "deleteAdminSource": Route("DELETE", "/v1/admin/sources/{id}", headers=("If-Match",)),
    "resealSecrets": Route("POST", "/v1/admin/secrets/reseal"),
}

UNCOVERED: dict[str, str] = {
    "exportTrace": (
        "the trace getTrace returns, with Content-Disposition for a browser download; use get_trace"
    ),
    "exportTraceByArchive": (
        "the trace getTraceByArchive returns, for a browser download; use get_trace_by_archive"
    ),
    "otlpTraces": "where OTLP exporters (a Claude Console destination) push spans; not a client's",
}
"""Routes in the spec this client leaves out on purpose, and why."""
