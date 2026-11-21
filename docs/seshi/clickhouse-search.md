# ClickHouse as a search backend: scoping

Status: a proposal for discussion. Nothing here is built. It scopes the "later" in F10.3
("ClickHouse as a second backend, for larger orgs or analytics over sessions") against the code
as it is on `main` (search package `packages/ts/search/src/`, `docs/search.md`). ClickHouse facts
were checked against clickhouse.com/docs and release notes in November 2026; the versions they
depend on are named where they matter.

## Summary

Add a ClickHouse backend for teams that run the server. It sits beside the SQLite index, which
stays the default and the only backend in serverless mode. ClickHouse holds a derived,
rebuildable copy built from the change feed, like the SQLite file (X6.1). It is never the store
of record, and the API never writes to it.

The seam already exists: `IndexStore = SearchBackend & FeedState` in `backend.ts`. But it is
shaped for an embedded database, and it needs changing first, with SQLite still the only
backend:

1. It is synchronous (`bun:sqlite`) and chatty: one conditional call per session, and a
   `transaction(fn)` callback that ClickHouse cannot honour. It becomes an async
   [`IndexReader` and `IndexWriter`](#proposed-interface), and the indexer writes one feed page
   per `commit()`.
2. `BackendQuery.match` is an FTS5 expression string. It should be a small parsed tree that each
   backend compiles.
3. Excerpts come from FTS5's `snippet()`. ClickHouse has nothing like it, so its excerpts are
   made in TypeScript.

The main change in how it runs: with ClickHouse there is **one index for all instances, written
by one indexer** (the worker, X7.2), instead of one index per instance. API instances only query.
Most of the ingest design follows from that, and from ClickHouse having no transactions.

ClickHouse's full-text `text` index (an inverted index) is generally available from **26.2**, and
26.3 is an LTS release. Every query feature maps onto it, with two gaps:

- **Prefix search** (`word*`) has no token-prefix function. It uses a `LIKE` hint plus a regex
  check.
- **Relevance has no built-in BM25.** A `textSearch(…, bm25(…))` table function is only an open
  RFC (ClickHouse/ClickHouse#105781). Until it ships, relevance is a BM25 formula written in SQL
  over the matching rows.

The rough size is three to five weeks for one person: a spike, the seam refactor, the backend,
then deployment. The details are in the [plan](#phased-plan).

## Decisions proposed

| | Proposal |
|---|---|
| F10.6 | `[search] backend = "clickhouse"` is a server-only option. SQLite stays the default. Serverless mode always uses SQLite, and laptops ignore the shared config's backend. |
| F10.7 | `IndexStore` splits into an async `IndexReader` (queries, state, the cross-owner feed) and `IndexWriter` (the indexer). The indexer writes one feed page per `commit()`, every write names its generation, and queries take a parsed tree. The behaviour of the SQLite backend does not change. |
| F10.8 | With ClickHouse, one indexer (the worker role) writes the index and every API instance reads it. The search job's placement becomes `worker` for this backend. |
| F10.9 | Text is normalized in TypeScript, the same way for documents and queries, and indexed with `text(tokenizer = splitByNonAlpha)`. The original text is kept for excerpts. |
| F10.10 | Writes are idempotent, not transactional: content first, then the feed state, then the cursor. A session's events belong to an *epoch*. Old epochs stop matching as soon as the session row moves on, and are then deleted. |
| F10.11 | A rebuild writes into a new set of tables and switches over when it has caught up. Search keeps answering from the old set until then. Only the very first build answers 503. |
| F10.12 | Analytics (tokens, spend) get their own tables, fed by the same pass over the feed. They come later and do not shape the search tables. |

## Today's interface, and the seam

`backend.ts` names the contract outright. `SearchBackend` covers the search data:
`session(owner, archive)`, `apply(update)`, `remove(owner, archive, readAt)`, `query(q)` and
`counts()`. `FeedState` covers the indexer's bookkeeping:

- cursors and the lag window's `seen` keys;
- the copy of every change entry behind `GET /v1/changes/all` (`record`, `feed`,
  `readThrough`);
- readiness (`readyAt`, `caughtUp`);
- `generation()`/`reset()` for rebuilds;
- `transaction(fn)`.

`SqliteIndex` implements both. `Indexer` and `SearchService` only use the interface, except in
one place: `SearchService.open()` constructs `SqliteIndex` directly.

That shape suits an embedded database, where every call is cheap and `transaction(fn)` makes a
callback atomic. Against ClickHouse it breaks down in five places:

- **`transaction(fn)` takes a callback.** ClickHouse has no transactions, so the backend would
  have to buffer the writes made inside `fn`. But reads inside `fn` (`generation()`, the held
  session) go to the server and do not see those buffered writes. Today's indexer reads inside
  the transaction, so that is a trap waiting to happen.
- **`apply()` and `remove()` are conditional and per session.** Each needs the held state (a
  read per session, or a hidden cache), and each `remove()` would be one lightweight `DELETE`.
  That is a mutation, and ClickHouse advises against many small ones.
- **A search costs four calls:** `readyAt()`, `query()`, `caughtUpAt()` and `counts()`. That is
  four round trips, and `counts()` is a `count()` over `sessions FINAL` on every search.
- **`cursor(owner)` is read once per owner per pass:** with many owners, one round trip each,
  every `search.interval`.
- **Nothing names a backend that cannot be reached.** A timeout should answer 503, not 500.

So the seam changes in five ways, with SQLite still the only backend:

1. **Split it into a reader and a writer, both async.** `SearchService.search`, `status` and
   `changes` use only `IndexReader`. The indexer uses only `IndexWriter`. That also matches the
   two ClickHouse users: read-only for API instances, read-write for the indexer.
2. **Write one feed page at a time, as data.** `drain()` already plans a page and then applies
   it. The plan becomes a `PageCommit` that the backend writes in one call. SQLite writes it in
   one transaction, as today. ClickHouse writes it in a fixed order, cursor last. Every writer
   call names the generation it was read for, which replaces the generation check inside the
   transaction.
3. **Pass a parsed query.** `parseQuery` already has the structure: groups of items ANDed, items
   inside a group ORed, negated items, and each item a phrase and/or prefix. Return that as a
   `MatchTree` and have `BackendQuery` carry it in place of `match`. SQLite compiles it to the
   same FTS5 string as today (`quoted()` moves into `sqlite.ts`). ClickHouse compiles it to SQL
   with bound parameters. `ParsedQuery.terms` stays as it is.
4. **Build the backend from config.** `SearchService` takes an `OpenIndex` factory where it now
   writes `new SqliteIndex(...)`. Instance and serverless wiring choose the factory.
   `SearchStatus.path` becomes `location`: the file path, or the ClickHouse host and database
   with no credentials.
5. **Let the backend supply excerpts.** `BackendMatch.marked` stays as it is. SQLite fills it from
   `snippet()`. ClickHouse returns the record's text and a shared `excerpt(text, tree)` in
   `snippet.ts` marks it. This is the one piece of new search logic outside the backend.

The call sites that become async are mechanical but many: `Indexer.pass`, `drain` and `plan`;
`SearchService.status`, `ready`, `search` and `changes`; `readFeed`; the `search-index` job's
`backlog()` (already async); and `seshi search --status`.

## Proposed interface

These replace `SearchBackend`, `FeedState` and `transaction()` in `backend.ts`. `IndexedSession`,
`IndexedEvent`, `SessionUpdate`, `BackendMatch`, `BackendHit`, `BackendResults`, `FeedPosition`
and `FeedRow` stay as they are.

```ts
// query.ts: parseQuery returns this, and each backend compiles it.
export interface MatchItem {
  /** Words after the shared normalizer (lower case, no accents, split on anything that is not
   * a letter or digit). More than one word is a phrase: `src/app.ts` → ["src", "app", "ts"]. */
  tokens: string[];
  /** `word*` or `"a phrase"*`: the last word is a prefix. */
  prefix: boolean;
}

export interface MatchTree {
  /** Every group must match one record; within a group, any item will do. */
  all: MatchItem[][];
  /** A record holding any of these does not match. */
  none: MatchItem[];
}

// backend.ts
export interface BackendQuery {
  match: MatchTree; // was the FTS5 string
  viewer: Viewer;
  owners?: readonly string[];
  agent?: string;
  repo?: string;
  branch?: string;
  source?: string;
  since?: number;
  until?: number;
  sort: SearchSort;
  limit: number;
  offset: number;
  matches: number;
}

/** What a search reports about the index, read in one go. */
export interface IndexState {
  /** When the live generation first caught up; undefined before any has. */
  ready_at?: string;
  caught_up_at?: string;
  sessions: number;
  events: number;
  generation: string;
  /** A rebuild in progress: the generation being built and how far it has read. */
  building?: { generation: string; read_through?: string };
}

/** The API's side: SearchService.search, status and changes. Reads the live generation. */
export interface IndexReader {
  /** A file path, or a ClickHouse host and database. Never credentials. */
  location(): string;
  /** One read. The backend may cache it for a few seconds: a search reports it, nothing
   * decides on it. */
  state(): Promise<IndexState>;
  /** `BackendMatch.marked` is filled by the backend: from FTS5's snippet() for SQLite, from
   * the shared excerpt(text, tree) for ClickHouse. */
  query(query: BackendQuery): Promise<BackendResults>;
  /** The cross-owner feed (`GET /v1/changes/all`); null until every feed has been read once. */
  feed(
    after: FeedPosition | undefined,
    limit: number,
  ): Promise<{ entries: FeedRow[]; more: boolean; through: string } | null>;
  close(): Promise<void>;
}

/** The indexer's side. Every call names the generation it reads or writes, so a run that
 * started before a reset writes only to the generation it read: never into a rebuild. */
export interface IndexWriter {
  /** The generation writes go to: the live one, or the one being built. */
  generation(): Promise<string>;
  /** Every owner's cursor, once a pass. */
  cursors(gen: string): Promise<Map<string, string>>;
  /** Which of `keys` were already processed (within the lag window). */
  seen(gen: string, owner: string, keys: readonly string[]): Promise<Set<string>>;
  /** What the index holds of these sessions; missing and removed ones are absent. */
  sessions(
    gen: string,
    owner: string,
    archives: readonly string[],
  ): Promise<Map<string, IndexedSession>>;
  /** One feed page. SQLite writes it in one transaction. ClickHouse writes sessions, events,
   * one batched delete, the feed copy, seen keys, then the cursor last. Writing a page twice
   * changes nothing, so a crash part-way is repaired by reading the page again. */
  commit(page: PageCommit): Promise<CommitResult>;
  /** Every owner's feed has been read after `through` (for the cross-owner feed). */
  readThrough(gen: string, through: string): Promise<void>;
  /** A full pass over every owner ended at `at`. The first one for a generation that is being
   * built makes it the live one. False when `gen` is no longer the one writes go to. */
  passDone(gen: string, at: string): Promise<boolean>;
  /** Start a new generation and return it. SQLite empties the file, so searches answer 503
   * until it catches up. ClickHouse builds new tables while searches read the old ones. */
  reset(): Promise<string>;
}

export interface PageCommit {
  generation: string;
  owner: string;
  /** Sessions to index: a replace, or a continuation checked against its `base`. */
  updates: SessionUpdate[];
  /** Tombstones, and sessions no longer admitted. */
  removals: { archive: string; read_at: number }[];
  /** For the cross-owner feed; empty unless the index keeps it. */
  feed: { name: string; entry: ChangeEntry }[];
  seen: { key: string; at: number }[];
  cursor: string | undefined;
  /** Forget processed keys stamped before this (epoch ms). */
  forgetBefore: number;
}

export interface CommitResult {
  /** `generation` is no longer the one writes go to; nothing that matters was written. */
  stale: boolean;
  /** Continuations whose `base` was not what the index held: plan these again. */
  refused: string[];
  /** Sessions removed that the index held. */
  removed: number;
}

export type IndexStore = IndexReader & IndexWriter;

export interface IndexOptions {
  deployment: string;
  events: readonly EventRole[];
  scope?: string;
  feed?: boolean;
}

/** What SearchService calls in place of `new SqliteIndex(...)`. */
export type OpenIndex = (options: IndexOptions) => Promise<IndexStore>;
// sqliteIndex({ path }): OpenIndex
// clickhouseIndex(config.search.clickhouse): OpenIndex

/** The backend cannot be reached, or timed out: the API answers 503, the CLI exits 7. */
export class IndexUnavailable extends Error {
  readonly code = "index_unavailable";
}
```

How the indexer uses it:

- **A pass** reads `generation()` and `cursors(gen)` once.
- **Each page** reads `seen(gen, owner, keys)` and `sessions(gen, owner, archives)`, plans,
  then calls `commit()`. A `refused` continuation is planned again and sent in a second
  `commit()` holding only those sessions, as `drain()` does today. `stale` ends the pass, as a
  changed generation does today.
- **At the end of a pass** it calls `readThrough(gen, …)` and `passDone(gen, at)`.

`SqliteIndex` implements `commit()` as today's transaction body: `apply` and `remove` per plan,
`record`, `advance`. Its behaviour does not change; the conformance suite (see
[CI and tests](#config-and-deployment)) holds it to that. `generation()` is the same for writing
and reading in SQLite, since a reset empties the one file.

Why this shape:

- **Writes are data, not callbacks.** Nothing reads inside a write, so the backend never has to
  pretend to read its own buffered writes. Each backend commits a page the way it does best.
- **Generations are explicit.** Blue-green rebuilds need no lock: a stale run's writes land in
  the old tables, which are dropped. SQLite gets the same guarantee from its existing check.
- **A search costs two calls,** `state()` and `query()`, and `state()` may be cached.
- **Counts are reported, not computed per search.** ClickHouse can keep them in `meta` at the end
  of each pass.

The indexer's logic does not change, only how it hands a page over. That covers reading
metadata, `currentTraces` and `tracesFrom`, `shows()`, the lag window, owner discovery, and
refused continuations. The API does not change either, and `GET /v1/changes/all` keeps working
because the ClickHouse backend implements `feed()` too. The alternative was a hybrid that keeps `FeedState` in a local SQLite file and
puts only search data in ClickHouse. It is rejected: every API instance would still tail every
feed, which is the cost a shared index is meant to remove.

## Schema sketch

There is one database (`search.clickhouse.database`). Every table name starts with
`table_prefix`, and the generation-scoped tables end in `_<gen>`. `<gen>` is the generation, a
short random id that is new on every rebuild.

```sql
-- Not generation-scoped: which generation is live, plus the checks SQLite keeps in `meta`.
CREATE TABLE seshi_search_meta (key String, value String, at DateTime64(3))
ENGINE = ReplacingMergeTree(at) ORDER BY key;
-- schema, deployment, events, active_gen, building_gen, ready_at, caught_up_at, feed_through

-- One row per version of a session; the newest read wins.
CREATE TABLE seshi_search_sessions_<gen> (
  owner String, archive_id FixedString(64),
  agent LowCardinality(String), session_id String, origin_agent LowCardinality(String),
  native_session_id String, project String, branch String, source_id LowCardinality(String),
  visibility Enum8('owner' = 1, 'org' = 2),
  started_at Nullable(DateTime64(3)), ended_at Nullable(DateTime64(3)),
  updated_at String, updated_ms Int64,
  traces Array(FixedString(64)),
  epoch UInt64,            -- read_at of the last replace: the events that count have it
  read_at UInt64,          -- version
  removed UInt8
) ENGINE = ReplacingMergeTree(read_at) ORDER BY (owner, archive_id);

-- One row per searchable record.
CREATE TABLE seshi_search_events_<gen> (
  owner String, archive_id FixedString(64), epoch UInt64,
  content_hash FixedString(64), event_index UInt32,
  role LowCardinality(String), tool_name LowCardinality(String),
  ts Nullable(DateTime64(3)),
  text String CODEC(ZSTD(3)),   -- as stored (redacted), for excerpts; at most 32 KiB
  norm String CODEC(ZSTD(3)),   -- normalized: lower case, no accents, words split by one space
  INDEX norm_idx norm TYPE text(tokenizer = splitByNonAlpha)
) ENGINE = MergeTree ORDER BY (owner, archive_id, epoch, content_hash, event_index);

-- FeedState: cursors, the lag window's keys, the copy of the feed.
CREATE TABLE seshi_search_cursors_<gen> (owner String, cursor String)
ENGINE = ReplacingMergeTree(cursor) ORDER BY owner;          -- cursors only move forward
CREATE TABLE seshi_search_seen_<gen> (owner String, key String, at DateTime64(3))
ENGINE = ReplacingMergeTree ORDER BY (owner, key) TTL toDateTime(at) + INTERVAL 1 DAY;
CREATE TABLE seshi_search_changes_<gen> (stamp String, owner String, name String, entry String)
ENGINE = ReplacingMergeTree ORDER BY (stamp, owner, name);
```

Notes:

- **Session fields stay on `sessions`.** They are not copied onto every event, because a
  visibility change or a new branch name would mean rewriting all of a session's events. Queries
  narrow `sessions` first and join `events` to that result. `owner` and
  `archive_id` lead the events key, so an owner filter or a single session prunes by primary key.
- **The `norm` column replaces a ClickHouse `preprocessor`.** `splitByNonAlpha` splits only on
  ASCII characters that are not letters or digits, so `—` or `“` would stick to a word. A
  normalizer in TypeScript avoids that:
  `normalize("NFKD")`, then drop combining marks, then lower-case, then turn every run of
  characters that are not `\p{L}` or `\p{N}` into one space. That reproduces what FTS5's
  `unicode61 remove_diacritics 2` does. The same function tokenizes queries, so documents and
  queries cannot disagree. The cost is storing the text twice; ZSTD makes that cheap. The spike
  should also try one stored column with
  `preprocessor = replaceRegexpAll(removeDiacriticsUTF8(caseFoldUTF8(text)), '[^\\p{L}\\p{N}]+', ' ')`.
- **`tokenbf_v1` and `ngrambf_v1` are not used.** They are deprecated from 26.2 in favour of
  `text`. `multiSearchAny` matches substrings, not words, so the index can only use it as a
  hint.
- On ClickHouse Cloud the engines map to their `Shared…` forms on their own. A self-managed
  cluster with replicas would need `Replicated…` engines and `ON CLUSTER` DDL. The first version
  supports a single node or Cloud, and says so.

## Query semantics

Each record is one row of `events`, so "all words in one record" is a predicate on one row, as
in FTS5. The compiler turns the `MatchTree` into one `WHERE` expression on `norm`. Every literal
is a bound parameter (`{t1:String}` over the HTTP interface), never spliced into the SQL.

| Feature | SQLite (FTS5) | ClickHouse | Uses the text index |
|---|---|---|---|
| Words, ANDed in one record | `"a" AND "b"` | `hasAllTokens(norm, ['a','b'])` | Yes, read directly from the index |
| `"a phrase"`; a typed word that splits, such as `src/app.ts` | phrase | `hasPhrase(norm, 'src app ts')` | As a hint, then each row is checked. Positions (`support_phrase_search`) are experimental, so they are left off. |
| `a OR b` | `("a" OR "b")` | `hasAnyTokens(norm, ['a','b'])`, or `OR` of the items above | Yes |
| `-word`, `NOT word` | `NOT` | `AND NOT hasToken(norm, 'word')` | No. Applied to rows the positive terms found, as FTS5 does. |
| `word*` | `"word" *` | `norm LIKE '%word%' AND match(norm, '(^\| )word')` | As a hint: the dictionary scan for `%value%`, then a regex check. The spike measures the cost. |
| `"a phrase"*` | phrase prefix | `match(norm, '(^\| )a phrase')` with a `hasAllTokens` hint on the complete words | As a hint |
| Case and accents | `unicode61 remove_diacritics 2` | the `norm` column, from the shared normalizer | Not applicable |

`MAX_QUERY_TERMS` (32) and `MAX_QUERY_LENGTH` stay where they are and bound the size of the
generated SQL.

**Filters** apply to `sessions FINAL` (one row per session, so `FINAL` is cheap), plus time on
`events`:

- owner: `owner IN {owners}`, with aliases folded in already;
- agent: `agent = {a} OR origin_agent = {a}`;
- repo: `lower(project) = lower({r}) OR endsWith(project, concat('/', {r}))`;
- branch and source: equality;
- since and until: `coalesce(e.ts, s.updated_ms)` in the range, as today. That needs the
  session's `updated_ms` next to each event, so with a time filter `events` is joined to the
  filtered sessions (the small side on the right) instead of using an `IN` set. The epoch check
  below needs the same join, so in practice the query always joins.

**Visibility (F10.4)** works as it does today. If `viewer.everything` is false, the sessions
subquery adds `visibility = 'org' OR owner IN {own}`. `SearchService` still checks each result
against live metadata before returning it. That check is what makes a session made private or
deleted after indexing never appear, so the backend's filter only has to be fast, not
authoritative.

**Grouping and paging.** One query groups matching events by `(owner, archive_id)`, keeping only
events whose `epoch` matches the session's (see [ingest](#ingest)). From each group it takes
`hits = uniqExact(content_hash, event_index)` and `best = max(score)`. It orders by relevance or
by `updated_ms` and applies `LIMIT {limit} OFFSET {offset}`. `count() OVER ()` gives `total`.
Cursors stay plain offsets capped at `MAX_OFFSET`, as today. A second query picks the best
`matches` records per session with `ORDER BY score DESC … LIMIT {matches} BY owner, archive_id`
and returns their `text`. `excerpt()` marks each one in TypeScript: it finds the matched tokens
by their offsets in the original text and takes a window of about 24 words with the most
matches. `highlights()` reads that output, so the API's offsets are unchanged.

**Relevance.** `text`-index functions return 0 or 1; nothing scores. BM25 is a closed formula,
so it can be computed in SQL over the rows that already matched:

- `tf` per term: `countSubstrings(concat(' ', norm, ' '), concat(' ', {t}, ' '))`;
- document length: `length(norm)`, against an average kept in `meta`;
- `idf` per term: from `countIf(hasToken(norm, {t}))` and `count()`, in one small first query
  that can be cached for a minute.

FTS5 scores each record and today's code ranks a session by its best record. The ClickHouse
backend would do the same. Scores are already documented as "comparable within one answer only",
so the numbers do not need to match SQLite's. The cost grows with the number of matching rows,
not the table. A very broad query (`the`) is the bad case, so cap the rows scored, say at
50,000 by `updated_ms`, and say so in the docs. When ClickHouse ships a native top-K BM25
(`textSearch`), switch to it behind the same `sort = "relevance"`.

## Ingest

The indexer stays a reader of every owner's change feed, built on the same `Indexer` class. What
changes is what one write means.

**One writer.** For this backend the `search-index` job runs with `placement: "worker"`, not
`"every"`. API instances never write; they read `active_gen` and query. X7.3 still holds, so a
second worker by mistake is harmless:

- every write is idempotent;
- session rows are versioned by `read_at`;
- a refused continuation is planned again, exactly as now.

Two workers' `read_at` values come from different clocks. A skew can let an older read win until
the session's next change entry or the next rebuild. `seshi workers status` already warns about a
second worker.

**No transactions, so order and idempotency do the work.** `commit(page)` writes the page in a
fixed order, into the tables of the generation the page names:

1. `sessions` rows (upsert, versioned by `read_at`), after checking each continuation's `base`
   against the held traces, which the indexer already read with `sessions()`;
2. `events` rows (inserted under an `insert_deduplication_token` derived from
   `(owner, archive_id, epoch, traces)`, so a retried batch is dropped);
3. one lightweight `DELETE` for the page's replaced and removed sessions (see below);
4. `changes` rows (the feed copy);
5. `seen` rows, then the cursor.

`readThrough()` and `passDone()` write `meta` (`feed_through`, `caught_up_at`, and the
switch to a new generation) at the end of a pass. They also keep the session and event counts
there, so `state()` never counts at query time.

A crash anywhere leaves the cursor behind the content. The next run reads the same entries
again and indexes each session from its metadata as it is now, which is idempotent by design
(spec/layout.md, "Reading"). The feed copy has the same property: rows with a stamp up to
`feed_through` were all written before `feed_through` moved, so a reader that reads
`feed_through` first and the rows second sees a consistent page without a read snapshot.
Inserts are synchronous (no `async_insert`), so a run reads back what it wrote. Indexing runs
in batches of one feed page, which suits ClickHouse: one insert per table per page, not one row
at a time.

**Replace, continue, retract.**

- **Continuation** (new traces appended): insert the new traces' events with the session's
  current `epoch`, then upsert the session row with the longer `traces`. The `base` check stays.
  It reads the held `traces` from `sessions FINAL`, and with one writer it can only fail after a
  crash.
- **Replace**, including a `seshi redact backfill` with `reason: "redacted"`: give the session a
  new `epoch` (its `read_at`), insert all its events under that epoch, and upsert the session.
  Queries join on `e.epoch = s.epoch`, so the old events stop matching when the session row is
  written. They do not wait for a delete.
- **Tombstone**, or a session that stopped being admitted: upsert the session with
  `removed = 1`. It stops matching at once.

Hiding is not deletion, though. F9.7 retractions and redaction backfills exist to get text out,
so the old rows must be removed too:

- After each page, one lightweight `DELETE` covers the sessions removed or replaced in it:
  `DELETE FROM events WHERE (owner, archive_id) IN {…} AND epoch < {…}`. Use
  `lightweight_deletes_sync = 1`, and use patch parts (`lightweight_delete_mode`) where the
  server supports them. Batching matters, because each mutation has a fixed cost and ClickHouse
  advises against many small ones.
- A lightweight delete only masks rows; they leave the disk at the next merge. A daily
  `ALTER TABLE … APPLY DELETED MASK` bounds how long redacted or retracted text stays on disk.
  The operator docs should say this plainly, as `docs/search.md` already says the SQLite file
  holds session text.

**Rebuild.** `reset()` today empties the tables in place, and queries answer 503 until the index
catches up. ClickHouse instead builds the new generation beside the old one:

1. Create the `_<newgen>` tables and set `building_gen` in `meta`.
2. The worker builds the new generation from every feed's start, as a first build does. As the
   interface is sketched, `generation()` names the one being built, so the old generation stops
   being updated until the switch. Keeping both current is possible but costs a second pass
   (open question 2).
3. When the new generation has caught up, set `active_gen = newgen`, clear `building_gen`, and
   drop the old tables after a grace period (say 10 minutes) so queries already running can
   finish.

Every writer call names its generation, so a run that started against the old generation keeps
writing only the old tables. `commit()` reports `stale` once the generation is no longer the one
writes go to, and the run ends. Searches answer from the old generation the whole time.
Only a database that has never had an active generation answers `503 index_building`.

Changing `search.events`, or a new `INDEX_SCHEMA`, triggers a rebuild in the same way, as a file
mismatch wipes the SQLite index today. A different `deployment` in `meta` is an error at
start-up: the server refuses to run, and nothing is wiped. A shared remote database is not
something to wipe on a config typo, and two deployments pointed at one database would otherwise
wipe each other in turn. Each deployment gets its own database, or its own `table_prefix`.

**`seshi search --status`** with a server config: the location (URL host and database, with
credentials left out), `active_gen`, `ready_at`, `caught_up_at`, session and event counts, and,
during a rebuild, `building_gen` and how far it has read. The `search-index` job's `backlog()`
reports the same fields, so `seshi workers status` and `GET /v1/admin/jobs` show them.

**`seshi search --rebuild`** with a server config: with SQLite it rebuilds this instance's file
in-process. With ClickHouse it only *requests* a rebuild. It sets `building_gen` to a new id and
returns, and the worker does the build. A long build then survives the CLI exiting, and there is
never a second writer. `--rebuild --wait` follows `--status` until the switch. Whether the CLI
should instead be able to build in-process (with no worker running) is an open question.

## Config and deployment

```toml
[search]
enabled = true
backend = "clickhouse"          # "sqlite" (the default) or "clickhouse"
interval = "15s"
events = ["user", "assistant", "tool_call"]

[search.clickhouse]
url = "https://abc123.us-east-1.aws.clickhouse.cloud:8443"   # http(s), the HTTP interface
database = "seshi"
table_prefix = "seshi_search_"
user = "seshi_indexer"
password = { env = "SESHI_CLICKHOUSE_PASSWORD" }             # secret(): env or file, as [store]
# Optional:
read_user = "seshi_reader"                                   # API instances' credentials, if separate
read_password = { file = "/run/secrets/clickhouse-reader" }
timeout = "10s"
max_scored_rows = 50000
```

- `backend` already exists as `z.enum(["sqlite"])` in `config/src/server/search.ts`. Adding
  `"clickhouse"` and a `clickhouse` table that is required when the backend is ClickHouse is a
  small change. `path` is ignored for ClickHouse, and the config check says so.
- **Credentials** use the existing `secret()` type (`{ env }` or `{ file }`), so they never sit in
  the TOML. A separate read-only user for API instances is optional, but it is good practice: a
  leaked API instance then cannot rewrite the index. The indexer needs `CREATE TABLE`,
  `INSERT`, `ALTER DELETE` and `DROP TABLE` on the database. Readers need only `SELECT`.
- **Server-only.** `seshi serve`, `seshi search --config` and `seshi workers` use it. In
  serverless mode, laptops ignore `search.backend` and `[search.clickhouse]` in the shared config
  (`config/` in the bucket), as they already ignore `[store]` and `search.path`. The CLI's own
  `[search]` keeps `enabled` and `scope` and gets no backend option. Reasons:
  - Each laptop's index is limited to its own scope (F11.9).
  - Many laptops writing one shared index would mean many writers.
  - Every laptop would need ClickHouse write credentials.

  A team that wants one shared index wants the server. That matches serverless.md: "Needs a
  server instead: … one shared search index."
- **`seshi doctor`** with a server config checks four things: that ClickHouse is reachable, that
  the version is at least 26.2, that the user's grants are enough, and that `meta.deployment`
  matches.
- **Client library.** `@clickhouse/client-web` (fetch-based, so it works in Bun), or a thin
  `fetch` wrapper over the HTTP interface with `JSONEachRow`. The needs are small: parameterized
  queries, inserts, and DDL. The wrapper avoids a dependency, and the spike can decide.

**ClickHouse Cloud and self-hosted.**

| | ClickHouse Cloud | Self-hosted |
|---|---|---|
| Version | Current releases are past 26.2 | Require 26.3 LTS or later. `doctor` and start-up check it. |
| Engines | `SharedReplacingMergeTree` and `SharedMergeTree`, mapped automatically | Single node: plain engines. Replicated clusters are out of scope at first. |
| Reads after writes | A different replica can serve a later read. The indexer's reads (`sessions` for `base`, cursors) use `select_sequential_consistency = 1`, or the indexer keeps what it wrote this run in memory. | Not a concern on one node. |
| Idle | A service that scales to zero takes seconds to wake. The first search after idle is slow, and the job keeps it awake every `interval`. Operators who care can set a minimum. | Not applicable |
| Network | HTTPS on 8443. Allow-list the server's egress IPs. | HTTP on 8123, or HTTPS behind their own TLS |

**CI and tests.**

- A shared **backend conformance suite**: today's `sqlite.test.ts`, the relevant parts of
  `indexer.test.ts` and `service.test.ts`, and `feed.test.ts`, written once against
  `IndexStore` and run against both backends. That is what keeps "same answers" true. Tests that
  check FTS5-specific output (excerpt text, bm25 numbers) stay SQLite-only. The suite checks
  matches, order by recency, grouping, visibility, retraction, replace, the feed copy and
  rebuild.
- ClickHouse tests run only when `SESHI_TEST_CLICKHOUSE_URL` is set, as the S3 live test is
  gated on `SESSIONDB_TEST_S3_ENDPOINT`. Each run uses its own database, created and then
  dropped.
- In `.github/workflows/ci.yml`, a service next to rustfs, pinned by tag and digest in the same
  way:

  ```yaml
  services:
    clickhouse:
      image: clickhouse/clickhouse-server:26.3@sha256:<digest>
      ports: ["8123:8123"]
      env:
        CLICKHOUSE_USER: seshi
        CLICKHOUSE_PASSWORD: seshi
        CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT: "1"
  ```

  A step then runs the conformance suite with `SESHI_TEST_CLICKHOUSE_URL=http://seshi:seshi@127.0.0.1:8123`.
  Renovate (or whatever bumps the rustfs digest) bumps this one too.
- Locally, `docker run` with the same image, and a line in `docs/search.md` on running the
  suite.

## Beyond search

Traces already carry what analytics needs. `llm_calls` holds the model and token usage for each
call (`input_tokens`, `output_tokens`, the cache read and write counts, `reasoning_tokens`).
Sessions carry the owner, agent, repo, branch and source. Once ClickHouse is there, an
`llm_calls` table fed by the same pass over the feed would answer, cheaply:

- tokens and spend by person, repo, model and day;
- cache hit rates;
- the most expensive sessions;
- tool-call counts and failure rates by tool (from `events`).

Recommendation: do not shape the search tables for this, and do not build it in the first
version. Do fix two things now so it slots in later:

- Analytics tables use the same keys (`owner`, `archive_id`, `content_hash`) and the same
  epoch and retraction rules. A retracted session must disappear from spend reports too.
- The indexer's pass grows a list of "sinks", so a second table is a second sink rather than a
  second indexer.

Whether aggregates may include owner-only sessions, and for whom, is a policy question (F10.4
covers search, not totals) and is listed below.

## Risks

- **Relevance quality.** Hand-written BM25 over the matching rows is an approximation with a cap
  on rows scored. For broad queries it can rank worse than FTS5, or cost more. Native BM25 is an
  open RFC with no release date.
- **Deletion latency for sensitive text.** Retraction and redaction hide old rows at once but
  remove them from disk only when parts merge or the mask is applied. That is weaker than SQLite,
  where the delete happens inside the transaction (FTS5 pages are reused, not scrubbed, so this
  is a difference of degree, not kind). It needs stating, and a bound.
- **Prefix search cost.** `LIKE '%word%'` plus a regex is the one query feature that may scan a
  lot. If the spike shows it is too slow, options are a minimum prefix length (say 3) or a
  second `ngrams` text index on `norm`.
- **No transactions.** Correctness rests on idempotent writes and the write order above. The
  conformance suite needs crash-in-the-middle tests: a fault injected between the flushes.
- **One more service to run.** It is an operational dependency the SQLite design avoided on
  purpose (F10.3). It must stay optional, and a deployment without it must keep working exactly
  as it does now.
- **Version floor.** Text indexes made before 25.12 have to be dropped and recreated, and the
  functions were renamed in 25.10. Requiring 26.3 or later avoids the churn. Phrase positions
  stay off until they leave experimental.
- **Clock skew between two workers** (X7.3, by mistake only) can briefly let an older read of a
  session win. Accepted; the next change entry fixes it.

## Open questions

1. **Who builds on `--rebuild`?** The proposal is that the worker builds on request. Should the
   CLI also be able to build in-process when no worker runs (a cron-only deployment, X7.1)?
2. **During a rebuild, does the worker keep the old generation current, or pause it?** Keeping it
   current doubles the indexing load while the rebuild runs, and needs `IndexWriter` to offer
   both generations. Pausing it, as sketched, leaves search stale by the length of the rebuild.
3. **Is a relevance cap acceptable?** Or should `sort = "relevance"` fall back to recent order
   above some number of matches, and say so in the response?
4. **Does the normalizer move to SQLite too?** That would mean SQLite indexing `norm` with the
   `unicode61` tokenizer on top, so both backends tokenize exactly alike. It needs an
   `INDEX_SCHEMA` bump and a rebuild for existing files.
5. **Replicated self-hosted clusters:** in scope, or "Cloud or a single node" only?
6. **Analytics visibility:** may totals include owner-only sessions? For admins only, or for the
   owner's own totals?
7. **Does `GET /v1/changes/all` move to ClickHouse with search?** The proposal says yes, since it
   is `FeedState`. A deployment with search off would then have no cross-owner feed, as today.

## Phased plan

| Phase | What | Size |
|---|---|---|
| 0. Spike | One script against `clickhouse-server:26.3`. Load about 1M real-shaped events. Check `hasAllTokens`, `hasPhrase` (hint mode), the prefix pattern and the BM25 SQL. Measure p50 and p95 for 10 representative queries, and check lightweight delete with the text index. Decide on the client library and between a stored `norm` column and a preprocessor. | 2–3 days |
| 1. Seam | Replace `SearchBackend` and `FeedState` with `IndexReader` and `IndexWriter`, and move `drain()` onto `commit()`. Add `MatchTree`, `state()`, `IndexUnavailable`, the `OpenIndex` factory, `SearchStatus.location`, and `excerpt()` in `snippet.ts`. SQLite only, with no change in behaviour; the existing tests keep their assertions, with calls ported to the new interface. | 4–6 days |
| 2. Backend | `ClickHouseIndex`: DDL and meta checks, the unit-of-work flush, sessions, events and epochs, batched deletes, the `FeedState` tables, the query compiler, grouping and BM25. The conformance suite, the CI service and crash tests. | 1.5–2 weeks |
| 3. Deploy | The config schema, a `worker` placement for this backend, blue-green rebuild, `--status`, `--rebuild` and `--wait`, `doctor` checks, the delete-mask job, and docs (`docs/search.md` operator section, `docs/config.md`, F10 in `design-decisions.html`). | 1 week |
| 4. Native ranking | Switch to ClickHouse's top-K BM25 when it ships, behind the same sort. | Small, later |
| 5. Analytics | An `llm_calls` sink, then views and an API or CLI surface: a separate decision. | Medium, later |

Phase 1 is worth doing even if ClickHouse waits. It is also where semantic search (F10.5) would
plug in later: a backend that scores records some other way.
