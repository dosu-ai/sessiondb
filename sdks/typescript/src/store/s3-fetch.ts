/** S3's object API over `fetch` and SigV4, for runtimes without `Bun.S3Client` (Node). Keys
 * here are full bucket keys; `S3Store` adds its prefix. Virtual-hosted style against AWS,
 * path style against an explicit endpoint (R2, MinIO and most S3-compatible stores). */

import type { Fetch } from "../client";
import { encodeKeyPath, type SigningCredentials, sha256Hex, signRequest, uriEncode } from "./sigv4";

export interface FetchS3Options {
  bucket: string;
  region: string;
  /** `https://host[:port]`; absent for AWS, where the host is `<bucket>.s3.<region>.amazonaws.com`. */
  endpoint?: string;
  credentials: SigningCredentials;
  fetch?: Fetch;
}

/** An S3 answer that was not a success, with S3's error `Code` when the body carried one. */
export class S3HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "S3HttpError";
  }
}

const XML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decodeXml(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, entity: string) => {
    if (entity[0] === "#") {
      const code =
        entity[1] === "x" || entity[1] === "X"
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
      return Number.isNaN(code) ? whole : String.fromCodePoint(code);
    }
    return XML_ENTITIES[entity] ?? whole;
  });
}

function xmlValues(xml: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g");
  for (let m = re.exec(xml); m; m = re.exec(xml)) out.push(decodeXml(m[1] as string));
  return out;
}

export class FetchS3Client {
  private readonly fetchImpl: Fetch;

  constructor(private readonly options: FetchS3Options) {
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  }

  private url(key: string, query: Record<string, string | undefined> = {}): URL {
    const { bucket, region, endpoint } = this.options;
    const path = key ? `/${encodeKeyPath(key)}` : "/";
    const base = endpoint
      ? `${endpoint.replace(/\/+$/, "")}/${uriEncode(bucket)}${path}`
      : `https://${bucket}.s3.${region}.amazonaws.com${path}`;
    const url = new URL(base);
    for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, v);
    return url;
  }

  private async send(
    method: string,
    url: URL,
    body?: Uint8Array,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    const signed = await signRequest({
      method,
      url,
      headers,
      payloadHash: body ? await sha256Hex(body) : undefined,
      region: this.options.region,
      credentials: this.options.credentials,
    });
    return this.fetchImpl(url.toString(), {
      method,
      headers: signed,
      ...(body ? { body: body as BodyInit } : {}),
    });
  }

  private static async fail(method: string, key: string, response: Response): Promise<never> {
    const text = await response.text().catch(() => "");
    const code = xmlValues(text, "Code")[0];
    const message = xmlValues(text, "Message")[0];
    throw new S3HttpError(
      response.status,
      code,
      `${method} ${key || "/"}: ${response.status}${code ? ` ${code}` : ""}${message ? `: ${message}` : ""}`,
    );
  }

  async get(key: string): Promise<Uint8Array | null> {
    const response = await this.send("GET", this.url(key));
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) return FetchS3Client.fail("GET", key, response);
    return new Uint8Array(await response.arrayBuffer());
  }

  async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    const response = await this.send("PUT", this.url(key), body, { "content-type": contentType });
    if (!response.ok) return FetchS3Client.fail("PUT", key, response);
    await response.body?.cancel();
  }

  async head(key: string): Promise<{ size: number; etag?: string } | null> {
    const response = await this.send("HEAD", this.url(key));
    if (response.status === 404) return null;
    if (!response.ok) return FetchS3Client.fail("HEAD", key, response);
    const etag = response.headers.get("etag")?.replace(/^"|"$/g, "");
    return {
      size: Number(response.headers.get("content-length") ?? 0),
      ...(etag ? { etag } : {}),
    };
  }

  async delete(key: string): Promise<void> {
    const response = await this.send("DELETE", this.url(key));
    if (!response.ok && response.status !== 404) {
      return FetchS3Client.fail("DELETE", key, response);
    }
    await response.body?.cancel();
  }

  async list(options: {
    prefix: string;
    maxKeys: number;
    startAfter?: string;
  }): Promise<{ keys: string[]; truncated: boolean }> {
    const url = this.url("", {
      "list-type": "2",
      prefix: options.prefix,
      "max-keys": String(options.maxKeys),
      "start-after": options.startAfter,
    });
    const response = await this.send("GET", url);
    if (!response.ok) return FetchS3Client.fail("LIST", options.prefix, response);
    const xml = await response.text();
    const keys = xmlValues(xml, "Contents").flatMap((c) => xmlValues(c, "Key"));
    return { keys, truncated: xmlValues(xml, "IsTruncated")[0] === "true" };
  }
}
