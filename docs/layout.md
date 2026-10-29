# The sessionstorage layout

The object layout is the contract. Anything that can read objects under a
prefix — the sessiondb server's own routes, another service, `aws s3 sync` — can read
a sessionstorage store. (`sessionstorage` names the layout; `sessiondb` is the server that
writes it.) The server is the only writer today; any other writer must follow the rules below.

```
<prefix>/
  sessionstorage.json                                      layout marker, written once
  owners/<owner>/
    .probe                                            a writer's write check
    sessions/<archive_id>/
      metadata.json                                   the session's pointer (mutable)
      raw.<n>.<jsonl|json>.gz                         the native transcript, stored first
      trace.<content_hash>.json.gz                    one per distinct content (immutable),
                                                      made from the raw
    changes/
      <stamp>-<content_hash>.json                     a publish
      <stamp>-tombstone.json                          a tombstone
```

The layout's own objects are exactly the keys named above; a reader ignores
anything else under the prefix, and a writer never puts anything under
`sessions/` or `changes/` that is not.

## Identifiers

- **owner** is one path segment (`[A-Za-z0-9][A-Za-z0-9._-]{0,127}`): the
  name a server token is bound to, usually a person. One owner's objects never
  reference another's, and a token reads only its own owner's.
- **archive_id** = `sha256(owner + "\n" + agent + "\n" + session_id)` (hex).
  Deterministic, so every upload of one session lands in one directory;
  derived, so no native id or path appears in a key.
- **content_hash** = `sha256(source + "\n" + body)` where `body` joins the
  trace's events as `role + "\x1f" + text` with `"\x1e"`. Timestamps are
  outside the hash, so a re-export of the same conversation dedupes. A
  continuation hashes `source + "@" + from_record` in place of `source`: the
  same words at two places in one session are two traces, and a tail sent
  again from the same place is one. The exact derivation of events and `text`
  is in [`src/trace/parse.ts`](../src/trace/parse.ts), pinned by the goldens
  in `testdata/goldens/`.
- **stamp** in a change key is RFC 3339 UTC to the millisecond with `-` and
  `:` removed (`20261021T210405.123Z`), so keys sort by time and are valid
  file names everywhere.

## Objects

### `trace.<content_hash>.json.gz` — `sessionstorage/trace/1`

Immutable and content-addressed. First writer wins: if the key exists, a
later publish does not overwrite it, whatever differs outside the hash.

```jsonc
{
  "schema": "sessionstorage/trace/1",
  "content_hash": "…",
  "source": "claude-code",          // what normalized it (trajectory-v1 meta.source); a session
                                    // in Datadog Trajectory's format is "datadog-trajectory:claude-code"
  "agent": "claude-code",           // what the client posted it as; the archive id derives from it
  "project": "github.com/acme/widget",
  "branch": "main",
  "session_id": "…",
  "started_at": "2026-09-01T00:00:00.000Z",
  "ended_at": "2026-09-01T00:00:07.000Z",
  "records": [ /* trajectory-v1, redacted, NUL-stripped */ ],
  "events": [
    { "index": 0, "role": "user", "text": "…", "timestamp": "…" },
    { "index": 1, "role": "tool_call", "text": "Read {\"file_path\":…}", "timestamp": "…",
      "tool_name": "Read", "tool_call_id": "toolu_…" },
    { "index": 2, "role": "tool_result", "text": "…", "timestamp": "…",
      "tool_name": "Read", "tool_call_id": "toolu_…", "ok": true }
  ],
  "metadata": {
    "cwd": "/repo/app", "git_branch": "main", "model": "…",   // from the meta record
    "parent_session_id": "…",                                 // lineage, when known at first publish
    "continuation": { "from_record": 6, "prefix_sha256": "…" },
    "normalizer": { "name": "sessiondb-server", "version": "0.1.0+trajectory.0.3.0" }
  }
}
```

`events[i].index` is stable for the object's lifetime; anything that addresses
a span of a session does so by event index range.

`metadata.normalizer` names what produced `records`: the server release and, as
semver build metadata, the `@letta-ai/trajectory` it ran, so a reader can tell
which traces an adapter change affected.

### `metadata.json` — `sessionstorage/metadata/1`

The live pointer. Written when the session's first raw part is stored, rewritten
on every publish, last writer wins. A session exists from its raw part on: one
whose transcript normalized to nothing worth a trace (a greeting) has `raw`, an
empty `traces`, and no `head` or `source`, and never appears in `changes/`.

```jsonc
{
  "schema": "sessionstorage/metadata/1",
  "owner": "acme", "archive_id": "…", "session_id": "…",
  "agent": "claude-code", "source": "claude-code",   // source: absent until a trace is stored
  "project": "github.com/acme/widget", "branch": "main",
  "parent_session_id": "…",
  "status": "stored",                // or "redacted"
  "head": "<content_hash>",          // absent before a trace is stored, and once redacted
  "traces": [
    { "content_hash": "…", "created_at": "…", "records": 10 },
    { "content_hash": "…", "created_at": "…", "records": 5,
      "continuation": { "from_record": 6, "prefix_sha256": "…" } }
  ],
  "raw": [
    { "part": 0, "format": "jsonl", "size": 1234, "sha256": "…", "created_at": "…",
      "offset": 0, "length": 48213 },           // where the part sits in the log
    { "part": 1, "format": "jsonl", "size": 300, "sha256": "…", "created_at": "…",
      "offset": 48213, "length": 9120 }
  ],
  "raw_format": "jsonl",
  "normalized": {                    // the chunk state: absent until a part was normalized
    "bytes": 57333,                  // of the log normalized so far: where the next chunk starts
    "records": 15, "prefix_sha256": "…",   // the whole session's, so far
    "hash_state": "…"                // the prefix hash mid-stream, for the next chunk to extend
  },
  "created_at": "…", "updated_at": "…"
}
```

A session that grew after it was stored gets a second trace with a
`continuation`: the tail's records, hashed on their own, plus where in the
full session they start and a hash of what came before. A tail is judged
as part of the session, not as a conversation of its own: one that is all
tool traffic is a trace like any other. A reader that wants
the whole session concatenates in `traces` order. Whether the growth came as
a whole upload with `shipped` or as a chunk, the trace is the same.

### `raw.<n>.<format>.gz`

The native transcript, redacted line by line (`jsonl`) or as a document
(`json`), gzipped. The first object written for a session, and what every
trace is made from: the server normalizes the stored parts, not the bytes on
the wire, so the trace can be remade from the bucket alone when adapters
improve. It is the log as the harness wrote it, before the server's
per-source fixups, so a re-normalization must run the server's
`normalizeTranscript` (fixups included), not the adapter alone.

A whole upload is part 0 and the only part; a log sent in chunks has one part
per chunk, each saying where it sits in the log (`offset`, `length`: the
log's bytes before redaction, which can shorten what is stored), and the
parts in `offset` order, concatenated, are the log. The same bytes at the
same part are a no-op, different bytes replace; a whole upload removes every
other part. `offset` and `length` are absent on parts stored before chunks
were, and such a session takes a whole upload before it can take a chunk.

### `changes/<stamp>-<hash|tombstone>.json` — `sessionstorage/change/1`

One per publish or tombstone, append-only. The feed a consumer tails with a
cursor (the last key processed) and a lag window, since the stamps come from
laptop clocks.

```json
{ "schema": "sessionstorage/change/1", "kind": "published", "at": "…",
  "owner": "acme", "archive_id": "…", "session_id": "…", "content_hash": "…" }
```

`kind` is `published` or `tombstone`.

## The publish protocol

1. Write the object. For a trace, skip if the key exists.
2. Verify: compare the backend's ETag to the body's MD5 when the ETag is a
   plain MD5 (single-part PUT on S3, R2, MinIO); otherwise (the `fs` store, a
   multipart upload) read the object back and compare hashes.
3. Rewrite `metadata.json`.
4. Append the change entry.

A writer that dies between steps leaves either nothing visible (before 3) or
an object without a change entry (between 3 and 4); the next publish of the
same content completes it. Two writers publishing the same content converge
on one object; publishing different content for one session is last-writer-wins
on the pointer and both traces stay listed.

## Reading

- One session: `metadata.json`, then `trace.<head>.json.gz`; no `head` means
  raw only, nothing to read yet.
- Everything new since a cursor: list `changes/` with `StartAfter`, fetch what
  the entries point at.
- A full scan: list `sessions/`, read each `metadata.json`, skip those with no
  `head`.

A reader needs `s3:ListBucket` on the prefix and `s3:GetObject` under it. A
writer additionally needs `s3:PutObject`; tombstoning needs `s3:DeleteObject`.
