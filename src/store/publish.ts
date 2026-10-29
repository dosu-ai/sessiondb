/** The publish protocol: write an object, verify it landed intact,
 * then swap the session's pointer and append a change entry. An object is content-addressed or
 * part-numbered, so re-publishing the same bytes is a no-op and two writers converge; the
 * pointer swap is last-writer-wins, which is harmless when both saw the same transcript and the
 * documented limitation otherwise. */

import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  CHANGE_SCHEMA,
  type ChangeEntry,
  LAYOUT_SCHEMA,
  type LayoutMarker,
  type SessionMetadata,
} from "../schemas/store";
import { keys, LAYOUT_KEY } from "./layout";
import { type Store, StoreError } from "./store";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function md5(bytes: Uint8Array): string {
  return createHash("md5").update(bytes).digest("hex");
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function gzipJson(value: unknown): Uint8Array {
  // Deterministic: mtime 0, default level. The same value always gzips to the same bytes, which
  // is what makes a re-publish a no-op.
  return new Uint8Array(gzipSync(encoder.encode(JSON.stringify(value)), { level: 6 }));
}

export function gunzipJson<T>(bytes: Uint8Array): T {
  return JSON.parse(decoder.decode(gunzipSync(bytes))) as T;
}

function encodeJson(value: unknown): Uint8Array {
  return encoder.encode(`${JSON.stringify(value, null, 2)}\n`);
}

export function decodeJson<T>(bytes: Uint8Array): T {
  return JSON.parse(decoder.decode(bytes)) as T;
}

export type PublishOutcome = "written" | "exists";

/** How an occupied key is treated. `immutable` is for content-addressed keys (a trace): the first
 * object wins, since whatever differs in a later one (timestamps, lineage) is outside the hash and
 * the first writer's view is as good as any. `replace` is for part-numbered keys (a raw part): the
 * same bytes are a no-op and different bytes replace. */
export type PublishMode = "immutable" | "replace";

/** Write `body` at `key` unless it is already there, and verify what landed: by ETag when the
 * backend reports a plain MD5 (single-part PUT on S3, R2, MinIO, and `fs`), else by reading the
 * object back and hashing it. */
export async function publishObject(
  store: Store,
  key: string,
  body: Uint8Array,
  contentType: string,
  mode: PublishMode = "immutable",
): Promise<PublishOutcome> {
  const want = md5(body);
  const before = await store.stat(key);
  if (before) {
    if (mode === "immutable") return "exists";
    if (before.size === body.length && (await matches(store, key, before.etag, want, body))) {
      return "exists";
    }
  }
  await store.put(key, body, { contentType });
  const after = await store.stat(key);
  if (
    !after ||
    after.size !== body.length ||
    !(await matches(store, key, after.etag, want, body))
  ) {
    throw new StoreError(`verification failed after writing ${key}`);
  }
  return "written";
}

async function matches(
  store: Store,
  key: string,
  etag: string | undefined,
  wantMd5: string,
  body: Uint8Array,
): Promise<boolean> {
  if (etag && /^[0-9a-f]{32}$/.test(etag)) return etag === wantMd5;
  const got = await store.get(key);
  return got !== null && sha256(got) === sha256(body);
}

/** Replace a session's pointer. Not verified beyond the write: it is small, rewritten on every
 * publish, and a reader that finds it inconsistent with the objects re-reads. */
export async function swapMetadata(store: Store, metadata: SessionMetadata): Promise<void> {
  await store.put(keys.metadata(metadata.owner, metadata.archive_id), encodeJson(metadata), {
    contentType: "application/json",
  });
}

export async function readMetadata(
  store: Store,
  owner: string,
  archive: string,
): Promise<SessionMetadata | null> {
  const bytes = await store.get(keys.metadata(owner, archive));
  return bytes === null ? null : decodeJson<SessionMetadata>(bytes);
}

export async function appendChange(
  store: Store,
  entry: Omit<ChangeEntry, "schema">,
): Promise<string> {
  const key = keys.change(
    entry.owner,
    entry.at,
    entry.kind === "tombstone" ? null : entry.content_hash,
  );
  await store.put(key, encodeJson({ schema: CHANGE_SCHEMA, ...entry }), {
    contentType: "application/json",
  });
  return key;
}

/** Write the layout marker if the prefix has none. */
export async function ensureLayout(store: Store, createdBy: string): Promise<LayoutMarker> {
  const existing = await store.get(LAYOUT_KEY);
  if (existing) return decodeJson<LayoutMarker>(existing);
  const marker: LayoutMarker = {
    schema: LAYOUT_SCHEMA,
    created_at: new Date().toISOString(),
    created_by: createdBy,
  };
  await store.put(LAYOUT_KEY, encodeJson(marker), { contentType: "application/json" });
  return marker;
}

/** The boot-time write check: PUT then GET a fixed key, so a write-only policy without Delete
 * passes. */
export async function probe(store: Store, owner: string): Promise<void> {
  const key = keys.probe(owner);
  const body = encoder.encode(`${new Date().toISOString()}\n`);
  await store.put(key, body, { contentType: "text/plain" });
  const back = await store.get(key);
  if (back === null || decoder.decode(back) !== decoder.decode(body)) {
    throw new StoreError(`probe mismatch at ${key}: wrote and read back different bytes`);
  }
}
