# @dosu/sessiondb

The sessiondb SDK: coding-agent sessions as a durable, redacted, content-addressed archive in a
bucket you own, written in the [sessionstorage layout](../../spec/layout.md).

```sh
bun add @dosu/sessiondb    # or npm install
```

One client, two backends:

```ts
import { connect } from "@dosu/sessiondb";

// Serverless: redact and normalize here, write the bucket with this machine's credential.
const db = connect({ store: "s3://acme-sessions/archive", owner: "alice" });

// Or through a sessiondb server, which runs the same pipeline against its own bucket.
const db = connect({ server: "https://sessiondb.acme.internal", token: process.env.SESSIONDB_TOKEN });
```

The calls are the same either way:

```ts
const result = await db.ingest({
  agent: "claude-code",
  session_id: "8f1c…",
  transcript: await Bun.file("~/.claude/projects/-repo-app/8f1c….jsonl").text(),
  project: "github.com/acme/widget",
});
// { status: "stored", content_hash: "…", records_total: 41, bytes_total: 48213, … }

// As the session goes on, send what the log gained since, from where the last answer ended.
await db.ingest({ agent: "claude-code", session_id: "8f1c…", transcript: tail, offset: result.bytes_total });

const metadata = await db.getSession("claude-code", "8f1c…");
const trace = await db.getTrace("claude-code", "8f1c…");
const page = await db.listSessions();
const feed = await db.changes({ after: cursor });
await db.tombstone("claude-code", "8f1c…");
```

And so is what they throw: `SessionRejected` (a transcript that cannot be stored, with the
`code` the server would report), `OffsetMismatch` (a chunk that does not start where the log
ends; `expected` says where), `StoreError` (the bucket, or the server, is unreachable). The
HTTP backend adds `ServerError` for the responses that are not one of those.

## Which backend

| | `connect({ store, owner })` | `connect({ server, token })` |
|---|---|---|
| Where redaction runs | On this machine, before any write | On the server, before any write |
| What this machine holds | A bucket credential, scoped to `owners/<owner>/` by bucket policy | A token for one owner |
| Who sees the transcript unredacted | Only this machine | This machine, the network path, the server |
| Owner isolation enforced by | The bucket's own policy | The server's token list |

One person with their own bucket wants the first. A team wants the second: redaction is
enforced where a laptop cannot skip it, and one line in `SESSIONDB_TOKENS` is a person.

## Stores

`store` is a `Store` or its URL: `s3://bucket/prefix` (AWS; `S3_ENDPOINT` for MinIO, Backblaze,
Wasabi…), `r2://bucket/prefix` (Cloudflare; `R2_ACCOUNT_ID`), or `file:///path`. Credentials
come from the usual `AWS_*` / `R2_*` variables or `credentials` in the options. `openStore(url)`
is the same resolution on its own.

## Runtimes

Bun runs the package from its TypeScript source (the `bun` export condition); Node 20+ loads
the bundled `dist/`. Everything works on both except the S3/R2 store, which is over
`Bun.S3Client` and throws a `StoreError` saying so under Node; a Node program that wants a
bucket talks to a sessiondb server for now.

The HTTP backend takes `timeoutMs` (default 120 s per request, 0 to disable), `userAgent`
(so the server's logs name the program, `dosu-cli/0.68.5`), and `fetch` for tests.

## Lower down

`storeSession`, `getSession`, `getTrace`, `listSessions`, `readChanges` and `tombstone` are the
pipeline over a `Store` without the client; `normalizeTranscript`, `redactRaw`, `redactRecords`
and `parseTrajectory` are its pieces. `spec/testdata/goldens/` pins what they produce.
