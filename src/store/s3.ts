/** AWS S3 and Cloudflare R2 as a `Store`, over `Bun.S3Client` (no SDK). `s3://` and `r2://` are
 * two URL schemes over this one class; the scheme only decides how the endpoint and credentials
 * are resolved. Anything S3-compatible (MinIO, Garage) works through `s3://` with an explicit
 * `endpoint`. Requires the Bun runtime. */

import {
  type GetOptions,
  type ListOptions,
  type ListResult,
  type ObjectStat,
  type PutOptions,
  type Store,
  StoreError,
} from "./store";

export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface S3StoreOptions {
  bucket: string;
  /** Key prefix inside the bucket, no leading or trailing slash. */
  prefix?: string;
  /** AWS region (`s3://`). */
  region?: string;
  /** Cloudflare account id (`r2://`); sets the endpoint. */
  accountId?: string;
  /** Explicit endpoint for S3-compatible stores; overrides `region` / `accountId` resolution. */
  endpoint?: string;
  /** Omit to use Bun's resolution: `S3_*` / `AWS_*` environment variables. For `r2://`,
   * `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` are read here. */
  credentials?: S3Credentials;
  scheme?: "s3" | "r2";
}

/** Parse `s3://bucket/prefix` / `r2://bucket/prefix`. */
export function parseS3Url(url: string): { scheme: "s3" | "r2"; bucket: string; prefix: string } {
  const match = /^(s3|r2):\/\/([^/]+)(?:\/(.*))?$/.exec(url);
  if (!match) throw new StoreError(`not an s3:// or r2:// URL: ${url}`);
  const [, scheme, bucket, rawPrefix] = match;
  const prefix = (rawPrefix ?? "").replace(/^\/+|\/+$/g, "");
  return { scheme: scheme as "s3" | "r2", bucket: bucket as string, prefix };
}

function isNotFound(err: unknown): boolean {
  const e = err as { code?: string; name?: string } | null;
  return e?.code === "NoSuchKey" || e?.code === "ERR_S3_FILE_NOT_FOUND" || e?.name === "S3Error";
}

export class S3Store implements Store {
  readonly url: string;
  readonly bucket: string;
  readonly prefix: string;
  private readonly client: Bun.S3Client;

  constructor(options: S3StoreOptions) {
    const scheme = options.scheme ?? (options.accountId ? "r2" : "s3");
    this.bucket = options.bucket;
    this.prefix = (options.prefix ?? "").replace(/^\/+|\/+$/g, "");
    this.url = `${scheme}://${this.bucket}${this.prefix ? `/${this.prefix}` : ""}`;

    const credentials = options.credentials ?? (scheme === "r2" ? r2CredentialsFromEnv() : {});
    const endpoint =
      options.endpoint ??
      (scheme === "r2" && options.accountId
        ? `https://${options.accountId}.r2.cloudflarestorage.com`
        : undefined);
    this.client = new Bun.S3Client({
      bucket: this.bucket,
      region: options.region,
      endpoint,
      // R2 and most S3-compatible stores want path-style; AWS virtual-hosted.
      virtualHostedStyle: endpoint === undefined,
      ...credentials,
    });
  }

  /** The store from a `s3://` / `r2://` URL plus the per-scheme extras. */
  static fromUrl(
    url: string,
    options: Omit<S3StoreOptions, "bucket" | "prefix" | "scheme"> = {},
  ): S3Store {
    const { scheme, bucket, prefix } = parseS3Url(url);
    return new S3Store({ ...options, scheme, bucket, prefix });
  }

  private keyOf(key: string): string {
    return this.prefix ? `${this.prefix}/${key}` : key;
  }

  async get(key: string, options: GetOptions = {}): Promise<Uint8Array | null> {
    const { range } = options;
    try {
      const file = this.client.file(this.keyOf(key));
      if (!(await file.exists())) return null;
      if (!range) return new Uint8Array(await file.arrayBuffer());
      // A `Range` past the end is a 416 on S3; what fits is read instead.
      const size = (await file.stat()).size;
      const start = Math.min(range.start, size);
      const end = Math.min(range.end ?? size, size);
      if (end <= start) return new Uint8Array(0);
      return new Uint8Array(await file.slice(start, end).arrayBuffer());
    } catch (err) {
      if (isNotFound(err)) return null;
      throw new StoreError(`read ${key}`, err);
    }
  }

  async put(key: string, body: Uint8Array, options: PutOptions = {}): Promise<void> {
    try {
      await this.client.write(this.keyOf(key), body, {
        type: options.contentType ?? "application/octet-stream",
      });
    } catch (err) {
      throw new StoreError(`write ${key}`, err);
    }
  }

  async stat(key: string): Promise<ObjectStat | null> {
    try {
      const info = await this.client.stat(this.keyOf(key));
      return { size: info.size, etag: info.etag.replace(/^"|"$/g, "") };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw new StoreError(`stat ${key}`, err);
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.delete(this.keyOf(key));
    } catch (err) {
      if (!isNotFound(err)) throw new StoreError(`delete ${key}`, err);
    }
  }

  async list(prefix: string, options: ListOptions = {}): Promise<ListResult> {
    try {
      const response = await this.client.list({
        prefix: this.keyOf(prefix),
        maxKeys: options.limit ?? 1000,
        startAfter: options.startAfter === undefined ? undefined : this.keyOf(options.startAfter),
      });
      const strip = this.prefix ? this.prefix.length + 1 : 0;
      return {
        keys: (response.contents ?? []).map((o) => o.key.slice(strip)),
        truncated: response.isTruncated ?? false,
      };
    } catch (err) {
      throw new StoreError(`list ${prefix}`, err);
    }
  }
}

function r2CredentialsFromEnv(): Partial<S3Credentials> {
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  return accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : {};
}
