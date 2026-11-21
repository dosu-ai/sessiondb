# The seshi layout

The object layout is the contract. Anything that can read objects under a prefix (seshi's
own routes, another service, `aws s3 sync`, a reader in another language) can read a seshi
store. The stored objects other languages read are defined by JSON Schemas in
[`schemas/`](schemas/) (X3.10); ts/model's types are generated from them
(`bun run types`), and [`testdata/objects/`](testdata/objects/) holds conformance examples
every reader should parse. The writer is the `seshi` binary (`seshi serve`, or a laptop in serverless mode, which writes only `owners/<owner>/`);
any other writer must follow the rules below.

```
<prefix>/
  seshi.json                                              layout marker (X1.4), written once
  tokens/<id>.json                                        hashed seshi tokens (X5.9)
  sources/<source_id>/
    checkpoint.json                                       a poller's cursor (X7)
    dropped/<stamp>-<key_hash>.json                       an envelope model review dropped (X6.4)
    failed/<stamp>-<key_hash>.json                        an envelope that failed (X4.8)
    health/<yyyy-mm-dd>/<instance>.json                   outcome counters, per instance (X4.8)
  worker/heartbeat.json                                   the worker's last run (X7.5)
  config/
    seshi.toml                                            shared settings (F11.6); a server's
                                                          runtime config (runtime_config = store)
    <file>                                                rule packs, review prompts it names
  runtime/
    sources/<source_id>.json                              a source the admin API stored
    instances/<process>.json                              what one server process runs
  assembly/pending/<archive_id>                           a session with spans to assemble (X7.4)
  owners/<owner>/
    .probe                                                a writer's write check
    sessions/<archive_id>/
      metadata.json                                       the session's pointer (mutable)
      trace.<content_hash>.json.gz                        seshi/trace/1, one per distinct content
      spans/<trace_id>-<span_id>.json                     normalized, redacted span records (F4)
      spans/messages/<sha256>.json                        span inputs' messages, once each (F4.4)
      review/<n>.json                                     model review decisions (F3)
    changes/
      <stamp>-<archive_id>-<suffix>-<content_hash>.json   a publish
      <stamp>-<archive_id>-<suffix>-tombstone.json        a tombstone
      <stamp>-<archive_id>-<suffix>-visibility.json       a visibility change
```

The layout's own objects are exactly the keys named above; a reader ignores anything else
under the prefix, and a writer never puts anything under these folders that is not. Readers
of sessions need only `owners/`; the other folders are the server's working state, read
through the API (X5.6).

## Identifiers

- **owner** is one path segment: a person's owner ID (`[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}`:
  a username, an email or an IdP subject) or a service account, `svc:<source-id>` (X5.4,
  X5.8). The server derives it from the caller's identity; a value that does not fit becomes
  `h-` and 20 hex digits of its SHA-256. One owner's objects never reference another's.
- **archive_id** = `sha256(owner + "\n" + format + "\n" + session_id)` (hex), where `format` is
  the format the session is filed under (`claude-code`, `codex`, `cursor-cloud-api`, …).
  Deterministic, so every upload of one session lands in one directory; derived, so no native
  id or path appears in a key.
- **content_hash** = `sha256(source + "\n" + body)` where `body` joins the trace's events as
  `role + "\x1f" + text` with `"\x1e"`. Timestamps are outside the hash, so a re-export of the
  same conversation dedupes. A continuation hashes `source + "@" + from_record` in place of
  `source`. Events are derived from each record's role, text and tool fields only, never from
  the fields `seshi/trace/1` added to trajectory-v1, so the Letta rendering has the same hash.
  The derivation is in [`packages/ts/model/src/parse.ts`](../packages/ts/model/src/parse.ts),
  pinned by the goldens in [`testdata/goldens/`](testdata/goldens/).
- **stamp** in a change or record key is RFC 3339 UTC to the millisecond with `-` and `:`
  removed (`20261021T210405.123Z`), so keys sort by time and are valid file names everywhere.
- **suffix** in a change key is 8 random hex characters, drawn for each entry, so two changes
  of one session in one millisecond still get keys of their own.
- **source_id** is a configured source's id, or `upload` for hooks and the CLI: words of
  lowercase letters and digits joined by single `-`.
- **key_hash** is the first 24 hex characters of `sha256(idempotency_key)`: the idempotency key
  may hold object keys or session ids, so it never appears in a key itself.

## Conditional writes (X6.5)

Mutable objects are written conditionally, so two writers (API instances, a worker, a second
worker by mistake) never silently lose each other's update:

| Object | Write |
|---|---|
| `seshi.json` | Created with `If-None-Match: *`; a later org claim with `If-Match` |
| `metadata.json` | `If-None-Match: *` for a new session, else `If-Match` the ETag read; on `412` re-read and retry |
| `sources/<id>/checkpoint.json` | `If-Match` (first one `If-None-Match`); on `412` the worker discards its run (X7.3). `seshi reprocess` removes or rewrites it with `If-Match` too |
| `tokens/<id>.json` | Created with `If-None-Match: *`; changes (revoke) with `If-Match` |
| `assembly/pending/<archive_id>` | Touched unconditionally; deleted with `If-Match`, so a batch that arrived meanwhile keeps it |
| `review/<n>.json`, drop and failure records | Created with `If-None-Match: *` |
| trace objects | Content-addressed; created with `If-None-Match: *`, so the first object for a hash wins |
| `sources/<id>/health/<day>/<instance>.json` | `If-Match`, by the one process that owns the shard |
| change entries | Unique keys (stamp, archive id, random suffix); written plainly, before the pointer |
| `config/*`, `runtime/sources/<id>.json` | With the caller's condition: `If-Match` the ETag read, `If-None-Match: *` to create (the admin API, `seshi admin config push`); `412` to the caller |
| `runtime/instances/<process>.json` | Written plainly by the one process it names |

S3 and R2 honour `If-Match` and `If-None-Match` on PUT. The folder store (`file://`) emulates
them with a lock file per key, taken with an exclusive create; that is safe between processes
on one machine only, and its ETag is the MD5 of the object, as S3's single-part ETag is.

## Objects

### `seshi.json` — `seshi/layout/1` ([schema](schemas/layout.schema.json))

Written once, by the first writer to use the prefix.

```json
{ "schema": "seshi/layout/1", "trace_schema": "seshi/trace/1",
  "deployment_id": "prod-eu", "org": "acme",
  "created_at": "2026-11-14T09:00:00.000Z", "created_by": "seshi/0.9.0" }
```

`trace_schema` is the canonical format of every trace under the prefix. `deployment_id` is
config's `store.deployment_id`, or one the first writer generated; `org` is recorded the first
time a config names one. A server whose config names another deployment or org refuses to
start (X1.4), as does one that finds a marker schema or trace format it cannot read.

### `trace.<content_hash>.json.gz` — `seshi/trace/1` ([schema](schemas/trace.schema.json))

The one canonical stored trace (X6.2). Immutable and content-addressed: if the key exists, a
later publish does not overwrite it, whatever differs outside the hash. Evolved from
trajectory-v1: its records are trajectory-v1 records with optional fields for what the raw
transcript used to keep, and the trace adds the session's LLM calls and where it came from.
Nothing else of a session's content is stored (X6.3): no raw transcript, no payload.

```jsonc
{
  "schema": "seshi/trace/1",
  "content_hash": "…",
  "source": "claude-code",          // what normalized it (the meta record's source)
  "format": "claude-code",          // the format it was filed under; the archive id derives from it
  "project": "github.com/acme/widget",
  "branch": "main",
  "session_id": "…",
  "started_at": "2026-09-01T00:00:00.000Z",
  "ended_at": "2026-09-01T00:00:07.000Z",
  "records": [
    { "role": "meta", "source": "claude-code", "cwd": "/repo/app", "agent_version": "2.1.0" },
    { "role": "user", "content": "…", "timestamp": "…", "id": "u1" },
    { "role": "assistant", "content": null, "timestamp": "…", "id": "msg_01…",
      "llm_call": "call_1",
      "tool_calls": [{ "id": "toolu_…", "name": "Read", "args": "{\"file_path\":…}" }] },
    { "role": "tool", "tool_call_id": "toolu_…", "content": "…", "ok": true, "timestamp": "…",
      "duration_ms": 31, "withheld": "sensitive-file" }
  ],
  "events": [
    { "index": 0, "role": "user", "text": "…", "timestamp": "…" },
    { "index": 1, "role": "tool_call", "text": "Read {\"file_path\":…}", "timestamp": "…",
      "tool_name": "Read", "tool_call_id": "toolu_…" }
  ],
  "metadata": {
    "cwd": "/repo/app", "git_branch": "main", "model": "…",
    "parent_session_id": "…",
    "continuation": { "from_record": 6, "prefix_sha256": "…" },
    "normalizer": { "name": "@dosu/seshi", "version": "0.9.0+trajectory.0.4.4",
                    "format_version": "1+trajectory.0.4.4" }
  },
  "llm_calls": [
    { "id": "call_1", "model": "claude-sonnet-4-5", "provider": "anthropic",
      "started_at": "…", "ended_at": "…",
      "usage": { "input_tokens": 1200, "output_tokens": 80, "cache_read_input_tokens": 9000 },
      "stop_reason": "tool_use", "request_id": "msg_01…" }
  ],
  "provenance": { "source": "hook", "source_id": "upload", "format": "claude-code",
                  "location": { "object_key": "…", "etag": "…" } }
}
```

Records may carry `id` (the record's id in its source), `llm_call` (the call in `llm_calls`
that produced it), and on tool results `withheld` (`sensitive-file` or `secret-output` from the
rules, `review` when model review withheld it) and `duration_ms`; the meta record may carry
`agent_version`; a user record may carry `synthetic` (`true`: the agent or a plugin added it,
not the member) and `omitted` (how many injected items the integrator that added them asked
seshi to leave out there; their text is not stored, so the record's content is empty). Every
`llm_call` must name an entry of `llm_calls`. `events[i].index` is
stable for the object's lifetime; anything that addresses a span of a session does so by event
index range.

Other formats are rendered from it on read, never stored (`GET …/trace?format=`):

- `letta`: Letta trajectory-v1, schema `sessionstorage/trace/1`: plain trajectory-v1 records,
  no `llm_calls` or `provenance`, the same events and `content_hash`.
- `otlp`: one OTLP/HTTP JSON `ExportTraceServiceRequest` (schema attribute
  `seshi/trace-otlp/1`) with GenAI spans: an `invoke_agent` root, a `chat` span per assistant
  record (its LLM call's model, response id and `gen_ai.usage.*` on the call's first span), an
  `execute_tool` span per tool call. Lossless: spans carry the canonical records as
  `seshi.records`, the resource the meta record, metadata, `llm_calls` and `provenance`, so
  `fromOtlp` gives back the canonical trace.
- `atif`: an ATIF-v1.7 document; token usage as step `metrics` and `final_metrics`.

### `metadata.json` — `seshi/metadata/1` ([schema](schemas/metadata.schema.json))

The live pointer, written with `If-Match` on every change. A session exists from its first
trace: nothing is written for a session the session filter keeps out (X6.3, X4.10). Once
tombstoned it has no `head`.

A session whose first envelope model review dropped (F3.4) has a **stub**: a pointer with
`status: "stored"`, no `head`, no `traces`, and nothing of the dropped content. It holds the
session's identity (`owner`, `session_id`, `format`, `archive_id`), its `writer`,
`owner_basis` and `visibility`, the `retract_hash`, and where its log ends: `normalized` (the
byte offset past the dropped envelope and the prefix hash), `dropped_prefix` (the same offset,
record count and hash, kept once the session has a trace) and `applied` (the drop's answer).
No change entry is written for it. The next envelope continues from there and is reviewed on
its own; once stored, it is the session's first trace, a `continuation` from the dropped
records whose meta record names only the format (`{ "role": "meta", "source": "<format>" }`).
Readers neither list nor serve a stub: no `head`, nothing to read.

```jsonc
{
  "schema": "seshi/metadata/1",
  "owner": "alice", "archive_id": "…", "session_id": "…",
  "format": "claude-code", "source": "claude-code",
  "project": "github.com/acme/widget", "branch": "main", "parent_session_id": "…",
  "status": "stored",                 // or "redacted"
  "head": "<content_hash>",           // absent before a trace is stored (a stub), and once redacted
  "traces": [
    { "content_hash": "…", "created_at": "…", "records": 10, "rule_set": "<sha256>" },
    { "content_hash": "…", "created_at": "…", "records": 5, "rule_set": "<sha256>",
      "continuation": { "from_record": 6, "prefix_sha256": "…" } }
  ],
  "normalized": { "bytes": 57333, "records": 15, "prefix_sha256": "…", "hash_state": "…" },
  "dropped_prefix": { "bytes": 2114, "records": 3, "prefix_sha256": "…" },  // only when review
                                      // dropped the session's first envelopes (F3.4)
  "withheld_calls": { "toolu_01…": "sensitive-file" },
  "applied": [                        // the last envelopes applied, with their answers (X4.7)
    { "idempotency_key": "…@48213#…", "at": "…", "status": "stored", "content_hash": "…",
      "records": 5, "events": 4, "records_total": 15, "prefix_sha256": "…", "bytes_total": 57333 }
  ],
  "writer": { "kind": "device", "principal": "alice", "credential_id": "tok_…",
              "source_id": "upload" },        // the original writer (X4.6, X5.5)
  "owner_basis": "verified",          // verified | claimed | service
  "visibility": "org",                // org | owner (X5.10)
  "claims": { "git_email": "alice@example.com", "account_ids": { "anthropic": "acct_…" } },
  "redaction": { "rule_set": "<sha256>", "counts": { "github-token": 1 } },
  "provenance": { "source": "hook", "source_id": "upload", "format": "claude-code" },
  "origin_agent": "claude-code",      // with native_session_id, collapses a session that
  "native_session_id": "…",           // arrived by two routes (X4.5)
  "normalizer": { "name": "…", "version": "…",   // format_version: the oldest that built
                  "format_version": "…" },          // a stored trace; older than the
                                                     // format's is stale (X4.9)
  "retract_hash": "<sha256>",         // F9.7: first upload's retraction secret, hashed
  "active_at": "…",                   // the latest record timestamp: when it last did something
  "created_at": "…", "updated_at": "…"
}
```

`writer` and `owner_basis` are the first write's; each later write's writer is on its change
entry. `claims` merge over writes from a fixed allowlist (X5.5). `redaction.counts` sum over
writes, by rule id (only what each write stored is counted), and `redaction.rule_set` is the
hash of the rule set that last ran over the session (F2.3). Each entry of `traces` records the
rule set its own trace was written under (`rule_set`; an entry without one counts as the
session's), so a chunk written after the rules changed does not make the traces before it look
current: `seshi redact backfill` redoes every session with a trace not written under the
current rules. A session that grew gets a second trace with
a `continuation`; a reader that wants the whole session concatenates in `traces` order.

The chain joins up. Every trace starts with a meta record, so the first trace holds the
session's records `[0, records)`, or `[from_record, from_record + records - 1)` when it is a
continuation (a fork's copy of its parent, or a stub's dropped start), and each later trace is a
continuation that starts where the one before it ends. The first starts at
`dropped_prefix.records` when there is one, and the last ends at `normalized.records`. The one
exception is an envelope model review dropped after the session had a trace: the log moves past
its records and no trace holds them, so the next continuation starts past them (or the chain
ends before `normalized.records`), and `applied` records the drop with its `records_total`
while it is among the last 16. Every trace in `traces` was announced by a `published` change
entry naming its hash, and a `redacted` session by a `tombstone` entry. A
replace (X4.6) leaves one trace in `traces`, removes the others' objects, and starts `applied`
and `redaction` over from the replacing write. Its object replaces one already under the same
hash (the hash leaves some content out, which new rules or review may have changed), and its
change entry then says `replace` so readers read it again.

`normalized` and `withheld_calls` are the small state the next chunk of the session's log is
normalized with: where the log ends (`bytes`), how many records it normalizes to and their
prefix hash (resumable mid-stream as `hash_state`), and the tool calls whose results the
sensitive-call rules withhold. Both count the log's records as regex redaction left them,
before model review, so they follow the uploader's log: a record model review redacted or an
envelope it dropped still counts, and `continuation.from_record` is in the same terms.
`applied` keeps the last 16 envelopes (X4.7).

`dropped_prefix` is the start of the log model review dropped before the session had a trace
(F3.4): its byte length (0 for an assembled session), its record count and their prefix hash.
Every write with no trace stored sets it to `normalized`; every later write keeps it, and a
whole write that does not extend what is stored (a rebuild, a replace, an assembly published
again) leaves those records out and sets it anew, so the dropped text is never stored or
reviewed again. It is absent for a session whose first envelope was stored, and removed by a
tombstone.

### `changes/<stamp>-<archive_id>-<suffix>-<hash|tombstone|visibility>.json` — `seshi/change/1` ([schema](schemas/change.schema.json))

One per publish, tombstone or visibility change, append-only. The feed a consumer tails with a
cursor (the last key processed) and a lag window.

```json
{ "schema": "seshi/change/1", "kind": "tombstone", "at": "…",
  "owner": "alice", "archive_id": "…", "session_id": "…", "format": "claude-code",
  "content_hash": "…",
  "writer": { "kind": "device", "principal": "alice", "source_id": "upload" },
  "owner_basis": "verified", "reason": "retracted" }
```

`kind` is `published`, `tombstone` (with `reason`: `deleted`, `retracted` or `redacted`) or
`visibility_changed` (with the new `visibility`). Every entry names its `writer` and the
session's `owner_basis` (X5.5), never content, and the session's `format`, so a reader can call
the session routes (`/v1/sessions/{format}/{session_id}`) from the entry alone. Entries written
before seshi 0.16 have no `format`: the server's feeds (`GET /v1/changes`, `GET
/v1/changes/all`) and `readChanges` fill it from the session's metadata. An entry whose
session has no metadata names a write that never landed (its entry is written first), so they
leave it out: every entry they serve has a `format`.

The key is the entry's stamp (its `at`), the session's archive id, a random suffix and what
changed: the published trace's hash, `tombstone` or `visibility`. The stamp leads, so keys sort
by time and a listing with `StartAfter` a cursor (a key, or a bare stamp for "since") is the
feed; within one millisecond they sort by session and suffix. No two entries share a key: a
bulk delete or two changes of one session in one millisecond each keep their own, and a reader
can tell an entry's session and kind from its key alone. A reader ignores keys of any other
shape.

An entry is written before the session's pointer moves (see the publish protocol), so it may be
read before its change is in `metadata.json`, and a write that fails between the two leaves an
entry for a change that did not happen. Entries are therefore notices: a reader acts on what the
session's metadata says now, never on the entry alone (see Reading).

A `published` entry with `replace: true` replaced the session's earlier traces (X4.6): a reader
drops what it held of the session and takes this trace as the whole of it. With `reason:
"redacted"` it was a redaction backfill (F2.5): new rules were applied to the stored session,
its traces were joined into this one, and the old trace objects were deleted.

### Server state

Read and written by the binary only, so their types are code-first in `@seshi/store`
(`objects.ts`, `records.ts`) rather than JSON Schemas:

- `tokens/<id>.json` (`seshi/token/1`): one seshi token (X5.9). `kind` is `org`, `admin`,
  `device` or `service`; `owner` is the person's owner ID, `svc:<id>`, or `*` for the org key
  (its caller states one); `hash` is `sha256:<hex>` of the whole token `seshi_<id>_<secret>`,
  never the token itself; `scopes`, `visibility` (the default for what it writes),
  `owner_basis`, `created_at`, `expires_at` (null: never), `revoked`/`revoked_at`, and
  `label`, `created_by`, `machine` (a device token's machine) and `claims` (what the IdP
  verified). Session tokens are signed by the server and not stored.
- `sources/<id>/checkpoint.json` (`seshi/checkpoint/1`): the source id, when it was saved,
  and the poller's own `cursor` object. A `datadog` source's cursor is `{ v: 1, until?,
  window?: { from, to, page? }, seen? }`: the end of the last window read in full, the window
  being read and the Export API cursor of its next page, and the span ids (OTLP hex) it
  submitted inside the next window's overlap with their start in milliseconds.
  The S3 poller's cursor is a manifest (F6.2): `v`
  (1), `objects` keyed by object key, each with the `etag` and `size` last handled,
  `modified`, the `format` and `session` it was submitted as, `offset` (how many of its bytes
  the session holds), `tail` (a digest of the up to 4 KiB before `offset`), `gz`, and
  `failed` (the code of a permanent failure of that version); plus `after` (where an
  unfinished listing resumes), `watch_from` and `hold` (with `ordered_keys`), `listed_at`,
  and `epoch` (which reading of the source this is: set when a manifest starts, moved on by
  every rewind; whole objects' idempotency keys carry it).
- `config/seshi.toml` and the files beside it: serverless laptops' shared settings (F11.6),
  and, on a server with `server.runtime_config = store`, its runtime config: the data-policy
  sections (`default_visibility`, `filter`, `redaction`, `review`, `records`, `capture`) under
  the server's own files (docs/config.md). Paths in it (`redaction.packs`, `prompt_file`) are
  relative to `config/`. Review keys are `{ env = … }` references, never values.
- `runtime/sources/<id>.json` (`seshi/runtime-source/1`): a source the admin API stored.
  `source` is its settings as in `[[sources]]`, without `id` (the key is); each secret is
  either `{ sealed = "v1.<key id>.<iv>.<box>" }` (AES-256-GCM under a key HKDF-derived from
  `secrets.keys.<key id>`, with `source:<id>:<field>` as additional data) or an `{ env = … }`
  reference, never a value. `secrets` gives each sealed field's `key_id`, `fingerprint` (an
  HMAC of the value, 12 hex digits) and `updated_at`; then `updated_at` and `updated_by`. Kept
  out of `config/`, which serverless laptops copy.
- `runtime/instances/<process>.json` (`seshi/runtime-instance/1`): what one server process runs:
  `instance`, `process`, `seshi` (its version), `version` (the runtime config version it runs:
  a hash of the ETags of `config/*` and `runtime/sources/*`), `applied_at`, `at` (written every
  `server.config_poll`) and `problem` (why it does not run the bucket's version). Removed when
  the process stops, and by any reader when older than a day.
- `worker/heartbeat.json` (`seshi/heartbeat/1`): the writing process (`instance`, unique per
  run) and its stable instance id (`host`), version, roles, start, when it was written (`at`)
  and its `interval_ms`, and `jobs`: each job's runs, failures, last start and finish, last
  outcome (`ok`, `error`, `discarded`), last error and last summary. Written every
  `worker.heartbeat_interval`, last writer wins; status calls a heartbeat older than three
  intervals stopped. A worker that finds another process's fresh heartbeat names it in
  `others`, so either heartbeat shows both workers (X7.3, X7.5).
- `assembly/pending/<archive_id>` (`seshi/pending/1`): owner, archive id, when the last
  span batch arrived, and a random `touch` id, so every touch changes the ETag the assembler
  deletes it by. Also the batch's `source_id` (whose `quiet_period` applies), its `envelope`
  without the payload (who sent the spans, whose session it is, which session and format: the
  assembler publishes as it), and `final` when a batch held a span that ends the session (an
  archived or deleted Managed Agents session, or the root span of a session that is one
  trace), so the session is published after a short grace instead of the whole quiet period
  (F4.4). A batch keeps a `final` an earlier one set.
- `owners/<o>/sessions/<a>/spans/<trace_id>-<span_id>.json` (`seshi/span/1`): one span each,
  as its format normalized it and regex redaction left it, never as received: `received_at`,
  `source_id`, `format`, `part` (the span's ids, times, status, operation and thread, its input
  and output as trajectory-v1 records, its tool call, its LLM call, its response id, whether it
  had content, whether it is final, what it says of the session's model) and `redaction` (rule
  set and counts of this span's matches). A span sent twice lands on the same key. Records stay
  after the session is published, so a late span can rebuild it; never readable through the
  API; deleted with the session (F4.4, X6.3).
- `owners/<o>/sessions/<a>/spans/messages/<sha256>.json`: one record of a span's input (a chat
  request repeats the conversation so far), stored once per session however many spans repeat
  it (F4.4): the record as redaction left it, with `timestamp` emptied (`""`), under the
  SHA-256 of these bytes. A span record then holds no `part.input` but `input`: `at` (the
  input's time) and `messages`, the hashes in order, an entry `[hash, timestamp]` for a record
  whose time is not `at`; a reader puts each record's time back. Written before the span record
  that names them. They sort after every span record, so they are deleted with the session's
  `spans/`; a redaction backfill writes a message the new rules change under its new hash and
  deletes the old one once no record names it.
- `owners/<o>/sessions/<a>/review/<n>.json` (`seshi/review/1`): for the `n`th stored write,
  the policy and its hash, the decision (`allow`, `redact`, `skipped`), both models
  (`<provider>/<model>`), and the findings by record (the index in the trace that write
  produced), field and category, never the matched text (F3.8). Optional: `unmatched` (findings
  that named no text the redactor was given), `parts` (how many parts the write was split into
  for the models), and for `skipped`, `failure` (`step`, `code`, `attempts`). A write no policy
  covered has none. `n` is zero-padded to 8 digits so a listing is in order.
- `sources/<id>/dropped/` (`seshi/dropped/1`) and `sources/<id>/failed/` (`seshi/failed/1`):
  one record per envelope that was not stored, with the base fields `at`, `source`,
  `source_kind`, `owner`, `session_key`, `idempotency_key`, `provenance`; drops add `reason`
  (`review_drop`, `review_failed`), `policy`, `policy_hash`, `decision_model`, and for
  `review_failed` the `failure` (`step`, `code`, `attempts`) and, when the redactor failed,
  `redactor_model`; failures add
  `code` and `message`. Never content. Kept 30 days by default (`[records]
  dropped_retention`, `failed_retention`); keys are in time order, so pruning stops at the
  first record to keep.
- `sources/<id>/health/<yyyy-mm-dd>/<instance>.json` (`seshi/source-health/1`): how many
  envelopes from the source ended `stored`, `duplicate`, `unchanged`, `filtered`, `dropped`,
  `failed` or `rejected` that UTC day, counted by one instance (`instance`: `server.instance_id`,
  else the host name, so a restart keeps its shard); a reader sums a day's shards. A filtered
  session is only counted here, never recorded (X4.10). The worker's retention job deletes days
  past `records.health_retention` (90 days).

## The ingest pipeline (X4)

Every write of a session is one envelope through one pipeline, decided in memory and written
last (X4.3): authorize and resolve the owner, normalize, regex redaction on the normalized
records, the session filter (first trace only), model review, then the publish below. Nothing
is written before every stage has run, and no payload is ever stored (X6.3).

A log arrives whole (`offset` 0) or as a chunk from where the session's log ends:

- Until a session has a trace (or a stub) nothing of it is stored, and only the whole log is
  taken. A chunk for such a session is refused with `expected: 0`.
- A stub is continued as a session with a trace is: a chunk from where its log ends, or a
  whole log whose first `normalized.records` records hash to its prefix, ships only what is
  past the stub, reviewed on its own. A whole log with nothing past it publishes nothing
  (`unchanged`); one that does not extend it is refused unless it is a replace by the stub's
  `writer` or an admin.
- A chunk is normalized on its own (each adapter's partial mode) with `normalized` and
  `withheld_calls`, and published as a continuation of the head with the head's meta record.
  It is never filtered.
- A whole log for a session with a trace must extend it: its first `normalized.records`
  records must hash to `normalized.prefix_sha256`. Its tail is published as a continuation
  (never filtered); nothing past what is stored moves the log on and publishes nothing. One
  that does not extend the session is refused, unless it is sent as a replace by the session's
  original `writer` or an admin (X4.6).
- A `rebuild` (X4.9) takes the replace path even for a log that extends the session. On that
  path a session with a `dropped_prefix` keeps its dropped start out: its first `records`
  records are left out when they still hash to its `prefix_sha256`; otherwise, for an uploaded
  `jsonl` log, as many records as the current adapter makes of its first `bytes` bytes (cut at
  the line boundary at or past them, after a rules or adapter change); otherwise (an assembled
  session, a document) its `records`. What is left is reviewed alone and published as a
  continuation from the dropped records, with the stub's meta record; nothing left is
  `unchanged`. Leaving out too much is preferred to reviewing anything dropped again: for an
  assembled session, a late span inside the dropped part shifts what follows by one record.
- A resend of an envelope in `applied` gets the recorded answer and runs no stage (X4.7).

A permanent failure is answered to a caller that waits (an upload, a hook) and otherwise
recorded under `sources/<id>/failed/`; a model review drop is recorded under
`sources/<id>/dropped/` and moves the log on past the envelope: for a session with no trace
yet, by writing its stub (F3.4). A dropped replace leaves the session's log as it was.

A span set (OTLP, Datadog: X4.2) is not a log. Each span is normalized by its format's span
adapter and regex-redacted on arrival, written to the session's `spans/` (a repeat lands on the
same key) and the session's `assembly/pending/<archive_id>` marker touched; the call returns
then (X4.4). The worker's assembler lists the markers and, for a session quiet for its source's
`quiet_period` (or a short grace after a final span), reads its span records, orders them into
records and LLM calls, and publishes the whole session as the marker's envelope: the session
filter judges only its first trace, a session that grew is published as a continuation, and
one that changed earlier on (a late span in the middle) replaces it, its writer being the
source's service account. Model review judges the assembled session. The marker is then
deleted with `If-Match`, so a batch that arrived meanwhile keeps it for another pass (X7.4).
Deleting a session deletes its span records and marker too.

## The publish protocol

1. Write the trace object with `If-None-Match: *`; skip if the key exists (a `412` means another
   writer published the same content first). A replace writes it over an object already there
   with different bytes (see `traces` above).
2. Verify: compare the backend's ETag to the body's MD5 when the ETag is a plain MD5
   (single-part PUT on S3, R2, MinIO, and the folder store); otherwise read it back.
3. Append the change entry, unless the pointer already lists the trace and its object was there
   (a duplicate: nothing changes).
4. Update `metadata.json` with `If-Match` (retrying on `412` from a fresh read). If the
   session is no longer as the envelope was planned against (another chunk landed, it was
   tombstoned), give up and delete the object written in step 1 unless the pointer lists it;
   the entry stays. If a retry finds the pointer needs an entry after all (step 3 skipped one
   for a duplicate that is not one any more), it is appended before the update is tried again.
5. For a replace, delete the trace objects the pointer no longer lists.

Every other write under `changes/` keeps the same order, entry first: a tombstone appends its
entry, marks the session `redacted`, then deletes its objects; a visibility change appends its
entry, then updates the pointer; a redaction backfill writes its new trace, appends its
`replace` entry, moves the pointer, then deletes the old objects.

So no change is ever made without its entry (at least once). A writer that dies between steps
leaves an unlisted object (before 3 or 4; the next publish of the same content lists it and
appends its own entry), or an entry for a change the pointer does not show (between 3 and 4),
which a reader that reads the current metadata takes for no change, and which a retry follows
with an entry of its own. Each envelope is planned against the session as it read it, so of two
racing on one session one lands and the other is planned again (a whole log) or told where the
log now ends (a chunk).

A trace object that no `metadata.json` names (in `traces` or as `head`) and that is over an hour
old by the store's listing is deleted by the server's sweep (F2.5): daily, after a redaction
backfill and after a replace. So a writer names its object within the hour of writing it, or
writes it again; a publish that finds its object already there writes it again with its own
bytes, and the sweep checks an object's age once more just before it deletes it.

## Reading

- One session: `metadata.json`, then `trace.<head>.json.gz`; no `head` means nothing to read
  yet. Metadata and traces written before seshi 0.16 name the format `agent`, not `format`:
  read `format ?? agent`. Writers write only `format`.
- Everything new since a cursor: list `changes/` with `StartAfter`, and read the metadata of
  each session the entries name for what it is now. An entry whose change that metadata does
  not show yet (its writer is between the entry and the pointer, or failed there) is read again
  later, within the reader's lag window, until it does or it ages out.
- A full scan: list `sessions/`, read each `metadata.json`, skip those with no `head`.
- An index (search, F10): tail every owner's `changes/` and, for each session an entry names,
  index what its `metadata.json` says now (its traces from the last one without
  `continuation` to `head`; nothing once `status` is `redacted`). Indexing from the metadata
  rather than from the entry alone makes entries read twice, out of order, early, for a change
  that failed, or missing harmless.
  The seshi server's search index is such a reader: an SQLite file on each instance's local
  disk, never in the bucket, derived and rebuildable (X6.1). It also keeps a copy of the
  entries it reads, from which the server serves every owner's feed as one (`GET
  /v1/changes/all`); nothing about it is written to the bucket.

`seshi store check` (`checkStore` in `@seshi/store`) reads a prefix and reports where it breaks
the rules on this page: the marker, every pointer against its schema, its key and its traces,
the chain above, stubs and tombstoned sessions, trace objects no pointer names past the sweep's
hour, change keys and entries against the sessions they name, and span records against their
messages. It is a reader: it needs only what a reader needs.

A reader needs `s3:ListBucket` on the prefix and `s3:GetObject` under it. A writer
additionally needs `s3:PutObject`; tombstoning, pruning and the sweep need `s3:DeleteObject`.
