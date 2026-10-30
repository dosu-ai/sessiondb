# The sessiondb server

A client posts the raw transcript of a session, whole or in chunks as it grows; the server
redacts it and writes it to the bucket as the session's raw part, then normalizes what it
stored to trajectory-v1, decides whether it is worth a trace and how much of it is new, and
writes the trace beside it, in the [layout](../spec/layout.md). Storage first, then normalize, so the
trace can always be remade from the bucket. Anything that reads the layout reads the bucket
directly: the server is a writer and no reader's dependency.

The server is the `@dosu-ai/sessiondb` SDK (`sdks/typescript/`) behind HTTP and a token list:
each route is a call on the SDK's client, scoped to the owner the token names, and the SDK's
own HTTP backend (`connect({ server, token })`) speaks this API from the other side. A client
that holds a bucket credential can run the same SDK against the bucket directly and skip the
server; what the server adds is that the laptop holds no bucket credential and redaction is
not the laptop's to skip.

```
client ──POST /v1/sessions (raw transcript, bearer token)──▶ sessiondb server
                                                               store raw · normalize · trace
                                                                    │
                                                                    ▼
                                                   the bucket (s3:// r2:// file://)
                                                                    ▲
                                                 readers tail changes/ (their own read-only key)
```

One server, one bucket, one list of tokens, all from `.env`. Each token names a person; that
person's sessions are filed under `owners/<name>/` in the bucket, and the token can post
sessions there and read them back, and nothing of anyone else's. Nothing else is needed.

## Running it

```bash
cp .env.example .env     # the token, the bucket URL and its keys
bun start                # http://localhost:7200
```

Bun reads `.env` from the working directory on its own; `.env` is gitignored. The same file is
what `docker compose` hands the container (`docker compose up -d`). At boot the server writes
the layout marker and a probe object, so a wrong bucket or key fails there and not on the first
session.

| Variable | Required | Purpose |
|---|---|---|
| `SESSIONDB_TOKENS` | one of the two | `name:token` pairs, comma-separated, one per person (`alice:…,bob:…`). The name is the folder their sessions go under, so keep it stable; the token is 16+ characters (`openssl rand -hex 24`) and can be rotated alone |
| `SESSIONDB_TOKEN` | | One token with no name, for a one-person install; its sessions go under `owners/default/` |
| `SESSIONDB_STORE_URL` | yes | `r2://bucket/prefix`, `s3://bucket/prefix`, or `file:///path` |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | for `r2://` | |
| `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | for `s3://` | Or Bun's `S3_*` equivalents; `S3_ENDPOINT` for MinIO, Backblaze, Wasabi… |
| `PORT` | | Default `7200` |

Put TLS in front of it (a reverse proxy, Cloud Run, a load balancer): transcripts arrive
unredacted and the server is where that stops being true.

### Deploying

Every release is published as a container image, `ghcr.io/dosu-ai/sessiondb:<version>`, built
from `server/Dockerfile` in this repository (`docker build -f server/Dockerfile .` from the
root). It listens on `PORT` (default `7200`), reports
`/healthz` for liveness, and needs only the environment variables above: there is no database,
no volume (unless the store is `file://`), no background work, and no state outside the bucket,
so any platform that runs a container works, scaled to zero or to many instances alike. Keep
the request timeout at 120 seconds or more; a large transcript can take that long to normalize
and verify. Platforms that cap request bodies (Cloud Run's HTTP/1 limit is 32 MiB) are fine as
long as clients send `Content-Encoding: gzip`, which every route accepts.

### Who sees what

A token is bound to one name and the server scopes every call to `owners/<name>/`: the
session list, reads, deletes and the change log. Two people on one server
never see each other's transcripts; a token leaked from one laptop exposes one person's
sessions. A reader with its own bucket key sees every folder. That is the point: the team's
archive is the whole bucket, a person's view is their own folder.

Renaming a token's name is a move, not a rename: the old folder stays in the bucket (and a
bucket reader keeps seeing it) but the renamed token no longer does. Add a person, remove a
person, rotate a token; don't rename.

To host several teams, run one container per team, each with its own `.env` and its own
bucket or prefix. Isolation between teams comes from the deployment, not the code.

## Readers

A reader never talks to the server. Give it a read-only credential on the bucket
(`s3:ListBucket` on the prefix, `s3:GetObject` under it) and it tails `changes/` with a cursor;
`GET /v1/me` tells a client which bucket that is so it can pass it on.

## API

All bodies are JSON unless a route says otherwise. Errors are `{ "error": { "code", "message" } }`.
Request bodies may be `Content-Encoding: gzip`. Every route but `/healthz` wants
`Authorization: Bearer <token>`.

| | |
|---|---|
| `GET /healthz` | `{ok, version}`, no auth |
| `GET /v1/me` | `{owner, storage: {url, region?, account_id?, endpoint?}}`: which bucket this server writes, so a client can point a reader at it. Never a secret |
| `POST /v1/sessions` | Store a session; see below |
| `GET /v1/sessions?limit&after` | List |
| `GET /v1/sessions/:agent/:session_id` | The session's `metadata.json` |
| `GET /v1/sessions/:agent/:session_id/trace?hash` | The head trace (or a specific one); `404 no_trace` while raw only, `410` once redacted |
| `DELETE /v1/sessions/:agent/:session_id` | Tombstone: drop trace and raw objects, append a tombstone change. Irreversible; a later upload of the same session is refused |
| `GET /v1/changes?after&since&limit` | The change feed |

### `POST /v1/sessions`

```jsonc
{
  "agent": "claude-code",          // the transcript format: claude-code, codex, cursor, opencode, pi, gemini-cli,
                                   // or datadog-trajectory (a Trajectory session file, see below)
  "session_id": "…",
  "transcript": "…",               // the native log, verbatim
  "format": "jsonl",               // or "json" (OpenCode exports); how the raw copy is redacted
  "project": "github.com/acme/widget",
  "branch": "main",                // the client's best guess; the transcript's own record wins
  "parent_session_id": "…",        // the session this one was resumed or forked from
  "fork_of": "…",                  // a fork: the parent whose history this log begins with
  "shipped": { "records": 12, "prefix_sha256": "…" },   // what the last answer said; see below
  "offset": 0                      // where `transcript` starts in the log: 0 for the whole log
                                   // (the default), else a chunk from there; see "In chunks"
}
```

The server redacts the transcript and stores it as the session's raw part, part 0, replacing
the parts before (a whole upload is the whole current log). That creates the session. It then
normalizes what it stored, redacts the records, and decides:

- **Worth a trace?** Under 2000 characters of conversation (or no user turn, or nothing
  answering it) is a greeting, not an investigation: `200 { "status": "trivial", … }`; the raw
  part stays and no trace is written, so the session is there with no head.
- **How much is new?** A client that shipped the session before sends back the `records_total`
  and `prefix_sha256` from that answer as `shipped`. If the session's records still begin with
  that prefix, only the meta record plus the tail is written, marked as a continuation; if not
  (the harness rewrote history, the normalizer changed), the whole session is written and dedupes
  by content. A fork (`fork_of`) likewise ships only what it added past the history it copied,
  when the parent is stored here.
- **Which branch?** The one the transcript recorded as it began (Claude Code's `gitBranch`,
  Codex's `session_meta`), else the client's `branch`.

`201` when a trace was written, `200` when the content was already there or the session was
trivial:

```json
{ "status": "stored", "archive_id": "…", "content_hash": "…", "session_id": "…",
  "records": 3, "events": 2, "records_total": 7, "prefix_sha256": "…", "bytes_total": 48213,
  "raw": { "status": "stored", "part": 0 } }
```

`records` is what this upload wrote; `records_total` and `prefix_sha256` describe the whole
normalized session and are what the client stores as `shipped` for next time; `bytes_total` is
how much of the log the server now holds, where the next chunk starts (every status returns
them, `trivial` included). `raw.status` is `stored` or `exists` (the same bytes were already
stored as that part).

`422` with a code is final for that upload (resending the same bytes cannot succeed):
`unsupported_agent`, `too_large` (the transcript is over the raw-part cap; nothing is stored),
`redacted`, `empty` (a blank transcript), `bad_chunk`, and after the raw part is stored,
`normalize_<code>`, `invalid`: the raw part stays for a later normalizer. A log the adapter
reads but finds no conversation in yet (a session that has only started) is `trivial`, not an
error. `502 storage_error` is the bucket failing and is retryable.

#### In chunks

A session's log only grows while the session runs (every harness appends a line per event), and
a client need not send the whole of it each time: it sends the bytes past what the server has.

```jsonc
{ "agent": "claude-code", "session_id": "…",
  "transcript": "<the log from byte 48213 on, whole lines>",
  "offset": 48213 }                // the bytes_total of the last answer
```

`offset` must be the session's `bytes_total` (what the last answer said; the session's
`metadata.json` holds it as `normalized.bytes`), else `409 offset_mismatch` with `expected` in
the error and nothing stored: the client resends from `expected`, or from 0 (the whole log)
when it no longer has that. A chunk is whole lines of a `jsonl` log (it ends with a line
break; an OpenCode `json` export cannot be chunked): `422 bad_chunk` otherwise. The first upload
of a session is the whole log (`offset` 0); a chunk for a session the server does not have gets
`409` with `expected: 0`.

A chunk is stored as its own raw part, normalized on its own (the records those lines stand
for), and written as a continuation of the session's trace: the meta record plus the chunk's
records, marked with where they start, exactly what a whole upload with `shipped` would have
written for the same growth. The server keeps what the continuation needs between chunks
(bytes covered, records so far, the prefix hash mid-stream), so a chunk sends no `shipped`;
`records_total` and `prefix_sha256` in the answer are still the whole session's, so a client
can go back to whole uploads with `shipped` and still be continued. A chunk with no records in
it (progress and transport lines) moves `bytes_total` on and ships nothing (`200 trivial`).

Whether a session is worth a trace is decided once: until it has one, each chunk is stored and
the chunks so far are normalized together as the whole log and judged the way a whole upload
is (`trivial` until there is a conversation of substance); once it has one, every chunk with
records in it ships. A whole upload (`offset` 0) after chunks replaces every part with the
log it carries and starts the chunk state over; a chunk past a part that failed to normalize
replaces that part.

The cut between chunks is the client's: a line boundary, anywhere. A log that the harness
rewrote in place (Claude Code and Codex rewrite nothing; a harness that compacts its history
might) is the client's to notice, by keeping a hash of what it sent: a whole upload then
dedupes by content as before.

`agent` is part of the archive id (`sha256(owner, agent, session_id)`), which is why only the
trajectory source name is accepted (`claude-code`, not `claude`): one spelling, one archive.

### Datadog Trajectory's format

[Trajectory](https://github.com/datadog-labs/trajectory) is Datadog's capture daemon for coding
agents. It records each session it captures, from Claude Code, Codex, Cursor, Pi and the other
clients it supports, as one canonical event per line in a file of its own format, at
`~/.trajectory/trajectories/sessions/<date>/session-<id>.jsonl`. This server reads that format.
It has no dependency on the daemon or its CLI and no endpoint for it; `datadog-trajectory` is
one more transcript format, normalized to trajectory-v1 by the server's own adapter
(`@letta-ai/trajectory` has none for it) and stored like every other.

A file in that format gets in like any other transcript: `POST /v1/sessions` with
`agent: "datadog-trajectory"` and the file as `transcript`, whole or [in chunks](#in-chunks) as
the daemon appends to it. A file with no `session_end` is a session that is still running; it
normalizes to what it has so far, and the next chunk continues it.

The session is filed as `agent: datadog-trajectory` and its trace's `source` names the client
the daemon captured, `datadog-trajectory:claude-code`, so a session captured both ways (a
client posting the native log and the same session in Trajectory's format) is two archives,
each honest about what normalized it. `session_id`, `git_branch` and `parent_session_id` come
from the file's `session_start`; the branch is the one the daemon recorded.

What the adapter keeps: `user_prompt` / `input_prompt` as user records (as observations when
the daemon attributes them to something other than a person), `tool_use` with `phase: pre` as
tool calls under the client's own tool name, `phase: post` as results with `ok` from `success`,
and `agent_message` as reasoning and assistant records. Accounting and lifecycle events
(`llm_call`, `turn_end`, `inventory.snapshot`, permissions, subagent start and stop) carry no
conversation and are dropped; a subagent's answer arrives as the `Agent` tool's result, and its
own session as its own file. A file with no `session_start` gets `422
normalize_missing_session_start`.

A session the daemon imported from a client's own history (`trajectory session import`) is
thinner than one it captured live: no prose from the agent, and tool calls present only as
their results. The adapter reads those too, and most come out `trivial`, which is right: there
is no conversation in them.
