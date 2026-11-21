"""The request and response bodies of the seshi API, as `spec/openapi.yaml` and the JSON Schemas
in `spec/schemas/` define them.

Field names are the JSON names, except `schema` (which would shadow pydantic's own attribute),
written `schema_`, and OTLP's camelCase names, written in snake_case; both are read and written
under their JSON names. Times are kept as the RFC 3339 strings the server writes
(`2026-11-14T09:00:00.000Z`), so a cursor or a stamp round-trips byte for byte.

Response models keep fields they do not know (`extra="allow"`), and an enum value they do not
know (`Open`), so a newer server's additions do not break an older client; request models
refuse unknown fields, so a typo fails before it is sent.
`tests/test_spec_drift.py` holds these models to the spec: a property the spec adds, renames or
removes fails it.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal, TypeVar

from pydantic import (
    AliasChoices,
    BaseModel,
    ConfigDict,
    Field,
    ValidationError,
    ValidatorFunctionWrapHandler,
    WrapValidator,
)
from pydantic.alias_generators import to_camel

Format = Literal[
    "claude-code",
    "codex",
    "cursor",
    "opencode",
    "pi",
    "gemini-cli",
    "atif",
    "datadog-trajectory",
    "trajectory",
]
"""A transcript format `POST /v1/sessions` takes, by its trajectory source name: the format the
session is filed under. Sessions other routes file (`otlp-genai`, `cursor-cloud-api`, …) have
formats outside this list."""

Visibility = Literal["org", "owner"]
"""`org`: every member reads it. `owner`: only its owner (admins and services read everything)."""

Scope = Literal[
    "sessions:write", "sessions:read", "sessions:delete", "search", "sources:admin", "tokens:admin"
]
TokenKind = Literal["org", "admin", "device", "service"]
OwnerBasis = Literal["verified", "claimed", "service"]
CallerKind = Literal["person", "device", "service", "admin", "static", "local"]
SourceKind = Literal["upload", "hook", "otlp", "datadog", "s3", "cursor-cloud"]
RenderFormat = Literal["seshi", "letta", "otlp", "atif"]
"""How a trace is returned: `seshi` (`Trace`), `letta` (`LettaTrace`), `otlp` (`OtlpTrace`) or
`atif` (`AtifDocument`)."""
EventRole = Literal[
    "user", "assistant", "tool_call", "tool_result", "system", "observation", "reasoning"
]
RecordKind = Literal["failed", "dropped"]
SearchSort = Literal["relevance", "recent"]

_Known = TypeVar("_Known")


def _known_or_new(value: Any, handler: ValidatorFunctionWrapHandler) -> Any:
    try:
        return handler(value)
    except ValidationError:
        if isinstance(value, str | int) and not isinstance(value, bool):
            return value
        raise


Open = Annotated[_Known, WrapValidator(_known_or_new)]
"""An enum the server answers with: one of the values this client knows, or, from a newer
server, one it does not, kept as the string (or number) the server sent."""


class Response(BaseModel):
    """A body the server sends. Unknown fields are kept, under `model_extra`."""

    model_config = ConfigDict(extra="allow", populate_by_name=True, protected_namespaces=())


class Request(BaseModel):
    """A body the client sends. Unknown fields are refused."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)


# --- Auth (X5) -----------------------------------------------------------------------------


class Health(Response):
    """`GET /healthz`."""

    ok: bool
    version: str


class OidcConfig(Response):
    issuer: str
    client_id: str
    audience: str
    scopes: list[str]


class AuthConfig(Response):
    """`GET /v1/auth/config`: which ways in the server takes (X5.7)."""

    version: str
    org_key: bool
    """The org key is accepted (X5.12)."""
    oidc: OidcConfig | None
    """The IdP to sign in through, or None without one."""
    session_token_seconds: int
    delete_fresh_seconds: int
    """How recent a session token must be to delete (X5.3)."""


class Machine(Request):
    id: str
    name: str | None = None


class ExchangeRequest(Request):
    """`POST /v1/auth/exchange`'s body."""

    id_token: str
    nonce: str | None = None
    machine: Machine | None = None
    """The first sign-in from this machine, or a renewal of its device token (X5.2)."""
    visibility: Visibility | None = None
    """The device token's default visibility (X5.10)."""


class DeviceToken(Response):
    token: str
    id: str
    expires_at: str


class ExchangeResult(Response):
    session_token: str
    expires_at: str
    owner: str
    role: Open[Literal["member", "admin"]]
    scopes: list[Open[Scope]]
    device_token: DeviceToken | None = None


class TokenRequest(Request):
    """`POST /v1/tokens`' body (X5.9)."""

    kind: TokenKind
    owner: str | None = None
    """A person's owner id, for `admin` and `device`."""
    service: str | None = None
    """For `service`: its name, or the configured source it writes for."""
    scopes: list[Scope] | None = None
    visibility: Visibility | None = None
    expires_at: str | None = None
    """RFC 3339."""
    label: str | None = None


class TokenInfo(Response):
    """A token record without its hash."""

    schema_: Literal["seshi/token/1"] = Field(alias="schema")
    id: str
    kind: Open[TokenKind]
    owner: str
    """The owner id, or `*` for the org key."""
    scopes: list[Open[Scope]]
    visibility: Open[Visibility] | None = None
    owner_basis: Open[OwnerBasis] | None = None
    created_at: str
    expires_at: str | None
    revoked: bool
    revoked_at: str | None = None
    label: str | None = None
    created_by: dict[str, Any] | None = None
    machine: dict[str, Any] | None = None
    claims: dict[str, Any] | None = None


class CreatedToken(Response):
    """`POST /v1/tokens`: the token, shown once, and its record."""

    token: str
    record: TokenInfo


class TokenList(Response):
    """`GET /v1/tokens`."""

    tokens: list[TokenInfo]


class RevokedToken(Response):
    """`DELETE /v1/tokens/{id}`: the record, revoked."""

    token: TokenInfo


class OwnerRevocation(Request):
    """`POST /v1/tokens/revoke`'s body."""

    owner: str
    kind: TokenKind | None = None


class RevokedTokens(Response):
    """`POST /v1/tokens/revoke`: the tokens revoked."""

    revoked: list[TokenInfo]


# --- Shared object parts (spec/schemas/common.schema.json) -----------------------------------


class Writer(Response):
    kind: Open[CallerKind]
    principal: str
    credential_id: str | None = None
    source_id: str


class Claims(Response):
    """Identity the data asserts (X5.5), from a fixed allowlist. Never decides ownership."""

    email: str | None = None
    name: str | None = None
    username: str | None = None
    git_email: str | None = None
    git_name: str | None = None
    account_ids: dict[str, str] | None = None


class ClaimsInput(Request):
    """`Claims` as an upload sends them."""

    email: str | None = None
    name: str | None = None
    username: str | None = None
    git_email: str | None = None
    git_name: str | None = None
    account_ids: dict[str, str] | None = None


class SourceLocation(Response):
    object_key: str | None = None
    etag: str | None = None
    cursor: str | None = None


class Provenance(Response):
    source: Open[SourceKind]
    source_id: str
    format: str | None = None
    location: SourceLocation | None = None


class Normalizer(Response):
    name: str
    version: str
    format_version: str | None = None


class Continuation(Response):
    """This trace is the tail of a session already stored."""

    from_record: int
    prefix_sha256: str


class RedactionSummary(Response):
    rule_set: str
    counts: dict[str, int]


class StorageView(Response):
    """Where the sessions go, as a reader would need to know it. Never a secret."""

    url: str
    region: str | None = None
    account_id: str | None = None
    account_name: str | None = None
    endpoint: str | None = None


class Identity(Response):
    """`GET /v1/me`: who the credential is, and where sessions go."""

    owner: str
    storage: StorageView
    kind: Open[Literal["person", "device", "service", "admin", "static"]]
    role: Open[Literal["member", "admin", "service"]]
    scopes: list[Open[Scope]]
    owner_basis: Open[OwnerBasis]
    credential_id: str
    visibility: Open[Visibility] | None = None
    expires_at: str | None = None


class OwnersPage(Response):
    owners: list[str]
    cursor: str | None = None
    """Pass as `after` for the next page."""
    truncated: bool


# --- Sessions -------------------------------------------------------------------------------


class Shipped(Request):
    """What the last answer for this session said: `records_total` as `records`, and
    `prefix_sha256`."""

    records: int
    prefix_sha256: str


class Upload(Request):
    """`POST /v1/sessions`' body: a session to store, whole (`offset` 0) or as a chunk from where
    the last answer's `bytes_total` ended. The server's rules for whole uploads, chunks,
    continuations, forks and resends are in docs/server.md."""

    format: Format | str
    """The format the session is filed under: one of `Format`, or one a newer server knows (the
    server decides)."""
    session_id: str
    transcript: str
    encoding: Literal["jsonl", "json"] | None = None
    """How the log is encoded; `jsonl` by default."""
    offset: int | None = None
    project: str | None = None
    branch: str | None = None
    repo: str | None = None
    """The repository's origin remote, normalized without credentials (`github.com/acme/app`).
    The session keeps the first one it is sent."""
    commit: str | None = None
    path_in_repo: str | None = None
    """The working folder relative to the repository's root; never absolute."""
    client: str | None = None
    """The program that sent the upload (`seshi/0.15.0 darwin-arm64`)."""
    harness_version: str | None = None
    """A hint for a log that names no harness version; the log's own wins."""
    model: str | None = None
    """A hint for a log that names no model; the log's own wins."""
    labels: dict[str, str] | None = None
    """Keys `[a-z0-9][a-z0-9._-]{0,63}`, values up to 512 characters, at most 32. The session keeps
    the first it is sent; a `replace` may change them."""
    parent_session_id: str | None = None
    fork_of: str | None = None
    shipped: Shipped | None = None
    replace: bool | None = None
    rebuild: bool | None = None
    visibility: Visibility | None = None
    claims: ClaimsInput | None = None
    idempotency_key: str | None = None
    retract_hash: str | None = None


class Stored(Response):
    """A trace was written (`stored`), or that trace was already there (`duplicate`)."""

    status: Literal["stored", "duplicate"]
    archive_id: str
    content_hash: str
    session_id: str
    records: int
    """Records this upload wrote (the tail, for a continuation)."""
    events: int
    records_total: int
    prefix_sha256: str
    bytes_total: int
    """Where the next chunk starts."""


class NotWritten(Response):
    """No trace was written: `unchanged`, `filtered` (send the whole log again once it grows)
    or `dropped` by model review."""

    status: Literal["unchanged", "filtered", "dropped"]
    records_total: int
    prefix_sha256: str
    bytes_total: int


IngestResult = Annotated[Stored | NotWritten, Field(discriminator="status")]
"""What storing a session answered."""


class SessionTraceRef(Response):
    content_hash: str
    created_at: str
    records: int
    continuation: Continuation | None = None
    rule_set: str | None = None


class NormalizedState(Response):
    bytes: int
    records: int
    prefix_sha256: str
    hash_state: str


class DroppedPrefix(Response):
    bytes: int
    records: int
    prefix_sha256: str


class AppliedEnvelope(Response):
    idempotency_key: str
    at: str
    status: Open[Literal["stored", "duplicate", "unchanged", "dropped"]]
    content_hash: str | None = None
    records: int | None = None
    events: int | None = None
    records_total: int
    prefix_sha256: str
    bytes_total: int


class SessionMetadata(Response):
    """`seshi/metadata/1`: one session's live pointer (`metadata.json`)."""

    schema_: Literal["seshi/metadata/1"] = Field(alias="schema")
    owner: str
    archive_id: str
    session_id: str
    format: str = Field(validation_alias=AliasChoices("format", "agent"))
    """The format the session is filed under (`agent` from a server older than 0.16)."""
    source: str | None = None
    """The harness: the meta record's `source`."""
    project: str | None = None
    branch: str | None = None
    repo: str | None = None
    """The repository's normalized remote, fixed by the first write that names one."""
    agent_version: str | None = None
    """The harness's version the session started on (Cursor: at its latest upload)."""
    models: list[str] | None = None
    """Every model the session used."""
    labels: dict[str, str] | None = None
    """Set from config by the first write that carries any (the CLI's `[labels]`, a repo's
    `.seshi/config.toml`, a source's `labels`)."""
    parent_session_id: str | None = None
    status: Open[Literal["stored", "redacted"]]
    head: str | None = None
    traces: list[SessionTraceRef]
    normalized: NormalizedState | None = None
    dropped_prefix: DroppedPrefix | None = None
    withheld_calls: dict[str, Open[Literal["sensitive-file", "secret-output"]]] | None = None
    applied: list[AppliedEnvelope] | None = None
    writer: Writer
    owner_basis: Open[OwnerBasis]
    visibility: Open[Visibility]
    claims: Claims | None = None
    redaction: RedactionSummary | None = None
    provenance: Provenance | None = None
    origin_agent: str | None = None
    native_session_id: str | None = None
    normalizer: Normalizer | None = None
    retract_hash: str | None = None
    active_at: str | None = None
    created_at: str
    updated_at: str


class SessionsPage(Response):
    sessions: list[SessionMetadata]
    cursor: str | None = None
    """Pass as `after` for the next page. Absent when the page is empty."""
    truncated: bool


class StaleSession(Response):
    format: str = Field(validation_alias=AliasChoices("format", "agent"))
    session_id: str
    built_with: str | None = None
    """The format version that built it; absent when none was recorded."""
    current: str
    """The format's current normalizer version."""


class StaleSessionsPage(Response):
    sessions: list[StaleSession]
    cursor: str | None = None
    truncated: bool


class VisibilityChange(Request):
    """`PATCH /v1/sessions/{format}/{session_id}`'s body."""

    visibility: Visibility


class Removed(Response):
    """`DELETE /v1/sessions/{format}/{session_id}`: how many objects were deleted."""

    removed: int


# --- Traces (spec/schemas/trace.schema.json and the renderings) ------------------------------


class ToolCall(Response):
    id: str
    name: str
    args: str
    """The arguments as the agent sent them (usually JSON)."""


class MetaRecord(Response):
    """The first record, and only the first: what the session is."""

    role: Literal["meta"]
    source: str
    cwd: str | None = None
    git_branch: str | None = None
    model: str | None = None
    agent_version: str | None = None


class TextRecord(Response):
    """A user prompt, a system message, an observation, or the model's reasoning."""

    role: Literal["user", "system", "observation", "reasoning"]
    content: str
    timestamp: str
    id: str | None = None
    llm_call: str | None = None
    synthetic: bool | None = None
    omitted: int | None = None


class AssistantRecord(Response):
    role: Literal["assistant"]
    content: str | None
    tool_calls: list[ToolCall] | None = None
    timestamp: str
    id: str | None = None
    llm_call: str | None = None


class ToolResultRecord(Response):
    role: Literal["tool"]
    tool_call_id: str
    content: str
    ok: bool | None = None
    timestamp: str
    id: str | None = None
    withheld: Open[Literal["sensitive-file", "secret-output", "review"]] | None = None
    duration_ms: float | None = None


TraceRecord = Annotated[
    MetaRecord | TextRecord | AssistantRecord | ToolResultRecord, Field(discriminator="role")
]


class TraceEvent(Response):
    """One unit of a trace; `index` is stable for the object's lifetime."""

    index: int
    role: Open[EventRole]
    text: str
    timestamp: str | None
    tool_name: str | None = None
    tool_call_id: str | None = None
    ok: bool | None = None


class TokenUsage(Response):
    input_tokens: int | None = None
    output_tokens: int | None = None
    cache_read_input_tokens: int | None = None
    cache_creation_input_tokens: int | None = None
    reasoning_tokens: int | None = None
    total_tokens: int | None = None


class LlmCall(Response):
    id: str
    model: str | None = None
    provider: str | None = None
    started_at: str | None = None
    ended_at: str | None = None
    duration_ms: float | None = None
    usage: TokenUsage | None = None
    stop_reason: str | None = None
    request_id: str | None = None
    parameters: dict[str, str | float | bool | None] | None = None
    error: str | None = None


class TraceMetadata(Response):
    cwd: str | None = None
    git_branch: str | None = None
    model: str | None = None
    agent_version: str | None = None
    commit: str | None = None
    path_in_repo: str | None = None
    client: str | None = None
    parent_session_id: str | None = None
    continuation: Continuation | None = None
    normalizer: Normalizer | None = None
    labels: dict[str, str] | None = None
    """The labels the write that stored this trace carried."""


class Trace(Response):
    """`seshi/trace/1`: the stored canonical trace (`?format=seshi`, the default)."""

    schema_: Literal["seshi/trace/1"] = Field(alias="schema")
    content_hash: str
    source: str
    format: str = Field(validation_alias=AliasChoices("format", "agent"))
    """The format the session is filed under (`agent` from a server older than 0.16)."""
    project: str | None = None
    branch: str | None = None
    session_id: str | None
    started_at: str | None
    ended_at: str | None
    records: list[TraceRecord]
    events: list[TraceEvent]
    metadata: TraceMetadata
    llm_calls: list[LlmCall] | None = None
    provenance: Provenance | None = None


class LettaTrace(Response):
    """A trace rendered as Letta trajectory-v1 (`?format=letta`)."""

    schema_: Literal["sessionstorage/trace/1"] = Field(alias="schema")
    content_hash: str
    source: str
    agent: str
    project: str | None = None
    branch: str | None = None
    session_id: str | None
    started_at: str | None
    ended_at: str | None
    records: list[TraceRecord]
    events: list[TraceEvent]
    metadata: TraceMetadata


class AtifAgent(Response):
    name: str
    version: str
    model_name: str | None = None


class AtifStep(Response):
    step_id: int
    source: Open[Literal["system", "user", "agent"]]
    message: str


class AtifDocument(Response):
    """A trace rendered as an ATIF-v1.7 document (`?format=atif`)."""

    schema_version: Literal["ATIF-v1.7"]
    session_id: str | None = None
    agent: AtifAgent
    steps: list[AtifStep]
    final_metrics: dict[str, Any] | None = None
    extra: dict[str, Any] | None = None


class _Otlp(Response):
    model_config = ConfigDict(
        extra="allow", populate_by_name=True, protected_namespaces=(), alias_generator=to_camel
    )


class OtlpAnyValue(_Otlp):
    string_value: str | None = None
    bool_value: bool | None = None
    int_value: str | None = None
    double_value: float | None = None


class OtlpKeyValue(_Otlp):
    key: str
    value: OtlpAnyValue


class OtlpSpanStatus(_Otlp):
    code: Open[Literal[0, 1, 2]]
    message: str | None = None


class OtlpSpan(_Otlp):
    trace_id: str
    span_id: str
    parent_span_id: str | None = None
    name: str
    kind: int
    start_time_unix_nano: str
    end_time_unix_nano: str
    attributes: list[OtlpKeyValue]
    status: OtlpSpanStatus


class OtlpScope(_Otlp):
    name: str
    version: str


class OtlpScopeSpans(_Otlp):
    scope: OtlpScope
    spans: list[OtlpSpan]


class OtlpResource(_Otlp):
    attributes: list[OtlpKeyValue]


class OtlpResourceSpans(_Otlp):
    resource: OtlpResource
    scope_spans: list[OtlpScopeSpans]


class OtlpTrace(_Otlp):
    """A trace rendered as OTLP (`?format=otlp`): an OTLP/HTTP JSON `ExportTraceServiceRequest`.
    `model_dump(by_alias=True)` gives a body a collector's `/v1/traces` takes as-is."""

    resource_spans: list[OtlpResourceSpans]


StoredTrace = Trace | LettaTrace | OtlpTrace | AtifDocument
"""A stored trace as it was asked for: the canonical trace, or a rendering of it."""


# --- Change feed ----------------------------------------------------------------------------


class ChangeEntry(Response):
    """`seshi/change/1`: one entry of an owner's change feed."""

    schema_: Literal["seshi/change/1"] = Field(alias="schema")
    kind: Open[Literal["published", "tombstone", "visibility_changed"]]
    at: str
    owner: str
    archive_id: str
    session_id: str
    format: str
    """The format the session is filed under, which the session routes take."""
    content_hash: str | None
    continuation: Continuation | None = None
    replace: bool | None = None
    writer: Writer
    owner_basis: Open[OwnerBasis] | None = None
    reason: Open[Literal["deleted", "retracted", "redacted"]] | None = None
    visibility: Open[Visibility] | None = None


class Change(Response):
    key: str
    """The object key; the cursor for everything up to and including it."""
    entry: ChangeEntry


class ChangesPage(Response):
    entries: list[Change]
    cursor: str | None = None
    """The last key on the page; pass as `after`. Absent when the page is empty."""
    truncated: bool


class OwnedChange(Response):
    owner: str
    key: str
    """The entry's object key; dedupe by it."""
    entry: ChangeEntry


class AllChangesPage(Response):
    entries: list[OwnedChange]
    cursor: str | None = None
    """Opaque; pass as `after`. Absent when the page is empty."""
    truncated: bool
    through: str
    """Every owner's feed had been read up to this time."""


# --- Redaction rules (F2.4) -----------------------------------------------------------------


class RuleTests(Response):
    match: list[str]
    no_match: list[str]


class PackRule(Response):
    id: str
    description: str | None = None
    patterns: list[str]
    replacement: str | None = None
    applies_to: list[Open[Literal["text", "tool_input", "tool_output"]]]
    tests: RuleTests | None = None


class SensitiveFileRule(Response):
    id: str
    description: str | None = None
    globs: list[str]
    tests: RuleTests | None = None


class SecretCommandRule(Response):
    id: str
    description: str | None = None
    patterns: list[str]
    tests: RuleTests | None = None


class RulePack(Response):
    id: str
    version: str | None = None
    description: str | None = None
    disable: list[str]
    rules: list[PackRule]
    sensitive_files: list[SensitiveFileRule]
    secret_commands: list[SecretCommandRule]


class RedactionRules(Response):
    """`seshi/redaction-rules/1`: the operator's rule packs, for redacting before upload."""

    schema_: Literal["seshi/redaction-rules/1"] = Field(alias="schema")
    rule_set: str
    builtin: str
    packs: list[RulePack]


class RedactionRulesAnswer(Response):
    """`redaction_rules_since`: the document and the ETag to send next time."""

    document: RedactionRules
    etag: str | None = None


class CaptureRules(Response):
    """`seshi/capture-rules/1`: the org's exclude list and tool-call redaction list, which laptops
    apply before upload. `redact_tool_calls` is None from a server older than that list."""

    schema_: Literal["seshi/capture-rules/1"] = Field(alias="schema")
    exclude: list[str]
    redact_tool_calls: list[str] | None = None


class CaptureRulesAnswer(Response):
    """`capture_rules_since`: the document and the ETag to send next time."""

    document: CaptureRules
    etag: str | None = None


# --- Model review (F3.8) --------------------------------------------------------------------


class ReviewFinding(Response):
    record: int
    field: str
    category: str
    action: Open[Literal["redact", "withhold"]]


class ReviewFailure(Response):
    step: Open[Literal["decision", "redactor"]]
    code: str
    attempts: int


class ReviewDecision(Response):
    """One stored write's model review. Callers who are not admins get `schema`, `n`, `at`,
    `content_hash` and `decision` only."""

    schema_: Literal["seshi/review/1"] = Field(alias="schema")
    n: int
    at: str
    content_hash: str
    decision: Open[Literal["allow", "redact", "skipped"]]
    policy: str | None = None
    policy_hash: str | None = None
    decision_model: str | None = None
    redactor_model: str | None = None
    findings: list[ReviewFinding] | None = None
    unmatched: int | None = None
    parts: int | None = None
    failure: ReviewFailure | None = None


class ReviewsPage(Response):
    reviews: list[ReviewDecision]


# --- Search (F10) ---------------------------------------------------------------------------


class SearchRequest(Request):
    """A search: keywords plus filters. Every filter narrows; none widens what the caller may
    read, which the server decides (F10.4)."""

    q: str
    """Words (all in one record), `"a phrase"`, `word*`, `a OR b`, `-word`."""
    owner: str | None = None
    agent: str | None = None
    repo: str | None = None
    """The session's `repo` (its normalized remote), exactly or as its last path segments."""
    branch: str | None = None
    harness: str | None = None
    """The meta record's `source` (`claude-code`, `codex`, `cursor`)."""
    agent_version: str | None = None
    model: str | None = None
    """Any model the session used."""
    label: list[str] | None = None
    """Labels a session must carry, each `key=value` (`SeshiClient.search` takes a dict)."""
    source: str | None = None
    since: str | None = None
    until: str | None = None
    sort: SearchSort | None = None
    limit: int | None = None
    """Sessions per page: 1 to 100, 20 by default."""
    matches: int | None = None
    """Matching records shown per session: 0 to 20, 3 by default."""
    cursor: str | None = None


class SearchMatch(Response):
    content_hash: str
    event_index: int
    role: Open[EventRole]
    tool_name: str | None = None
    timestamp: str | None = None
    snippet: str
    highlights: list[tuple[int, int]]
    """The matched words in `snippet`: `[start, end)` offsets in UTF-16 code units."""


class SearchResult(Response):
    owner: str
    format: str = Field(validation_alias=AliasChoices("format", "agent"))
    session_id: str
    archive_id: str
    origin_agent: str | None = None
    native_session_id: str | None = None
    project: str | None = None
    branch: str | None = None
    repo: str | None = None
    harness: str | None = None
    agent_version: str | None = None
    models: list[str] | None = None
    labels: dict[str, str] | None = None
    source_id: str | None = None
    visibility: Open[Visibility]
    started_at: str | None = None
    ended_at: str | None = None
    updated_at: str
    score: float
    hits: int
    matches: list[SearchMatch]


class SearchIndexState(Response):
    ready_at: str
    caught_up_at: str | None = None
    sessions: int


class SearchResults(Response):
    query: str
    total: int
    results: list[SearchResult]
    cursor: str | None = None
    """Pass as `cursor` for the next page; absent on the last."""
    index: SearchIndexState


# --- Admin (X7.5, X6.4, F1.5) ---------------------------------------------------------------


class Checkpoint(Response):
    updated_at: str
    cursor: dict[str, Any]


class SourceStatus(Response):
    """A source's state: checkpoint, record counts and health over the days asked for."""

    id: str
    type: str
    enabled: bool
    polled: bool
    connector: str | None = None
    interval_ms: int | None = None
    note: str | None = None
    checkpoint: Checkpoint | None
    dropped: int
    failed: int
    health: dict[str, int]


class SourceDetail(SourceStatus):
    """`GET /v1/admin/sources/{id}`: a source's status, and where it is set."""

    managed: Literal["file", "store", "builtin"]
    """The server's files, the bucket (`put_source`), or built in (`upload`)."""
    config: dict[str, Any] | None = None
    """A stored source's settings, each sealed secret as a `SecretView`."""
    etag: str | None = None
    """A stored source's ETag, for `put_source(if_match=…)`."""
    updated_at: str | None = None
    running: bool | None = None
    """A stored source this instance runs."""


class SourceList(Response):
    """`GET /v1/admin/sources`."""

    sources: list[SourceStatus]


class SourceRecord(Response):
    """A drop or failure record: that an envelope arrived and why it was not stored, never its
    content."""

    schema_: Literal["seshi/dropped/1", "seshi/failed/1"] = Field(alias="schema")
    at: str
    source: str
    source_kind: str | None = None
    owner: str | None = None
    session_key: str | None = None
    idempotency_key: str
    provenance: dict[str, Any] | None = None
    code: str | None = None
    message: str | None = None
    reason: Open[Literal["review_drop", "review_failed"]] | None = None
    policy: str | None = None
    policy_hash: str | None = None
    decision_model: str | None = None


class SourceRecordItem(Response):
    key: str
    record: SourceRecord


class RecordsPage(Response):
    source: str
    kind: Open[RecordKind]
    records: list[SourceRecordItem]
    cursor: str | None = None
    """The last key on the page; pass as `after`."""
    truncated: bool


class JobError(Response):
    at: str
    message: str


class JobRecord(Response):
    last_started: str | None = None
    last_finished: str | None = None
    last_outcome: Open[Literal["ok", "error", "discarded"]] | None = None
    last_ok: str | None = None
    last_error: JobError | None = None
    runs: int
    failures: int
    last_summary: dict[str, float] | None = None


class JobStatus(Response):
    name: str
    kind: str
    placement: Open[Literal["worker", "every"]]
    interval_ms: int
    source: str | None = None
    last: JobRecord | None = None
    backlog: dict[str, float] | None = None
    dropped: int | None = None
    failed: int | None = None


class OtherWorker(Response):
    instance: str
    at: str


class WorkerStatus(Response):
    state: Open[Literal["running", "stopped", "never", "several"]]
    instance: str | None = None
    host: str | None = None
    version: str | None = None
    roles: list[str] | None = None
    started_at: str | None = None
    last_heartbeat: str | None = None
    age_ms: int | None = None
    others: list[OtherWorker]


class InstanceInfo(Response):
    id: str
    process: str
    roles: list[Open[Literal["api", "worker"]]]
    version: str


class JobsStatus(Response):
    """`GET /v1/admin/jobs`: the worker, its jobs and every source."""

    at: str
    deployment: str
    instance: InstanceInfo
    worker: WorkerStatus
    jobs: list[JobStatus]
    sources: list[SourceStatus]
    warnings: list[str]


class ReloadSources(Response):
    added: list[str]
    removed: list[str]
    changed: list[str]
    unchanged: list[str]


class ReloadReport(Response):
    """One config reload (F1.5)."""

    trigger: Open[Literal["signal", "api", "watch", "manual"]]
    started_at: str
    finished_at: str
    outcome: Open[Literal["applied", "unchanged", "rejected"]]
    generation: int
    config_hash: str
    rule_set: str
    review_set: str | None
    errors: list[str] | None = None
    changed: list[str]
    sources: ReloadSources | None = None
    restart_required: list[str]


class RuntimeHere(Response):
    """With `server.runtime_config = store`: the bucket's runtime config version, the one this
    instance runs, and why they differ when they do."""

    version: str
    applied: str
    applied_at: str
    last_sync: str | None
    problem: str | None = None


class ConfigStatus(Response):
    """`GET /v1/admin/reload`: the running config's generation and hash, and the last reload."""

    generation: int
    config_hash: str
    rule_set: str
    review_set: str | None
    loaded_at: str
    reloadable: bool
    restart_required: list[str]
    last_reload: ReloadReport | None
    live_sections: list[str]
    restart_only_sections: list[str]
    runtime: RuntimeHere | None = None
    """With `server.runtime_config = store`: the bucket's version and the one running here."""


class RuntimeInstance(Response):
    """What one instance last said about the runtime config it runs."""

    schema_: Literal["seshi/runtime-instance/1"] = Field(alias="schema")
    instance: str
    process: str
    seshi: str
    version: str
    applied_at: str
    at: str
    problem: str | None = None
    current: bool
    """It runs the bucket's current version."""


class RuntimeDocFile(Response):
    name: str
    etag: str


class RuntimeDoc(Response):
    etag: str | None = None
    """`config/seshi.toml`'s ETag, for `patch_runtime_config(if_match=…)`; None when the bucket
    has none (create it with `create=True`)."""
    settings: dict[str, Any]
    """`config/seshi.toml` as stored, its paths as written."""
    files: list[RuntimeDocFile]


class RuntimeConfigStatus(Response):
    """`GET /v1/admin/config`: the runtime config in the bucket and which instances run it. On
    a file-only server `runtime_config` is `file` and only `effective` is given."""

    runtime_config: Literal["file", "store"]
    version: str | None = None
    here: RuntimeHere | None = None
    converged: bool | None = None
    instances: list[RuntimeInstance] | None = None
    doc: RuntimeDoc | None = None
    locked: list[str] | None = None
    """Settings the server's files set, which cannot be changed through the API."""
    effective: dict[str, Any]
    """The data policy in effect on the instance that answered (secrets masked)."""


class RuntimeConfigPatch(Request):
    """`PATCH /v1/admin/config`'s body: dotted paths under the runtime sections."""

    set: dict[str, Any] | None = None
    unset: list[str] | None = None


class RuntimeWrite(Response):
    """`PATCH /v1/admin/config`: the new `config/seshi.toml` ETag and the bucket's version."""

    etag: str
    version: str


class RuntimeFileWrite(Response):
    """A file under `config/` written or removed."""

    name: str
    etag: str | None = None
    deleted: bool | None = None
    version: str


class SecretView(Response):
    """What may be said of a stored secret; never its value."""

    set: Literal[True]
    fingerprint: str
    """An HMAC of the value under the sealing key: the same value shows the same fingerprint
    until the next reseal."""
    key_id: str
    updated_at: str


class StoredSourceWrite(Response):
    """`PUT /v1/admin/sources/{id}`: the source as stored (sealed secrets as `SecretView`s)."""

    id: str
    etag: str
    source: dict[str, Any]
    version: str


class SourceDeleted(Response):
    """`DELETE /v1/admin/sources/{id}`."""

    id: str
    deleted: bool
    version: str


class ResealResult(Response):
    """`POST /v1/admin/secrets/reseal`: which stored sources were sealed again with `key_id`,
    which changed meanwhile and were skipped, and which already were."""

    key_id: str | None
    resealed: list[str]
    changed: list[str]
    current: list[str]


class ReloadResult(Response):
    """`POST /v1/admin/reload`: how the reload went, and the config now running. A rejected
    reload is one of these too (`reload.outcome == "rejected"`, with its `errors`)."""

    reload: ReloadReport
    config: ConfigStatus
