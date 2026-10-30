/** Runs only against a real S3-compatible endpoint, given by environment:
 *
 *   SESSIONDB_TEST_S3_ENDPOINT=http://127.0.0.1:9000
 *   SESSIONDB_TEST_S3_BUCKET=sessionstorage-test
 *   SESSIONDB_TEST_S3_ACCESS_KEY / SESSIONDB_TEST_S3_SECRET_KEY
 *
 * The bucket must exist. MinIO, RustFS, Garage, R2 and AWS all qualify. */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getSession, getTrace, ingest, tombstone } from "../ingest/ingest";
import { readChanges } from "./changes";
import { parseS3Url, S3Store } from "./s3";

const endpoint = process.env.SESSIONDB_TEST_S3_ENDPOINT;
const bucket = process.env.SESSIONDB_TEST_S3_BUCKET;
const accessKeyId = process.env.SESSIONDB_TEST_S3_ACCESS_KEY;
const secretAccessKey = process.env.SESSIONDB_TEST_S3_SECRET_KEY;
// `Bun.S3Client` needs the Bun runtime: `bun --bun vitest run src/store/s3.test.ts`.
const configured =
  Boolean(endpoint && bucket && accessKeyId && secretAccessKey) && typeof Bun !== "undefined";

const GOLDENS = join(import.meta.dirname, "..", "..", "..", "..", "spec", "testdata", "goldens");
const records = JSON.parse(readFileSync(join(GOLDENS, "claude-basic.records.json"), "utf8"));

describe("parseS3Url", () => {
  it("splits scheme, bucket and prefix", () => {
    expect(parseS3Url("s3://b/p/q/")).toEqual({ scheme: "s3", bucket: "b", prefix: "p/q" });
    expect(parseS3Url("r2://b")).toEqual({ scheme: "r2", bucket: "b", prefix: "" });
    expect(() => parseS3Url("gs://b")).toThrow();
  });
});

describe.skipIf(!configured)("S3Store against a live endpoint", () => {
  const prefix = `test-${Date.now().toString(36)}`;
  const store = () =>
    S3Store.fromUrl(`s3://${bucket}/${prefix}`, {
      endpoint,
      credentials: {
        accessKeyId: accessKeyId as string,
        secretAccessKey: secretAccessKey as string,
      },
    });

  it("round-trips objects, stats with an MD5 etag, lists and deletes", async () => {
    const s = store();
    const body = new TextEncoder().encode("hello");
    await s.put("a/b.txt", body, { contentType: "text/plain" });
    expect(await s.get("a/b.txt")).toEqual(body);
    expect(await s.stat("a/b.txt")).toEqual({ size: 5, etag: "5d41402abc4b2a76b9719d911017c592" });
    expect(await s.get("a/missing")).toBeNull();
    expect(await s.stat("a/missing")).toBeNull();
    await s.put("a/c.txt", body);
    expect((await s.list("a/")).keys).toEqual(["a/b.txt", "a/c.txt"]);
    expect((await s.list("a/", { startAfter: "a/b.txt" })).keys).toEqual(["a/c.txt"]);
    await s.delete("a/b.txt");
    await s.delete("a/b.txt");
    expect(await s.get("a/b.txt")).toBeNull();
  });

  it("ingests, dedupes, tails the change feed and tombstones", async () => {
    const s = store();
    const meta = { session_id: "s3-sess", agent: "claude", project: "github.com/acme/widget" };
    const first = await ingest({ store: s, owner: "acme", records, metadata: meta });
    expect(first.status).toBe("stored");
    const again = await ingest({ store: s, owner: "acme", records, metadata: meta });
    expect(again.status).toBe("duplicate");
    expect(await getTrace(s, "acme", first.archive_id, first.content_hash)).toMatchObject({
      content_hash: first.content_hash,
    });
    expect((await readChanges(s, "acme")).entries.map((e) => e.entry.kind)).toEqual(["published"]);
    expect(
      await tombstone({ store: s, owner: "acme", agent: "claude", session_id: "s3-sess" }),
    ).toEqual({
      removed: 1,
    });
    expect((await getSession(s, "acme", "claude", "s3-sess"))?.status).toBe("redacted");
  });
});
