# The sessiondb server

A client posts the raw transcript of a finished session; the server normalizes it to
trajectory-v1, redacts it, decides whether it is worth keeping and how much of it is new, and
writes it to the bucket in the [layout](layout.md). Anything that reads the layout reads the
bucket directly: the server is the only writer and no reader's dependency.

```
client ──POST /v1/sessions (raw transcript, bearer token)──▶ sessiondb server
                                                               normalize · redact · ingest()
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

### Who sees what

A token is bound to one name and the server scopes every call to `owners/<name>/`: the
session list, reads, deletes, the change log and raw object reads. Two people on one server
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

All bodies are JSON. Errors are `{ "error": { "code", "message" } }`. Request bodies may be
`Content-Encoding: gzip`. Every route but `/healthz` wants `Authorization: Bearer <token>`.

| | |
|---|---|
| `GET /healthz` | `{ok, version}`, no auth |
| `GET /v1/me` | `{owner, storage: {url, region?, account_id?, endpoint?}}`: which bucket this server writes, so a client can point a reader at it. Never a secret |
| `POST /v1/sessions` | Store a session; see below |
| `GET /v1/sessions?limit&after` | List |
| `GET /v1/sessions/:agent/:session_id` | The session's `metadata.json` |
| `GET /v1/sessions/:agent/:session_id/trace?hash` | The head trace (or a specific one); `410` once redacted |
| `DELETE /v1/sessions/:agent/:session_id` | Tombstone: drop trace and raw objects, append a tombstone change. Irreversible; a later upload of the same session is refused |
| `GET /v1/changes?after&since&limit` | The change feed |
| `GET /v1/objects?prefix&after&limit` | List keys under `owners/<owner>/` |
| `GET /v1/objects/<key>` · `HEAD` | Read one object / its size and ETag. Read-only; writes go through `/v1/sessions` |

### `POST /v1/sessions`

```jsonc
{
  "agent": "claude-code",          // the trajectory source: claude-code, codex, cursor, opencode, pi, gemini-cli
  "session_id": "…",
  "transcript": "…",               // the native log, verbatim
  "format": "jsonl",               // or "json" (OpenCode exports); how the raw copy is redacted
  "project": "github.com/acme/widget",
  "branch": "main",                // the client's best guess; the transcript's own record wins
  "parent_session_id": "…",        // the session this one was resumed or forked from
  "fork_of": "…",                  // a fork: the parent whose history this log begins with
  "shipped": { "records": 12, "prefix_sha256": "…" },   // what the last answer said; see below
  "keep_raw": true                 // store the redacted native log beside the trace (default)
}
```

The server normalizes, redacts, and decides:

- **Worth keeping?** Under 2000 characters of conversation (or no user turn, or nothing
  answering it) is a greeting, not an investigation: `200 { "status": "trivial", … }` and
  nothing is written.
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
  "records": 3, "events": 2, "records_total": 7, "prefix_sha256": "…",
  "raw": { "status": "stored", "part": 0 } }
```

`records` is what this upload wrote; `records_total` and `prefix_sha256` describe the whole
normalized session and are what the client stores as `shipped` for next time (every status
returns them, `trivial` included). `raw.status` is `stored`, `exists`, `skipped`
(`keep_raw: false`) or `too_large` (the trace was still written). The raw copy is always the
whole current log, replacing part 0.

`422` with a code is final for that upload (resending the same bytes cannot succeed):
`unsupported_agent`, `empty` (no conversation), `normalize_<code>`, `invalid`, `too_large`,
`redacted`. `502 storage_error` is the bucket failing and is retryable.

`agent` is part of the archive id (`sha256(owner, agent, session_id)`), which is why only the
trajectory source name is accepted (`claude-code`, not `claude`): one spelling, one archive.
