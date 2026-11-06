/** AWS Signature Version 4 for S3 requests, over Web Crypto, so the fetch-based S3 client runs
 * on Node and Bun alike with no AWS SDK. Only what an S3 call needs: the payload hash is sent
 * as `x-amz-content-sha256`, and every header passed in is signed. */

const encoder = new TextEncoder();

export interface SigningCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface SignInput {
  method: string;
  url: URL;
  /** Headers to send and sign, beyond the `x-amz-*` ones added here; names are lowercased. */
  headers?: Record<string, string>;
  /** Hex SHA-256 of the body (`sha256Hex`); the empty body's hash when absent. */
  payloadHash?: string;
  region: string;
  credentials: SigningCredentials;
  /** The signing time; now by default. */
  date?: Date;
}

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(body: Uint8Array | string): Promise<string> {
  const bytes = typeof body === "string" ? encoder.encode(body) : body;
  return hex(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
}

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", k, encoder.encode(data));
}

/** RFC 3986 encoding, as SigV4 wants it: everything but `A-Za-z0-9-._~`. */
export function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** An object key as a URL path: each segment encoded, the slashes kept. */
export function encodeKeyPath(key: string): string {
  return key.split("/").map(uriEncode).join("/");
}

function canonicalQuery(url: URL): string {
  return [...url.searchParams]
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

function amzDate(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

/** The headers to send: the caller's, `x-amz-date`, `x-amz-content-sha256`, the session token
 * when there is one, and `authorization`. `host` is signed but left for fetch to send. */
export async function signRequest(input: SignInput): Promise<Record<string, string>> {
  const date = amzDate(input.date ?? new Date());
  const day = date.slice(0, 8);
  const payloadHash = input.payloadHash ?? EMPTY_SHA256;
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    headers[name.toLowerCase()] = value;
  }
  headers["x-amz-date"] = date;
  headers["x-amz-content-sha256"] = payloadHash;
  if (input.credentials.sessionToken) {
    headers["x-amz-security-token"] = input.credentials.sessionToken;
  }

  const signed = { host: input.url.host, ...headers };
  const names = Object.keys(signed).sort();
  const signedHeaders = names.join(";");
  const canonicalHeaders = names
    .map(
      (n) =>
        `${n}:${String(signed[n as keyof typeof signed])
          .trim()
          .replace(/\s+/g, " ")}\n`,
    )
    .join("");
  const canonicalRequest = [
    input.method,
    input.url.pathname,
    canonicalQuery(input.url),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${day}/${input.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", date, scope, await sha256Hex(canonicalRequest)].join(
    "\n",
  );

  let key: ArrayBuffer = await hmac(
    encoder.encode(`AWS4${input.credentials.secretAccessKey}`),
    day,
  );
  key = await hmac(key, input.region);
  key = await hmac(key, "s3");
  key = await hmac(key, "aws4_request");
  const signature = hex(await hmac(key, stringToSign));

  headers.authorization = `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return headers;
}
