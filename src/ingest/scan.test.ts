import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readChanges } from "../store/changes";
import { FsStore } from "../store/fs";
import { archiveId } from "../store/layout";
import { readMetadata } from "../store/publish";
import { getTrace } from "./ingest";
import { createScanner, type ScanReport } from "./scan";

const fixture = (name: string) =>
  readFileSync(join(import.meta.dirname, "..", "..", "testdata", "transcripts", name), "utf8");

/** The daemon's finished stream, with an answer long enough to be worth storing. */
const STREAM = fixture("datadog-claude-session.datadog-trajectory.jsonl").replace(
  '"text":"The subagent found no TODOs."',
  `"text":${JSON.stringify(`No TODOs. ${"More detail. ".repeat(200)}`)}`,
);
const STREAM_SESSION = "0d6f1c2e-7b1a-4c3e-9f2d-5a8b7c6d4e3f";
const LIVE = STREAM.split("\n")
  .filter((line) => !line.includes('"session_end"'))
  .join("\n");
const BACKFILLED = fixture("datadog-backfilled-session.datadog-trajectory.jsonl");

/** Where `aws s3 sync ~/.trajectory s3://…/owners/alice/.trajectory` puts a session. */
const synced = (owner: string, date: string, id: string) =>
  `owners/${owner}/.trajectory/trajectories/sessions/${date}/session-${id}.jsonl`;

let dir: string;
let store: FsStore;
const put = (key: string, body: string) => store.put(key, new TextEncoder().encode(body));

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
      live: 0,
      rejected: 0,
    });
    expect(reports).toEqual([
      { owner: "alice", key, outcome: "stored", session_id: STREAM_SESSION },
    ]);

    const archive = archiveId("alice", "datadog-trajectory", STREAM_SESSION);
    const metadata = await readMetadata(store, "alice", archive);
    expect(metadata).toMatchObject({
      agent: "datadog-trajectory",
      source: "datadog-trajectory:claude-code",
      status: "stored",
      raw: [{ part: 0, format: "jsonl" }],
    });
    const trace = await getTrace(store, "alice", archive, metadata?.head ?? "");
    expect(JSON.stringify(trace)).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz012345");
    expect(await store.get(key)).not.toBeNull();
  });

  it("reads an unchanged file once, and a rewritten one again", async () => {
    const key = synced("alice", "2026-10-29", STREAM_SESSION);
    await put(key, LIVE);
    const scanner = createScanner({ store, owners: ["alice"] });
    expect(await scanner.scan()).toMatchObject({ read: 1, live: 1, stored: 0 });
    // Nothing changed: not even read.
    expect(await scanner.scan()).toMatchObject({ read: 0 });

    // The session ended and the next sync rewrote the file.
    await put(key, STREAM);
    expect(await scanner.scan()).toMatchObject({ read: 1, stored: 1 });
    expect(await scanner.scan()).toMatchObject({ read: 0 });
    expect((await readChanges(store, "alice")).entries).toHaveLength(1);
  });

  it("writes nothing new after a restart", async () => {
    await put(synced("alice", "2026-10-29", STREAM_SESSION), STREAM);
    await createScanner({ store, owners: ["alice"] }).scan();
    // A fresh process has no memory of the file and reads it again; the content dedupes.
    const fresh = createScanner({ store, owners: ["alice"] });
    expect(await fresh.scan()).toMatchObject({ read: 1, duplicate: 1, stored: 0 });
    expect((await readChanges(store, "alice")).entries).toHaveLength(1);
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
    expect(await scanner.scan()).toMatchObject({ read: 2, trivial: 1, rejected: 1 });
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
