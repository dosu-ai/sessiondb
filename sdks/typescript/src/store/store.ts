/** The storage interface the server writes through. Keys are relative to the
 * store's root (a directory, or a bucket prefix) and use `/`. Two implementations: `fs` and
 * `s3` (AWS S3 and Cloudflare R2, plus anything S3-compatible with an explicit endpoint). */

export interface ObjectStat {
  size: number;
  /** The object's ETag as the backend reports it, when it does. For a single-part PUT on S3, R2
   * and MinIO this is the MD5 of the body in hex, which `publish` uses to verify without reading
   * the object back. */
  etag?: string;
}

export interface PutOptions {
  contentType?: string;
}

export interface ListOptions {
  /** Keys lexicographically after this one (exclusive), as S3's `StartAfter`. */
  startAfter?: string;
  limit?: number;
}

export interface ListResult {
  keys: string[];
  truncated: boolean;
}

export interface Store {
  /** `file:///…`, `s3://bucket/prefix`, `r2://bucket/prefix`. */
  readonly url: string;
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, body: Uint8Array, options?: PutOptions): Promise<void>;
  stat(key: string): Promise<ObjectStat | null>;
  delete(key: string): Promise<void>;
  /** Keys under `prefix`, in lexicographic order. */
  list(prefix: string, options?: ListOptions): Promise<ListResult>;
}

export class StoreError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "StoreError";
  }
}
