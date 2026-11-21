# The client libraries

A client for the seshi API in TypeScript and in Python, both at the same version as the binary:
[`@dosu/seshi-client`](#dosuseshi-client) and [`seshi`](#python-seshi), the Python one.

Two TypeScript libraries are published to npm at every release ([install.md](install.md#npm)),
as ES modules for Node 20+ and Bun with TypeScript declarations:

| Package | What it is |
|---|---|
| `@dosu/seshi-client` | The typed HTTP client for a seshi server. Depends only on `@dosu/seshi-model` |
| `@dosu/seshi-model` | The types every part of seshi shares (the canonical trace, the stored objects, the session API), canonical text and hashing, and trace validation |

They are for programs that talk to a server: an uploader of your own, a reader that tails the
change feed, a tool that searches. To capture sessions on a laptop, use the `seshi` binary
([capture.md](capture.md)); to write a bucket without a server, use the CLI's serverless mode
([serverless.md](serverless.md)). There is no library that writes a bucket directly
(X3.5): the server, or the in-process Instance serverless mode builds, is the only writer, so
redaction always runs.

## `@dosu/seshi-client`

```sh
npm i @dosu/seshi-client      # or bun add @dosu/seshi-client
```

```ts
import { HttpSeshi, OffsetMismatch } from "@dosu/seshi-client";

const db = new HttpSeshi({
  server: "https://seshi.acme.internal",
  token: process.env.ACME_SESHI_TOKEN!,   // a device, service, admin or static token, or the org key
  user: "alice@acme.com",            // with the org key only: the username to write as
});

const answer = await db.ingest({
  format: "claude-code",
  session_id: "8f1c…",
  transcript: await Bun.file("8f1c….jsonl").text(),
  project: "github.com/acme/widget",
});
// { status: "stored", content_hash: "…", records_total: 41, bytes_total: 48213, … }

// As the log grows, send only what it gained, from where the last answer ended.
await db.ingest({ format: "claude-code", session_id: "8f1c…", transcript: tail, offset: answer.bytes_total });

const session = await db.getSession("claude-code", "8f1c…");
const trace = await db.getTrace("claude-code", "8f1c…", undefined, "otlp");
const page = await db.listSessions({ limit: 50 });
const feed = await db.changes({ after: cursor });
const everyone = await db.allChanges({ after: allCursor });   // a service token or an admin
const found = await db.search({ q: "flaky checkout test", repo: "widget", sort: "recent" });
```

Keep your program's own variables out of the `SESHI_` namespace (the example reads
`ACME_SESHI_TOKEN`): the `seshi` CLI and server read every `SESHI_*` variable as a setting,
and refuse to start on one that is not ([config.md](config.md)).

The rules for whole uploads, chunks, continuations, forks and resends are the server's
([server.md](server.md#post-v1sessions)); the client sends what you give it and maps the
answer back.

### Calls

| Call | Route |
|---|---|
| `ingest(upload)` | `POST /v1/sessions` |
| `getSession(format, id, {owner})` | `GET /v1/sessions/:format/:id`; null when not stored or not readable |
| `getTrace(format, id, hash?, render?, {owner})` | `GET …/trace`, rendered as `seshi` (default), `letta`, `otlp` or `atif` ([formats.md](formats.md#what-seshi-writes)); null when not stored or redacted |
| `listSessions({owner, limit, after})` | `GET /v1/sessions` |
| `staleSessions({limit, after})` | `GET /v1/sessions/stale`: the caller's sessions an older normalizer built, to resend with `rebuild` |
| `tombstone(format, id, {owner, retractSecret})` | `DELETE /v1/sessions/:format/:id`, or a retraction with the uploading machine's secret |
| `setVisibility(format, id, visibility, {owner})` | `PATCH /v1/sessions/:format/:id` |
| `reviews(format, id, {owner})` | `GET …/reviews`: what model review decided for each write |
| `getSessionByArchive(owner, archiveId)`, `getTraceByArchive(owner, archiveId, hash?, render?)`, `reviewsByArchive(owner, archiveId)` | `GET /v1/owners/:owner/sessions/:archive_id` and its `/trace` and `/reviews`: the same, by the owner and archive id a change entry or search result names |
| `changes({after, since, limit})` | `GET /v1/changes`: the caller's change feed |
| `allChanges({after, since, limit})` | `GET /v1/changes/all`: every owner's change feed as one, each entry with its `owner`; `after` is the last page's opaque `cursor`. For service tokens and admins (`Forbidden` for anyone else); a `ServerError` with status 503 while the server's search index is first built, 404 with search off ([server.md](server.md#every-owners-change-feed)) |
| `search(request)` | `GET /v1/search` ([search.md](search.md)) |
| `me()` | `GET /v1/me`: who the credential is, and which bucket the server writes |
| `owners({after, limit})` | `GET /v1/owners` |
| `redactionRules()`, `redactionRulesSince(etag)` | `GET /v1/redaction/rules`, for redacting before upload |
| `captureRulesSince(etag)` | `GET /v1/capture/rules`: the org's exclude list, which laptops apply before upload (404 from an older server) |
| `createToken`, `listTokens`, `revokeToken`, `revokeOwnerTokens` | `/v1/tokens` (admins) |
| `jobs()`, `sources({days})`, `source(id)`, `records(kind, id, …)` | `/v1/admin/jobs` and `/v1/admin/sources` (admins) |
| `reload()`, `configStatus()` | `POST` and `GET /v1/admin/reload`: apply the config files again, and the running config's generation (admins). A rejected reload is returned with its `errors`, not thrown |
| `runtimeConfig({wait})`, `patchRuntimeConfig({set, unset}, {ifMatch, create})`, `putConfigFile(name, content, …)`, `deleteConfigFile(name, …)`, `putSource(id, source, …)`, `deleteSource(id, …)`, `resealSecrets()` | The runtime config in the bucket, on a server with `server.runtime_config = "store"` ([config.md](config.md#runtime-config-in-the-bucket-serverruntime_config--store)) (admins). Writes are checked before anything is written and made with `If-Match` (`ifMatch`, the ETag read) or `If-None-Match: *` (`create`); a source's secrets are sealed and never returned |

`authConfig({server})` and `exchangeIdToken({server}, request)` are the two calls made before
there is a token: which ways in the server takes, and an IdP ID token for a seshi session token
(X5.7).

### Options

`HttpSeshi` takes `server`, `token`, and:

| Option | |
|---|---|
| `user` | With the org key: the username to write as, sent as `X-Seshi-User` |
| `timeoutMs` | Per request; default 120 s, the server's own idle timeout; 0 disables |
| `gzipFrom` | Bodies larger than this many bytes are sent gzipped; default 8 KiB |
| `userAgent` | Sent as `User-Agent`, so the server's logs name your program (default `@dosu/seshi-client/<version>`) |
| `fetch` | A `fetch` of your own, for tests and custom transports |

### Errors

A refusal the server maps to a status comes back as the error the pipeline would have thrown:

| Error | When |
|---|---|
| `SessionRejected` (`code`) | A transcript that cannot be stored: `unsupported_agent`, `too_large`, `bad_chunk`, `normalize_<code>`… Resending the same bytes cannot succeed |
| `OffsetMismatch` (`expected`) | A chunk that does not start where the server's copy of the log ends; resend from `expected` |
| `SessionConflict` | A whole upload that does not extend the stored session; send it with `replace` if you are its original writer |
| `Forbidden` | The credential may not do this |
| `StoreError` | The server's bucket failed; retry |
| `PreconditionFailed` | A runtime config write whose `ifMatch`/`create` did not hold; read again and redo it |
| `ConfigRejected` (`code`, `problems`) | A runtime config change that would not load or check (`invalid`), or a secret that cannot be sealed (`sealing`); nothing was written |
| `ServerError` (`status`, `code`) | Any other answer |

## `@dosu/seshi-model`

The shared types (`SessionMetadata`, `ChangeEntry`, `StoredTrace`, the envelope, the search
types), and the functions every implementation must agree on: `canonicalText` and
`canonicalJson`, `prefixSha256` and `PrefixHash` (the hash of a session's records so far), and
`parseTrace`, which checks a canonical trace. A reader that tails the change feed and reads
traces uses these to understand what it reads.

## Python: `seshi`

The Python client lives in [`packages/py/client`](../packages/py/client): Python 3.10+, on
[httpx](https://www.python-httpx.org/) and [pydantic](https://docs.pydantic.dev/) v2, with a sync
client (`SeshiClient`) and an async one (`AsyncSeshiClient`) that have the same calls. It is
published to PyPI as `seshi` at every release, at the binary's version
([releasing.md](releasing.md#pypi)):

```sh
pip install seshi        # or: uv add seshi
```

```python
import os
from seshi import OffsetMismatch, SeshiClient, Upload

with SeshiClient(
    "https://seshi.acme.internal",
    os.environ["ACME_SESHI_TOKEN"],   # a device, service, admin or static token, or the org key
    user="alice@acme.com",            # with the org key only: the username to write as
) as db:
    answer = db.ingest(Upload(format="claude-code", session_id="8f1c…", transcript=log))
    # Stored(status='stored', content_hash='…', records_total=41, bytes_total=48213, …)

    # As the log grows, send only what it gained, from where the last answer ended.
    try:
        db.ingest(Upload(format="claude-code", session_id="8f1c…", transcript=tail,
                         offset=answer.bytes_total))
    except OffsetMismatch as err:
        ...                                # resend from err.expected

    session = db.get_session("claude-code", "8f1c…")
    trace = db.get_trace("claude-code", "8f1c…", render="otlp")   # an OtlpTrace
    page = db.list_sessions(limit=50)
    for change in db.iter_changes(after=cursor):                 # every page to the end
        cursor = change.key
    for change in db.iter_all_changes(since="2026-11-01T00:00:00.000Z"):   # a service token or an admin
        trace = db.get_trace_by_archive(change.owner, change.entry.archive_id)
    found = db.search("flaky checkout test", repo="widget", sort="recent")
```

```python
from seshi import AsyncSeshiClient

async with AsyncSeshiClient(server, token) as db:
    async for change in db.iter_changes():
        ...
```

Every request and response body is a pydantic model (`seshi.models`) with the JSON's field
names, except `schema`, which is `schema_`, and OTLP's camelCase, which is snake_case; both
are read and written under their JSON names (`model_dump(by_alias=True)`). Times stay the RFC
3339 strings the server writes, so a stamp or cursor round-trips exactly; a `since` or `until`
may also be a `datetime`. Response models keep fields they do not know (in `model_extra`), and
an enum value they do not know as the string the server sent, so an older client reads a newer
server; request models refuse unknown fields, but `Upload.format` takes any format name, which
the server decides on. A response model also reads a format sent as `agent`, as servers before
0.16 sent it. A call that takes a body
takes its model or a plain mapping (`db.ingest({"format": "codex", …})`).

### Calls

The same calls as `@dosu/seshi-client`, in snake_case:

| Python | TypeScript | Route |
|---|---|---|
| `ingest(upload, retract_secret=, idempotency_key=)` | `ingest(upload, {retractSecret})` | `POST /v1/sessions`; `idempotency_key` is sent as `Idempotency-Key` |
| `get_session(format, id, owner=)` | `getSession` | `GET /v1/sessions/:format/:id`; None when not stored or not readable |
| `get_trace(format, id, hash=, render=, owner=)` | `getTrace` | `GET …/trace`; the model `render` names (`Trace`, `LettaTrace`, `OtlpTrace`, `AtifDocument`), None when not stored or redacted |
| `list_sessions(owner=, after=, limit=)`, `iter_sessions(owner=, limit=)` | `listSessions` | `GET /v1/sessions`, a page or every page |
| `stale_sessions(after=, limit=)` | `staleSessions` | `GET /v1/sessions/stale` |
| `tombstone(format, id, owner=, retract_secret=)` | `tombstone` | `DELETE /v1/sessions/:format/:id` |
| `set_visibility(format, id, visibility, owner=)` | `setVisibility` | `PATCH /v1/sessions/:format/:id` |
| `reviews(format, id, owner=)` | `reviews` | `GET …/reviews` |
| `get_session_by_archive(owner, archive_id)`, `get_trace_by_archive(owner, archive_id, hash=, render=)`, `reviews_by_archive(owner, archive_id)` | `getSessionByArchive`, `getTraceByArchive`, `sessionReviewsByArchive` | `GET /v1/owners/:owner/sessions/:archive_id` and its `/trace` and `/reviews`: the same, by the owner and archive id a change entry or search result names |
| `changes(owner=, after=, since=, limit=)`, `iter_changes(…)` | `changes` | `GET /v1/changes`, a page or every page to the end |
| `all_changes(after=, since=, limit=)`, `iter_all_changes(…)` | `allChanges` | `GET /v1/changes/all`, a page or every page up to `through` |
| `search(q, owner=, agent=, repo=, branch=, harness=, agent_version=, model=, labels=, source=, since=, until=, sort=, limit=, matches=, cursor=)` | `search` | `GET /v1/search` (`labels` a dict, each sent as `label=key=value`) |
| `me()` | `me` | `GET /v1/me` |
| `owners(after=, limit=)` | `owners` | `GET /v1/owners` |
| `redaction_rules()`, `redaction_rules_since(etag)` | `redactionRules`, `redactionRulesSince` | `GET /v1/redaction/rules`, as a `RedactionRules` model |
| `capture_rules()`, `capture_rules_since(etag)` | `captureRulesSince` | `GET /v1/capture/rules`, as a `CaptureRules` model |
| `create_token`, `list_tokens(owner=, kind=, all=)`, `revoke_token`, `revoke_owner_tokens` | the same | `/v1/tokens` (admins) |
| `jobs()`, `sources(days=)`, `source(id, days=)`, `records(kind, id, since=, after=, limit=)` | the same | `/v1/admin/jobs` and `/v1/admin/sources` (admins) |
| `reload()`, `config_status()` | the same | `POST` and `GET /v1/admin/reload` (admins); a rejected reload is returned, not raised |
| `runtime_config(wait=)`, `patch_runtime_config(set=, unset=, if_match=, create=)`, `put_config_file`, `delete_config_file`, `put_source(id, source, if_match=, create=)`, `delete_source`, `reseal_secrets()` | `runtimeConfig`, `patchRuntimeConfig`, … | The runtime config in the bucket (`server.runtime_config = "store"`, admins) |
| `health()` | | `GET /healthz` |
| `auth_config()`, `exchange_id_token(request)` | `authConfig`, `exchangeIdToken` | Sent without a credential: a client built without a token makes them, as do the module functions `seshi.auth_config(server)` and `seshi.exchange_id_token(server, request)` |

Two routes are left out on purpose: `GET …/export` (the trace `get_trace` returns, as a browser
download) and `POST /otlp/v1/traces` (where OTLP exporters push spans).

### Options

`SeshiClient(server, token=None, *, …)` and `AsyncSeshiClient` take:

| Option | |
|---|---|
| `user` | With the org key: the username to write as, sent as `X-Seshi-User` |
| `timeout` | Seconds per request; default 120, the server's own idle timeout; 0 or None disables |
| `gzip_from` | Bodies of this many bytes or more are sent gzipped; default 8 KiB |
| `user_agent` | Sent as `User-Agent` (default `seshi-python/<version>`) |
| `http_client` | An `httpx.Client` (`httpx.AsyncClient`) of your own; `close()` leaves it open |
| `transport` | An httpx transport, for tests (`httpx.MockTransport`) and custom transports |

Use a client as a context manager (`with` / `async with`), or call `close()` / `aclose()`.

### Errors

The same errors as `@dosu/seshi-client`, in `seshi.errors` and at the top level, all
`SeshiError`s: `SessionRejected` (`code`), `OffsetMismatch` (`offset`, `expected`),
`SessionConflict`, `Forbidden`, `StoreError` (also a server that cannot be reached),
`PreconditionFailed` and `ConfigRejected` (`code`, `problems`) from the runtime config calls,
and `ServerError` (`status`, `code`) for any other answer. A response that does not match its model
is pydantic's `ValidationError`.

## Other languages

The contract is in [`spec/`](../spec): the object layout ([`layout.md`](../spec/layout.md)), the
HTTP API ([`openapi.yaml`](../spec/openapi.yaml)), the JSON Schemas of the trace, the envelope
and the stored objects ([`schemas/`](../spec/schemas)), and the record sets and goldens every
implementation must reproduce ([`testdata/`](../spec/testdata)). `seshi normalize` turns any
transcript the binary reads into canonical, redacted records on stdout, for tools that want
seshi's normalizer without linking it (X3.10).

A client of the API in another language lives in this repository beside the two above
(`packages/<language>/client`), is released at the binary's version, and follows what they do:

- The calls of `@dosu/seshi-client`, under the language's own naming, with typed request and
  response bodies.
- The same errors for the same answers: `409 offset_mismatch` is `OffsetMismatch` (with the
  offset sent and `expected`), `409 conflict` `SessionConflict`, `403 forbidden` `Forbidden`,
  `422` `SessionRejected` (with its `code`), `502` and an unreachable server `StoreError`, and
  anything else a `ServerError` with its status and code. A read of something not there
  (`404`, and `410` for a trace) is the language's null, not an error.
- The credential as `Authorization: Bearer`, `X-Seshi-User` with the org key, none on
  `/healthz`, `/v1/auth/config` and `/v1/auth/exchange`; bodies of 8 KiB or more gzipped; a
  120-second default timeout; a `User-Agent` naming the client and its version.
- A test that holds it to `spec/openapi.yaml`, as the Python client's
  [`tests/test_spec_drift.py`](../packages/py/client/tests/test_spec_drift.py) does: every route
  either called or listed as left out with a reason, each route's method, path and parameters,
  and each body's properties and which are required. A route change then fails CI until every
  client follows.
- Tests against a real server started from the repository, as
  [`tests/conftest.py`](../packages/py/client/tests/conftest.py) does (`seshi admin init`, then
  `seshi serve` on a folder store), and a CI job that runs them.
