# dosu-sessiondb (Python)

Read coding-agent sessions out of a [sessionstorage](../../spec/layout.md) bucket, or talk to a
[sessiondb server](../../docs/server.md). The Python side of
[`@dosu/sessiondb`](../typescript): the same layout, the same API shapes, the same words.

```sh
pip install 'dosu-sessiondb[s3]'       # read a bucket (boto3)
pip install 'dosu-sessiondb[server]'   # talk to a server (httpx)
```

Python 3.12+. `pydantic` is the one hard dependency.

## What it does, and what it does not

The TypeScript SDK is the whole pipeline: it redacts and normalizes a transcript and writes the
bucket. This package is the **reader** half of that over a store, and a **full client** of a
server. A Python program that consumes sessions (a backend that learns from them, a poller, a
script) opens the bucket read-only or asks the server; one that wants to *store* a session sends
it to a server, which runs the pipeline. Normalization and redaction are not reimplemented here,
on purpose: there is one normalizer per source, and it lives where the writes happen.

## Reading a bucket

```python
from sessiondb import S3Credentials, connect, open_store

opened = open_store(
    "r2://acme-sessions/prod",
    account_id="…",  # or endpoint=, for S3-compatible stores
    credentials=S3Credentials("AKIA…", "…"),  # omit to let boto3 find them
)
db = connect(store=opened.store, owner="acme")
db.check()  # lists the prefix and reads sessionstorage.json: a wrong bucket fails here

pointer = db.get_session("claude-code", "8f1c2d3e-…")  # metadata.json, or None
trace = db.get_trace("claude-code", "8f1c2d3e-…")  # the head trace, or None
for pointer in db.iter_sessions():  # a full scan
    ...
```

A reader needs `s3:ListBucket` on the prefix and `s3:GetObject` under it, nothing more.
`file:///path` (or a bare absolute path) opens a directory the TypeScript `FsStore` wrote, which
is also what the tests use.

### Tailing the change feed

`owners/<owner>/changes/` is append-only and its keys sort by time, so the feed is a listing
after a cursor: the last key you processed.

```python
cursor = load_cursor()  # None the first time
page = db.changes(after=cursor, limit=1000)
for change in page.entries:
    entry = change.entry
    if entry.kind == "published":
        trace = db.read_trace(entry.archive_id, entry.content_hash)  # None if tombstoned since
    elif entry.kind == "tombstone":
        forget(entry.archive_id)
    cursor = change.key
save_cursor(page.cursor or cursor)
```

The stamps come from the clocks of the laptops that uploaded, so an entry can land *behind* your
cursor. A consumer that must not miss one re-reads a window behind the cursor and dedupes by
key:

```python
from sessiondb import lag_start, parse_change_key

at = parse_change_key(cursor).at if cursor else None
since = lag_start(at, lag=300)  # five minutes behind the cursor
for change in db.iter_changes(since=since):
    if already_processed(change.key):
        continue
    ...
```

`iter_changes` walks pages; `count_changes_after(cursor)` says how far behind you are.

A session that grew after it was stored has a second trace with a `continuation` (where its
records start in the whole session). `read_traces(pointer)` returns them all in order; a
consumer that handles one change at a time just reads the trace the entry names.

## Talking to a server

```python
from sessiondb import connect

db = connect(server="https://sessiondb.example.com", token="…")
me = db.me()  # the owner the token names, and where the sessions go
page = db.changes(after=cursor)  # the same reads as above, under that owner

result = db.ingest(
    agent="claude-code",
    session_id="…",
    transcript=open(log).read(),
    project="github.com/acme/widget",
)
result.status  # "stored" | "duplicate" | "trivial"
result.shipped  # send back next time, so a grown session ships only its tail
```

Refusals come back as the errors the pipeline would raise: `SessionRejected` (422, the same
bytes cannot succeed; `.code` says why), `OffsetMismatch` (409, resend from `.expected`),
`StoreError` (502, retry), `Unauthorized` (401). Bodies over 8 KiB go up gzipped.

## Errors

Everything raised on purpose is a `SessionDBError`. `StoreError` is the bucket or the server
failing (retry); `LayoutError` is bytes that are not a layout this version reads (an unknown
`schema`, a malformed object: fix the setup, do not retry).

## Development

```sh
cd sdks/python
uv sync --all-extras
uv run pytest             # against tests/fixtures/bucket
uv run ruff check . && uv run ruff format --check . && uv run mypy
```

`tests/fixtures/bucket` is a golden bucket the TypeScript SDK wrote
(`bun run scripts/golden-bucket.ts` at the repository root): what Python reads must equal what
TypeScript put in, hash for hash. Regenerate it after a change to the layout or the normalizers.
The S3 test runs when `SESSIONDB_TEST_S3_{ENDPOINT,BUCKET,ACCESS_KEY,SECRET_KEY}` point at a
live endpoint (CI uses RustFS).
