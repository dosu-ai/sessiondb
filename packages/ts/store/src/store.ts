import { StoreError } from "@seshi/model";
import { BucketHttpError } from "./http-error";

export interface ObjectStat {
  size: number;
  /** The object's ETag, unquoted, as the backend reports it. For a single-part PUT on S3, R2
   * and MinIO this is the MD5 of the body in hex, and the folder store uses the same MD5, which
   * `publish` uses to verify without reading the object back. Absent only when a backend
   * reports none. */
  etag?: string;
  /** When the object was last written, ISO 8601 (S3's `Last-Modified`, the file's mtime).
   * Absent when the backend does not say. */
  modified?: string;
}

export interface StoredObject {
  body: Uint8Array;
  /** Unquoted. */
  etag: string;
}

export interface PutOptions {
  contentType?: string;
  /** Write only if the object's current ETag is this one (unquoted). Fails with
   * `PreconditionFailed` when the object changed or is gone. */
  ifMatch?: string;
  /** `"*"`: write only if no object is at the key. Fails with `PreconditionFailed` when one
   * is. */
  ifNoneMatch?: "*";
}

export interface PutResult {
  /** The new object's ETag (unquoted), when the backend reports it. */
  etag?: string;
}

export interface DeleteOptions {
  /** Delete only if the object's current ETag is this one; `PreconditionFailed` otherwise. A
   * missing object is not an error, as for an unconditional delete. */
  ifMatch?: string;
}

export interface ListOptions {
  /** Keys lexicographically after this one (exclusive), as S3's `StartAfter`. */
  startAfter?: string;
  limit?: number;
  /** Also say when each object was last written (`objects`): S3's `LastModified`, a file's
   * mtime. The folder store reads each listed file's mtime for it, so ask only when needed. */
  details?: boolean;
}

export interface ListedKey {
  key: string;
  /** When the object was last written, ISO 8601, as the backend reports it (S3's
   * `LastModified`, the file's mtime). Absent when the backend does not say, or the object went
   * between the listing and the look. */
  modified?: string;
  size?: number;
  /** The object's ETag, when the listing says (S3 does; the folder store does not). */
  etag?: string;
}

export interface ListResult {
  keys: string[];
  truncated: boolean;
  /** With `details`: each of `keys`, in the same order, with its last change. */
  objects?: ListedKey[];
}

export interface Store {
  readonly url: string;
  /** The object and its ETag, or null when there is none. */
  get(key: string): Promise<StoredObject | null>;
  put(key: string, body: Uint8Array, options?: PutOptions): Promise<PutResult>;
  stat(key: string): Promise<ObjectStat | null>;
  delete(key: string, options?: DeleteOptions): Promise<void>;
  /** Keys under `prefix`, in lexicographic order. */
  list(prefix: string, options?: ListOptions): Promise<ListResult>;
}

export { StoreError };

/** A conditional write or delete whose condition did not hold: the object changed since it was
 * read (`ifMatch`), or one already exists (`ifNoneMatch: "*"`). Re-read and try again, or give
 * up (a second worker's checkpoint write, X7.3). */
export class PreconditionFailed extends StoreError {
  readonly key: string;
  constructor(key: string, detail: string) {
    super(`precondition failed for ${key}: ${detail}`);
    this.name = "PreconditionFailed";
    this.key = key;
  }
}

export function isPreconditionFailed(err: unknown): err is PreconditionFailed {
  return err instanceof PreconditionFailed;
}

/** The bucket refused the request (S3's `403 AccessDenied`): the key in use may not do this
 * to this object. In serverless mode the bucket's permissions are the only roles (F11.4), so
 * this is how "not allowed" arrives. */
export class AccessDenied extends StoreError {
  constructor(
    readonly operation: "read" | "write" | "stat" | "delete" | "list",
    readonly key: string,
    cause?: unknown,
  ) {
    // The service's reason, when it gave one: a key that is wrong (Azure's AuthenticationFailed,
    // S3's SignatureDoesNotMatch) reads differently from one that may not do this.
    const code = cause instanceof BucketHttpError ? cause.code : undefined;
    super(`${operation} ${key || "/"}: access denied${code ? ` (${code})` : ""}`, cause);
    this.name = "AccessDenied";
  }
}

/** A store operation that failed for a reason other than a refusal, saying what failed and why
 * (`read seshi.json: GET c/seshi.json: 404 ContainerNotFound: …`, `list owners/: Unable to
 * connect`): callers print the message, not the cause. */
export function storeFailure(what: string, cause: unknown): StoreError {
  const why = cause instanceof Error ? cause.message : cause === undefined ? "" : String(cause);
  return new StoreError(why ? `${what}: ${why}` : what, cause);
}

/** The `AccessDenied` behind `err`, following `cause`s; undefined when there is none. */
export function accessDeniedIn(err: unknown): AccessDenied | undefined {
  for (let at: unknown = err, depth = 0; at instanceof Error && depth < 8; depth++) {
    if (at instanceof AccessDenied) return at;
    at = (at as { cause?: unknown }).cause;
  }
  return undefined;
}

export async function getBytes(store: Store, key: string): Promise<Uint8Array | null> {
  return (await store.get(key))?.body ?? null;
}

/** What an `updateObject` step decides: the new bytes, or `null` to leave the object as it is
 * (nothing to change). */
export type UpdateStep = (current: StoredObject | null) => Uint8Array | null;

export interface UpdateOptions {
  contentType?: string;
  /** How many times to re-read and retry after a `PreconditionFailed`; default 8. */
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface UpdateResult {
  written: boolean;
  /** The object as it now stands: what was written, or what `step` left alone (null when
   * there is none). */
  current: StoredObject | null;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Read-modify-write with retry (X6.5): read the object, let `step` compute the next version
 * from it, and write that with `ifMatch` (or `ifNoneMatch: "*"` when there was none). When
 * another writer got there first the write fails with 412; the loop reads again and asks
 * `step` again, so `step` must be a pure function of what it is given. Throws the last
 * `PreconditionFailed` once `retries` are spent. */
export async function updateObject(
  store: Store,
  key: string,
  step: UpdateStep,
  options: UpdateOptions = {},
): Promise<UpdateResult> {
  const retries = options.retries ?? 8;
  const sleep = options.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt++) {
    const current = await store.get(key);
    const next = step(current);
    if (next === null) return { written: false, current };
    try {
      const put = await store.put(key, next, {
        contentType: options.contentType,
        ...(current ? { ifMatch: current.etag } : { ifNoneMatch: "*" }),
      });
      return { written: true, current: { body: next, etag: put.etag ?? "" } };
    } catch (err) {
      if (!isPreconditionFailed(err) || attempt >= retries) throw err;
      await sleep(Math.min(200, 5 * 2 ** attempt) * (0.5 + Math.random()));
    }
  }
}

/** Each object under `prefix`, by its name there, with its ETag when the listing says (S3,
 * GCS and Azure do; the folder store does not, so callers `stat` for it). */
export async function listNamed(
  store: Store,
  prefix: string,
  keep: (name: string) => boolean = () => true,
): Promise<{ name: string; etag?: string }[]> {
  const out: { name: string; etag?: string }[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await store.list(prefix, { startAfter: after, details: true });
    const objects = page.objects ?? page.keys.map((key) => ({ key, etag: undefined }));
    for (const { key, etag } of objects) {
      const name = key.slice(prefix.length);
      if (keep(name)) out.push({ name, ...(etag ? { etag } : {}) });
    }
    after = page.keys.at(-1);
    if (!page.truncated || after === undefined) return out;
  }
}
