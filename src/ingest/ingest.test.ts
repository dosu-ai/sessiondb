import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NormalizedRecord } from "../schemas/trajectory";
import { readChanges } from "../store/changes";
import { FsStore } from "../store/fs";
import { archiveId, keys, LAYOUT_KEY } from "../store/layout";
import { planShipment, prefixSha256 } from "./continuation";
import {
  getSession,
  getTrace,
  IngestRejected,
  ingest,
  listSessions,
  putRaw,
  tombstone,
} from "./ingest";

const GOLDENS = join(import.meta.dirname, "..", "..", "testdata", "goldens");
const records = (name: string): NormalizedRecord[] =>
  JSON.parse(readFileSync(join(GOLDENS, `${name}.records.json`), "utf8"));
const expectedHash = (name: string): string =>
  JSON.parse(readFileSync(join(GOLDENS, `${name}.expected.json`), "utf8")).content_hash;

let dir: string;
let store: FsStore;
let tick = 0;
const now = () => new Date(Date.UTC(2026, 9, 21, 12, 0, tick++));
const meta = {
  session_id: "sess1",
  agent: "claude",
  project: "github.com/acme/widget",
  branch: "main",
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sessionstorage-ingest-"));
  store = new FsStore(dir);
  tick = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("ingest", () => {
  it("stores a trace, a pointer and a change entry", async () => {
    const result = await ingest({
      store,
      owner: "acme",
      records: records("claude-basic"),
      metadata: meta,
      now,
    });
    expect(result).toMatchObject({
      status: "stored",
      content_hash: expectedHash("claude-basic"),
      archive_id: archiveId("acme", "claude", "sess1"),
      records: 5,
      events: 4,
    });

    const session = await getSession(store, "acme", "claude", "sess1");
    expect(session).toMatchObject({
      schema: "sessionstorage/metadata/1",
      owner: "acme",
      status: "stored",
      head: result.content_hash,
      project: "github.com/acme/widget",
      branch: "main",
      source: "claude-code",
    });
    expect(session?.traces).toHaveLength(1);

    const trace = await getTrace(store, "acme", result.archive_id, result.content_hash);
    expect(trace).toMatchObject({
      schema: "sessionstorage/trace/1",
      content_hash: result.content_hash,
      agent: "claude",
      session_id: "sess1",
      project: "github.com/acme/widget",
    });
    expect(trace?.events).toHaveLength(4);
    expect(trace?.metadata).toMatchObject({ cwd: "/repo/app", git_branch: "main" });

    const changes = await readChanges(store, "acme");
    expect(changes.entries.map((e) => e.entry.kind)).toEqual(["published"]);
    expect(changes.entries[0]?.entry.content_hash).toBe(result.content_hash);
    expect(await store.get(LAYOUT_KEY)).not.toBeNull();
  });

  it("dedupes the same content and backfills lineage", async () => {
    await ingest({ store, owner: "acme", records: records("claude-basic"), metadata: meta, now });
    const again = await ingest({
      store,
      owner: "acme",
      records: records("claude-basic"),
      metadata: { ...meta, parent_session_id: "parent-1" },
      now,
    });
    expect(again.status).toBe("duplicate");
    const session = await getSession(store, "acme", "claude", "sess1");
    expect(session?.traces).toHaveLength(1);
    expect(session?.parent_session_id).toBe("parent-1");
    expect((await readChanges(store, "acme")).entries).toHaveLength(1);
  });

  it("keeps owners apart: the same session under two owners is two archives", async () => {
    await ingest({ store, owner: "acme", records: records("claude-basic"), metadata: meta, now });
    const other = await ingest({
      store,
      owner: "beta",
      records: records("claude-basic"),
      metadata: meta,
      now,
    });
    expect(other.status).toBe("stored");
    expect((await listSessions(store, "acme")).sessions).toHaveLength(1);
    expect((await listSessions(store, "beta")).sessions).toHaveLength(1);
  });

  it("stores a continuation as a second trace of the same session", async () => {
    // The tail must itself be a conversation (a user turn and an answer); one that is not is
    // trivial and never reaches ingest.
    const full = records("claude-queued-input");
    const shipped = { records: 6, prefix_sha256: prefixSha256(full, 6) };
    await ingest({ store, owner: "acme", records: full.slice(0, 6), metadata: meta, now });
    const plan = planShipment(full, shipped);
    expect(plan.continuation).toEqual({ from_record: 6, prefix_sha256: shipped.prefix_sha256 });
    expect(plan.records.map((r) => r.role)).toEqual([
      "meta",
      "observation",
      "user",
      "observation",
      "assistant",
    ]);
    const tail = await ingest({
      store,
      owner: "acme",
      records: plan.records,
      metadata: { ...meta, continuation: plan.continuation },
      now,
    });
    expect(tail.status).toBe("stored");
    const session = await getSession(store, "acme", "claude", "sess1");
    expect(session?.traces.map((t) => t.continuation?.from_record)).toEqual([undefined, 6]);
    expect(session?.head).toBe(tail.content_hash);
    const trace = await getTrace(store, "acme", tail.archive_id, tail.content_hash);
    expect(trace?.metadata.continuation).toEqual(plan.continuation);
  });

  it("rejects what is not a trajectory, without writing", async () => {
    await expect(
      ingest({ store, owner: "acme", records: records("reject-no-user"), metadata: meta, now }),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      ingest({ store, owner: "acme", records: [{} as NormalizedRecord], metadata: meta, now }),
    ).rejects.toBeInstanceOf(IngestRejected);
    expect(await getSession(store, "acme", "claude", "sess1")).toBeNull();
  });

  it("rejects an oversized record set", async () => {
    const many = [
      records("claude-basic")[0],
      ...Array.from({ length: 50_001 }, () => records("claude-basic")[1]),
    ];
    await expect(
      ingest({ store, owner: "acme", records: many, metadata: meta, now }),
    ).rejects.toMatchObject({
      code: "too_large",
    });
  });
});

describe("putRaw", () => {
  it("stores parts beside the trace, idempotently, and records them in the pointer", async () => {
    await ingest({ store, owner: "acme", records: records("claude-basic"), metadata: meta, now });
    const bytes = new Uint8Array(gzipSync('{"line":1}\n'));
    const first = await putRaw({
      store,
      owner: "acme",
      agent: "claude",
      session_id: "sess1",
      part: 0,
      format: "jsonl",
      bytes,
      now,
    });
    expect(first).toEqual({ status: "stored", part: 0 });
    expect(
      await putRaw({
        store,
        owner: "acme",
        agent: "claude",
        session_id: "sess1",
        part: 0,
        format: "jsonl",
        bytes,
        now,
      }),
    ).toEqual({
      status: "exists",
      part: 0,
    });
    const session = await getSession(store, "acme", "claude", "sess1");
    expect(session?.raw).toHaveLength(1);
    expect(session?.raw_format).toBe("jsonl");
    const archive = archiveId("acme", "claude", "sess1");
    expect(await store.get(keys.raw("acme", archive, 0, "jsonl"))).toEqual(bytes);
  });

  it("creates the session when the part is the first thing stored, and ingest adds the trace", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const first = await putRaw({
      store,
      owner: "acme",
      agent: "claude",
      session_id: "raw-first",
      part: 0,
      format: "jsonl",
      bytes,
      now,
    });
    expect(first).toEqual({ status: "stored", part: 0 });
    const before = await getSession(store, "acme", "claude", "raw-first");
    expect(before).toMatchObject({
      status: "stored",
      agent: "claude",
      session_id: "raw-first",
      traces: [],
      raw: [{ part: 0, format: "jsonl", size: 3 }],
    });
    expect(before?.head).toBeUndefined();
    expect(before?.source).toBeUndefined();
    expect((await readChanges(store, "acme")).entries).toEqual([]);

    // The same bytes again: nothing to do.
    expect(
      await putRaw({
        store,
        owner: "acme",
        agent: "claude",
        session_id: "raw-first",
        part: 0,
        format: "jsonl",
        bytes,
        now,
      }),
    ).toEqual({ status: "exists", part: 0 });

    const stored = await ingest({
      store,
      owner: "acme",
      records: records("claude-basic"),
      metadata: { ...meta, session_id: "raw-first" },
      now,
    });
    const after = await getSession(store, "acme", "claude", "raw-first");
    expect(after).toMatchObject({
      head: stored.content_hash,
      source: "claude-code",
      created_at: before?.created_at,
      raw: [{ part: 0 }],
    });
    expect(after?.traces).toHaveLength(1);
  });
});

describe("tombstone", () => {
  it("removes trace and raw objects, marks the session redacted, and refuses re-ingest", async () => {
    const stored = await ingest({
      store,
      owner: "acme",
      records: records("claude-basic"),
      metadata: meta,
      now,
    });
    await putRaw({
      store,
      owner: "acme",
      agent: "claude",
      session_id: "sess1",
      part: 0,
      format: "jsonl",
      bytes: new Uint8Array(gzipSync("x")),
      now,
    });
    const result = await tombstone({
      store,
      owner: "acme",
      agent: "claude",
      session_id: "sess1",
      now,
    });
    expect(result).toEqual({ removed: 2 });

    const session = await getSession(store, "acme", "claude", "sess1");
    expect(session?.status).toBe("redacted");
    expect(session?.head).toBeUndefined();
    expect(await getTrace(store, "acme", stored.archive_id, stored.content_hash)).toBeNull();
    expect(await store.get(keys.raw("acme", stored.archive_id, 0, "jsonl"))).toBeNull();

    const changes = (await readChanges(store, "acme")).entries;
    expect(changes.map((e) => e.entry.kind)).toEqual(["published", "tombstone"]);
    expect(changes[1]?.key.endsWith("-tombstone.json")).toBe(true);
    expect(changes[1]?.entry.content_hash).toBe(stored.content_hash);

    await expect(
      ingest({ store, owner: "acme", records: records("claude-basic"), metadata: meta, now }),
    ).rejects.toMatchObject({ code: "redacted" });
    expect(
      await tombstone({ store, owner: "acme", agent: "claude", session_id: "never", now }),
    ).toBeNull();
  });
});

describe("readChanges", () => {
  it("pages by cursor and by time", async () => {
    for (const name of ["claude-basic", "codex-subagent-report", "opencode-export"]) {
      await ingest({
        store,
        owner: "acme",
        records: records(name),
        metadata: { ...meta, session_id: name },
        now,
      });
    }
    const page1 = await readChanges(store, "acme", { limit: 2 });
    expect(page1.entries).toHaveLength(2);
    expect(page1.truncated).toBe(true);
    const page2 = await readChanges(store, "acme", { after: page1.cursor });
    expect(page2.entries).toHaveLength(1);
    expect(page2.truncated).toBe(false);
    const since = await readChanges(store, "acme", { since: "2026-10-21T12:00:01.000Z" });
    expect(since.entries.length).toBeLessThan(3);
    expect(since.entries.length).toBeGreaterThan(0);
  });
});
