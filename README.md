# sessiondb

A small server that turns coding-agent sessions into a durable, redacted, content-addressed
archive in your own bucket.

Claude Code, Codex, Cursor, OpenCode, pi and Gemini CLI each write a log of what they did, in
their own format, on the machine they ran on. Those logs are the record of how the work was
done, and they are also full of secrets, scattered across laptops, and shaped six different
ways. sessiondb takes a log over HTTP, normalizes it to one format
([Letta trajectory-v1](https://github.com/letta-ai/trajectory)), scrubs credentials out of it,
decides whether it is worth keeping, and writes it to S3, Cloudflare R2, any S3-compatible
store, or a folder, under a documented layout that anything can read.

```
client ──POST /v1/sessions (raw transcript, bearer token)──▶ sessiondb
                                                               store raw · normalize · trace
                                                                    │
                                                                    ▼
                                                   your bucket (s3:// r2:// file://)
                                                                    ▲
                                                 readers tail changes/ with their own key
```

Three properties follow from that shape:

- The machine running the agent never holds a bucket credential. It holds a token for one
  person, which can post that person's sessions and read them back, and nothing else.
- The bucket never holds an unredacted byte. Redaction happens on the server, before anything
  is written, and there is no switch to turn it off.
- Readers never talk to the server. A read-only key on the bucket is enough to tail the change
  feed, so the archive outlives any particular deployment of this code.

## Quick start

```sh
git clone https://github.com/dosu-ai/sessiondb && cd sessiondb
cp .env.example .env        # tokens, the bucket URL and its keys
bun install
bun start                   # http://localhost:7200
```

Or in a container, with the same `.env`:

```sh
docker compose up -d
```

At boot the server writes a layout marker and a probe object, so a wrong bucket or key fails
immediately rather than on the first upload. Then post a session:

```sh
jq -n --rawfile transcript ~/.claude/projects/-repo-app/8f1c….jsonl \
  '{agent: "claude-code", session_id: "8f1c…", transcript: $transcript,
    project: "github.com/acme/widget", branch: "main"}' |
curl -sS http://localhost:7200/v1/sessions \
  -H "Authorization: Bearer $SESSIONDB_TOKEN" -H "Content-Type: application/json" --data-binary @-
```

```json
{ "status": "stored", "archive_id": "…", "content_hash": "…", "session_id": "8f1c…",
  "records": 41, "events": 38, "records_total": 41, "prefix_sha256": "…", "bytes_total": 48213,
  "raw": { "status": "stored", "part": 0 } }
```

As the session goes on, send only what the log gained since, as a chunk from `bytes_total`:

```sh
tail -c +48214 ~/.claude/projects/-repo-app/8f1c….jsonl |
jq -Rs '{agent: "claude-code", session_id: "8f1c…", transcript: ., offset: 48213}' |
curl -sS http://localhost:7200/v1/sessions \
  -H "Authorization: Bearer $SESSIONDB_TOKEN" -H "Content-Type: application/json" --data-binary @-
```

The chunk is normalized on its own and stored as a continuation of the session's trace; the
server keeps where the log stands, so a large session costs each time only what was appended.

The full API, every environment variable, and the rules for chunks, continuations and forks
are in [`docs/server.md`](docs/server.md).

### Datadog Trajectory's format

[Datadog Trajectory](https://github.com/datadog-labs/trajectory) records coding-agent sessions
in a format of its own, one file per session under `~/.trajectory/trajectories/sessions/`.
sessiondb reads that format: post the file as `agent: "datadog-trajectory"`, whole or in chunks
as the daemon appends to it, and it is normalized to Letta trajectory-v1 like any other
transcript. Nothing in sessiondb depends on the Trajectory daemon or CLI; it is one more input
format.

## What the server does with a session

Storage first, then normalize, then the trace. The trace is always made from what is in the
bucket, so the second step can run again on its own.

1. **Store.** The native log passes through the redaction pass (provider tokens, key/value
   credentials in several languages, bearer headers, JWTs, connection URLs, PEM blocks, and a
   Shannon-entropy pass for what no pattern knows) and is written as the session's raw part.
   That creates the session; nothing else has happened yet.
2. **Normalize.** The stored log becomes trajectory-v1 records via
   [`@letta-ai/trajectory`](https://github.com/letta-ai/trajectory), plus the fixups its
   adapters need (Claude Code's queued and background-task input, Codex's inherited history and
   subagent reports). `agent` is the adapter name, one of `claude-code`, `codex`, `cursor`,
   `opencode`, `pi`, `gemini-cli`, or `datadog-trajectory`, the server's own adapter that turns
   a Trajectory session file into the same Letta records as everything else. The records get the
   redaction pass too, with identifiers that link a tool call to its result left alone so they
   stay coherent.
3. **Decide what is new.** A conversation under 2000 characters, or with no user turn, or with
   nothing answering it, is reported as `trivial`: the raw part stays, no trace is written. A
   session uploaded before writes only its tail (the client sends back `records_total` and
   `prefix_sha256` from the last answer); a fork writes only what it added past the history it
   copied.
4. **Hash and publish.** `content_hash` is a hash of what was said, independent of timestamps,
   so re-exporting the same conversation writes nothing. The trace is written under its hash,
   the session's pointer gets it as head, and an entry is appended to the change feed.

The layout is the contract, documented in [`docs/layout.md`](docs/layout.md): raw transcript
parts, immutable content-addressed traces made from them, one mutable pointer per session, and
an append-only change feed.

## Storage

`SESSIONDB_STORE_URL` selects the store:

| URL | Credentials |
|---|---|
| `r2://bucket/prefix` | `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` |
| `s3://bucket/prefix` | `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` |
| `s3://bucket/prefix` + `S3_ENDPOINT` | MinIO, RustFS, Backblaze B2, Wasabi, and other S3-compatible services |
| `file:///path` | None. A folder on the server's disk, for development or a single box |

Every write is verified (ETag against MD5 where the service reports one, a read-back otherwise)
before the pointer and change feed are updated, so a reader never sees a change entry for an
object that is not there.

## Access model

A token is bound to a name and every request is scoped to `owners/<name>/` in the bucket. Two
people on one server never see each other's sessions; a token leaked from one laptop exposes one
person's archive. A reader with its own bucket key sees every folder, which is the point: the
team's archive is the bucket, a person's view is their folder.

The server sees transcripts before redaction. Run it behind TLS, and read [`SECURITY.md`](SECURITY.md)
before exposing it.

## Development

```sh
bun install
bun run test          # the S3 store test needs SESSIONDB_TEST_S3_* and skips without them
bun run typecheck
bun run check         # biome lint + format
bun run goldens       # regenerate testdata/goldens after a deliberate change to hashing or events
bun run e2e           # fake a Datadog Trajectory session and ship it to a running server, whole and in chunks
```

`bun run e2e` writes a session in the Trajectory daemon's format (with a credential planted, so
redaction is visible), ships it to `http://localhost:7200` with the first token in `.env` (so
`bun start` in another terminal is enough) or to `SESSIONDB_URL` with `SESSIONDB_TOKEN`, checks
the whole and chunked uploads agree, reads the trace back, and tombstones the test sessions.
A real session file from `~/.trajectory/trajectories/sessions/` can be passed instead.

`testdata/goldens/` pins the normalized records of every fixture transcript and the
`content_hash` and events each parses to. The goldens test fails on any change to the hash
derivation, so such a change is a reviewed diff and never an accident. Fixture transcripts are
generated by `scripts/fixtures.ts`, so they contain no real sessions.

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for how changes are reviewed.

## License

[MIT](LICENSE).
