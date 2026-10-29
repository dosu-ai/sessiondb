import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizeTranscript } from "../normalize";
import { readChanges } from "../store/changes";
import { FsStore } from "../store/fs";
import { archiveId } from "../store/layout";
import { readMetadata } from "../store/publish";
import { getTrace } from "./ingest";
import { createScanner, type ScanReport } from "./scan";

const fixture = (name: string) =>
  readFileSync(join(import.meta.dirname, "..", "..", "testdata", "transcripts", name), "utf8");

/** The daemon's finished stream, with answers long enough to be worth storing. */
const STREAM = fixture("datadog-claude-session.datadog-trajectory.jsonl")
  .replace(
    '"text":"Auth reads KEY;',
    `"text":${JSON.stringify(`Auth reads KEY. ${"More detail. ".repeat(200)}`).slice(0, -1)}`,
  )
  .replace(
    '"text":"The subagent found no TODOs."',
    `"text":${JSON.stringify(`No TODOs. ${"More detail. ".repeat(200)}`)}`,
  );
const STREAM_SESSION = "0d6f1c2e-7b1a-4c3e-9f2d-5a8b7c6d4e3f";
const LINES = STREAM.split("\n").filter((line) => line !== "");
/** The stream as the daemon's file holds it at a moment: its first `count` events. */
const upTo = (count: number) => `${LINES.slice(0, count).join("\n")}\n`;
/** Through the first turn's answer (`agent_message`, `turn_end`). */
const FIRST_TURN = upTo(9);
const BACKFILLED = fixture("datadog-backfilled-session.datadog-trajectory.jsonl");

/** Where `aws s3 sync ~/.trajectory s3://…/owners/alice/.trajectory` puts a session. */
const synced = (owner: string, date: string, id: string) =>
  `owners/${owner}/.trajectory/trajectories/sessions/${date}/session-${id}.jsonl`;
const ARCHIVE = archiveId("alice", "datadog-trajectory", STREAM_SESSION);

let dir: string;
let store: FsStore;
const put = (key: string, body: string) => store.put(key, new TextEncoder().encode(body));

/** Every record of the session as its traces hold them: the head's, then each continuation's
 * past its meta record. */
async function stitched(owner: string, archive: string) {
  const metadata = await readMetadata(store, owner, archive);
  const records = [];
  for (const ref of metadata?.traces ?? []) {
    const trace = await getTrace(store, owner, archive, ref.content_hash);
    records.push(...(trace?.records ?? []).slice(ref.continuation ? 1 : 0));
  }
  return records;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sessiondb-scan-"));
  store = new FsStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("scan", () => {
  it("stores a finished stream it finds in an owner's folder, and leaves the file there", async () => {
    const key = synced("alice", "2026-10-29", STREAM_SESSION);
    await put(key, STREAM);
    // What else the sync brings along: not transcripts.
    await put(
      `owners/alice/.trajectory/trajectories/materialized/2026-10-29/session-${STREAM_SESSION}.json`,
      '{"turns":[]}',
    );
    await put("owners/alice/.trajectory/logs/trajectory-serve.log", "noise\n");

    const reports: ScanReport[] = [];
    const scanner = createScanner({ store, owners: ["alice"], onFile: (r) => reports.push(r) });
    expect(await scanner.scan()).toEqual({
      read: 1,
      stored: 1,
      duplicate: 0,
      trivial: 0,
      rejected: 0,
    });
    expect(reports).toEqual([
      { owner: "alice", key, outcome: "stored", session_id: STREAM_SESSION },
    ]);

    const metadata = await readMetadata(store, "alice", ARCHIVE);
    expect(metadata).toMatchObject({
      agent: "datadog-trajectory",
      source: "datadog-trajectory:claude-code",
      status: "stored",
      raw: [{ part: 0, format: "jsonl", offset: 0, length: Buffer.byteLength(STREAM) }],
      normalized: { bytes: Buffer.byteLength(STREAM) },
    });
    const trace = await getTrace(store, "alice", ARCHIVE, metadata?.head ?? "");
    expect(JSON.stringify(trace)).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz012345");
    expect(await store.get(key)).not.toBeNull();
  });

  it("ships a running session as it grows, reading only what grew", async () => {
    const key = synced("alice", "2026-10-29", STREAM_SESSION);
    await put(key, FIRST_TURN);
    const scanner = createScanner({ store, owners: ["alice"] });
    expect(await scanner.scan()).toMatchObject({ read: 1, stored: 1 });
    // Nothing changed: not even read.
    expect(await scanner.scan()).toMatchObject({ read: 0 });

    // The next sync brings the second turn, and the next the session's end.
    await put(key, upTo(16));
    expect(await scanner.scan()).toMatchObject({ read: 1, stored: 1 });
    await put(key, STREAM);
    expect(await scanner.scan()).toMatchObject({ read: 1, trivial: 1 });
    expect(await scanner.scan()).toMatchObject({ read: 0 });

    // Each sync's growth is its own raw part, and the second turn shipped as a continuation.
    const metadata = await readMetadata(store, "alice", ARCHIVE);
    expect(metadata?.raw).toMatchObject([
      { part: 0, offset: 0, length: Buffer.byteLength(FIRST_TURN) },
      { part: 1, offset: Buffer.byteLength(FIRST_TURN) },
      { part: 2, offset: Buffer.byteLength(upTo(16)) },
    ]);
    expect(metadata?.normalized?.bytes).toBe(Buffer.byteLength(STREAM));
    const { entries } = await readChanges(store, "alice");
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.entry.continuation !== undefined).sort()).toEqual([false, true]);

    // Together, the traces hold exactly what the whole stream normalizes to.
    const whole = normalizeTranscript({ source: "datadog-trajectory", transcript: STREAM });
    expect(await stitched("alice", ARCHIVE)).toEqual(whole.records);
    expect(metadata?.normalized?.records).toBe(whole.records.length);
  });

  it("holds a session's first chunks until there is a conversation worth a trace", async () => {
    const key = synced("alice", "2026-10-29", STREAM_SESSION);
    // Through the user's first prompt: nothing answers it yet.
    await put(key, upTo(3));
    const scanner = createScanner({ store, owners: ["alice"] });
    expect(await scanner.scan()).toMatchObject({ read: 1, trivial: 1 });
    expect((await readMetadata(store, "alice", ARCHIVE))?.head).toBeUndefined();

    // The answer arrives: the chunks so far are normalized together, as the whole log.
    await put(key, FIRST_TURN);
    expect(await scanner.scan()).toMatchObject({ read: 1, stored: 1 });
    const metadata = await readMetadata(store, "alice", ARCHIVE);
    expect(metadata?.raw).toHaveLength(2);
    expect(metadata?.traces).toHaveLength(1);
    expect(metadata?.traces[0].continuation).toBeUndefined();
    const whole = normalizeTranscript({ source: "datadog-trajectory", transcript: FIRST_TURN });
    expect(await stitched("alice", ARCHIVE)).toEqual(whole.records);
  });

  it("reads a file that shrank whole again", async () => {
    const key = synced("alice", "2026-10-29", STREAM_SESSION);
    await put(key, STREAM);
    const scanner = createScanner({ store, owners: ["alice"] });
    expect(await scanner.scan()).toMatchObject({ read: 1, stored: 1 });

    await put(key, FIRST_TURN);
    expect(await scanner.scan()).toMatchObject({ read: 1 });
    const metadata = await readMetadata(store, "alice", ARCHIVE);
    expect(metadata?.raw).toMatchObject([
      { part: 0, offset: 0, length: Buffer.byteLength(FIRST_TURN) },
    ]);
    expect(metadata?.normalized?.bytes).toBe(Buffer.byteLength(FIRST_TURN));
  });

  it("picks up where the archive says after a restart", async () => {
    const key = synced("alice", "2026-10-29", STREAM_SESSION);
    await put(key, FIRST_TURN);
    await createScanner({ store, owners: ["alice"] }).scan();
    // A fresh process has no memory of the file; the archive says it was read to its end.
    const fresh = createScanner({ store, owners: ["alice"] });
    expect(await fresh.scan()).toMatchObject({ read: 0 });
    // And when it grew meanwhile, only the growth is read.
    await put(key, STREAM);
    expect(await fresh.scan()).toMatchObject({ read: 1, stored: 1 });
    expect((await readChanges(store, "alice")).entries).toHaveLength(2);
  });

  it("scans only the owners it is given, and files each under their own folder", async () => {
    await put(synced("alice", "2026-10-29", STREAM_SESSION), STREAM);
    await put(synced("bob", "2026-10-29", STREAM_SESSION), STREAM);
    await put(synced("carol", "2026-10-29", STREAM_SESSION), STREAM);
    const scanner = createScanner({ store, owners: ["alice", "bob"] });
    expect(await scanner.scan()).toMatchObject({ stored: 2 });
    expect(
      await readMetadata(store, "bob", archiveId("bob", "datadog-trajectory", STREAM_SESSION)),
    ).not.toBeNull();
    expect(
      await readMetadata(store, "carol", archiveId("carol", "datadog-trajectory", STREAM_SESSION)),
    ).toBeNull();
  });

  it("calls a backfilled session with no conversation trivial, and a non-stream rejected", async () => {
    await put(synced("alice", "2026-09-01", "0f9c1a2b"), BACKFILLED);
    await put(synced("alice", "2026-09-02", "junk"), '{"hello":"world"}\n');
    const reports: ScanReport[] = [];
    const scanner = createScanner({ store, owners: ["alice"], onFile: (r) => reports.push(r) });
    expect(await scanner.scan()).toMatchObject({ read: 1, trivial: 1, rejected: 1 });
    expect(reports.find((r) => r.key.includes("junk"))).toMatchObject({
      outcome: "rejected",
      detail: "normalize_missing_session_start",
    });
    // Neither is read again until it changes.
    expect(await scanner.scan()).toMatchObject({ read: 0 });
  });

  it("does not mistake the archive's own objects for streams", async () => {
    await put(synced("alice", "2026-10-29", STREAM_SESSION), STREAM);
    const scanner = createScanner({ store, owners: ["alice"] });
    await scanner.scan();
    const keys = (await store.list("owners/alice/sessions/")).keys;
    expect(keys.length).toBeGreaterThan(0);
    expect(await scanner.scan()).toMatchObject({ read: 0 });
  });
});
