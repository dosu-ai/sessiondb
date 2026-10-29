import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FsStore } from "./fs";
import { archiveId, changeStamp, keys } from "./layout";
import { probe, publishObject } from "./publish";
import { ObjectExistsError, StoreError } from "./store";

let dir: string;
let store: FsStore;
const enc = (s: string) => new TextEncoder().encode(s);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sessionstorage-fs-"));
  store = new FsStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("FsStore", () => {
  it("round-trips objects and reports an MD5 etag", async () => {
    await store.put("a/b/c.txt", enc("hello"));
    expect(new TextDecoder().decode((await store.get("a/b/c.txt")) as Uint8Array)).toBe("hello");
    expect(await store.stat("a/b/c.txt")).toEqual({
      size: 5,
      etag: "5d41402abc4b2a76b9719d911017c592",
    });
    expect(await store.get("a/b/missing")).toBeNull();
    expect(await store.stat("a/b/missing")).toBeNull();
  });

  it("accepts a file:// URL and refuses keys that escape the root", async () => {
    const viaUrl = new FsStore(`file://${dir}`);
    expect(viaUrl.root).toBe(store.root);
    expect(viaUrl.url.startsWith("file://")).toBe(true);
    await expect(store.put("../x", enc("x"))).rejects.toBeInstanceOf(StoreError);
    await expect(store.get("/abs")).rejects.toBeInstanceOf(StoreError);
  });

  it("honours ifNoneMatch", async () => {
    await store.put("k", enc("1"), { ifNoneMatch: true });
    await expect(store.put("k", enc("2"), { ifNoneMatch: true })).rejects.toBeInstanceOf(
      ObjectExistsError,
    );
  });

  it("lists in key order with startAfter and limit, ignoring temp files", async () => {
    for (const k of ["p/3", "p/1", "p/2", "q/1", "p/sub/x"]) await store.put(k, enc(k));
    expect((await store.list("p/")).keys).toEqual(["p/1", "p/2", "p/3", "p/sub/x"]);
    expect(await store.list("p/", { startAfter: "p/2", limit: 1 })).toEqual({
      keys: ["p/3"],
      truncated: true,
    });
    expect((await store.list("zzz/")).keys).toEqual([]);
    expect((await store.list("")).keys).toHaveLength(5);
  });

  it("deletes idempotently", async () => {
    await store.put("d", enc("x"));
    await store.delete("d");
    await store.delete("d");
    expect(await store.get("d")).toBeNull();
  });
});

describe("publishObject", () => {
  it("immutable: the first object wins", async () => {
    expect(await publishObject(store, "o", enc("same"), "text/plain")).toBe("written");
    expect(await publishObject(store, "o", enc("same"), "text/plain")).toBe("exists");
    expect(await publishObject(store, "o", enc("diff"), "text/plain")).toBe("exists");
    expect(new TextDecoder().decode((await store.get("o")) as Uint8Array)).toBe("same");
  });

  it("replace: the same bytes are a no-op, different bytes replace", async () => {
    expect(await publishObject(store, "p", enc("same"), "text/plain", "replace")).toBe("written");
    expect(await publishObject(store, "p", enc("same"), "text/plain", "replace")).toBe("exists");
    expect(await publishObject(store, "p", enc("diff"), "text/plain", "replace")).toBe("written");
    expect(new TextDecoder().decode((await store.get("p")) as Uint8Array)).toBe("diff");
  });

  it("probe writes and reads back", async () => {
    await probe(store, "acme");
    expect(await store.stat(keys.probe("acme"))).not.toBeNull();
  });
});

describe("layout", () => {
  it("derives a deterministic archive id", () => {
    expect(archiveId("acme", "claude", "s1")).toBe(archiveId("acme", "claude", "s1"));
    expect(archiveId("acme", "claude", "s1")).not.toBe(archiveId("acme", "codex", "s1"));
    expect(archiveId("acme", "claude", "s1")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("validates owners", () => {
    expect(() => keys.owner("a/b")).toThrow(StoreError);
    expect(() => keys.owner("")).toThrow(StoreError);
    expect(keys.owner("acme.dev_1")).toBe("owners/acme.dev_1");
  });

  it("makes sortable change keys", () => {
    const at = "2026-10-21T21:04:05.123Z";
    expect(changeStamp(at)).toBe("20261021T210405.123Z");
    const hash = "a".repeat(64);
    const key = keys.change("acme", at, hash);
    expect(key).toBe(`owners/acme/changes/20261021T210405.123Z-${hash}.json`);
    expect(keys.change("acme", at, null)).toBe(
      "owners/acme/changes/20261021T210405.123Z-tombstone.json",
    );
    expect(keys.change("acme", "2026-10-21T21:04:06.000Z", hash) > key).toBe(true);
  });
});
