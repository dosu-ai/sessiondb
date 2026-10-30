/** The HTTP surface: one `fetch(Request) → Response` the tests call directly and `main.ts`
 * serves. One bucket, one token list, both from the environment. Each token names a person,
 * and that person's sessions live under `owners/<name>/`: a token writes there and reads only
 * there, so teammates never see each other's transcripts. A client with a token posts raw
 * transcripts; the server stores them redacted, normalizes them and writes the traces to the
 * bucket in the layout, so the laptop never holds a bucket credential and the bucket never
 * holds an unredacted byte. */

import { timingSafeEqual } from "node:crypto";
import {
  archiveId,
  assertOwner,
  getSession,
  getTrace,
  IngestRejected,
  isSource,
  listSessions,
  OffsetMismatch,
  type RawFormat,
  readChanges,
  SessionRejected,
  type SessionUpload,
  SOURCES,
  type Source,
  type Store,
  StoreError,
  type StoreSessionResult,
  storeSession,
  tombstone,
} from "@dosu-ai/sessiondb";
import { VERSION } from "./version";

/** What `GET /v1/me` says about the bucket: enough for a reader to find it, never a secret. */
export interface StorageView {
  url: string;
  region?: string;
  account_id?: string;
  endpoint?: string;
}

/** A bearer token and the person it belongs to: the `owners/<owner>/` folder it may use. */
export interface TokenGrant {
  token: string;
  owner: string;
}

export interface AppOptions {
  /** The bucket every session goes to. */
  store: Store;
  storage: StorageView;
  /** Bearer tokens that may call the API, each bound to one owner. */
  tokens: TokenGrant[];
  /** Identifies this server in layout markers (`sessiondb-server/0.1.0`). */
  client?: string;
  now?: () => Date;
}

type Handler = (ctx: Context) => Promise<Response> | Response;

interface Context {
  request: Request;
  url: URL;
  params: Record<string, string>;
}

interface Route {
  method: string;
  pattern: RegExp;
  names: string[];
  handler: Handler;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function error(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}

function bearer(request: Request): string | undefined {
  const header = request.headers.get("authorization");
  if (!header) return undefined;
  const [scheme, token] = header.split(/\s+/, 2);
  return scheme?.toLowerCase() === "bearer" && token ? token : undefined;
}

async function readBody(request: Request): Promise<Uint8Array> {
  const bytes = new Uint8Array(await request.arrayBuffer());
  const encoding = request.headers.get("content-encoding")?.toLowerCase();
  if (!encoding || encoding === "identity") return bytes;
  if (encoding === "gzip") {
    try {
      return Bun.gunzipSync(bytes);
    } catch {
      throw new HttpError(400, "bad_encoding", "body is not valid gzip");
    }
  }
  throw new HttpError(415, "unsupported_encoding", `Content-Encoding ${encoding} not supported`);
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const bytes = await readBody(request);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpError(400, "bad_json", "body is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, "bad_json", "body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function str(body: Record<string, unknown>, key: string, required = false): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) {
    if (required) throw new HttpError(400, "missing_field", `${key} is required`);
    return undefined;
  }
  if (typeof value !== "string") throw new HttpError(400, "bad_field", `${key} must be a string`);
  if (required && value === "") throw new HttpError(400, "missing_field", `${key} is required`);
  return value;
}

/** `agent` is the trajectory source name (`claude-code`, not `claude`): one spelling, since the
 * archive id is derived from it. */
function sourceOf(agent: string): Source {
  if (!isSource(agent)) {
    throw new HttpError(
      422,
      "unsupported_agent",
      `no normalizer for '${agent}' (one of ${SOURCES.join(", ")})`,
    );
  }
  return agent;
}

function intParam(url: URL, name: string, fallback: number, max: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, "bad_query", `${name} must be ≥ 1`);
  return Math.min(n, max);
}

function tokensEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function createApp(options: AppOptions) {
  const { store, storage } = options;
  const tokens = options.tokens
    .filter((t) => t.token.length > 0)
    .map((t) => ({ token: t.token, owner: assertOwner(t.owner) }));
  if (tokens.length === 0) throw new Error("at least one token is required");
  const client = options.client ?? `sessiondb-server/${VERSION}`;
  const now = options.now ?? (() => new Date());
  const routes: Route[] = [];

  function route(method: string, path: string, handler: Handler): void {
    const names: string[] = [];
    const pattern = new RegExp(
      `^${path.replace(/[:*]([A-Za-z_]+)/g, (token: string, name: string) => {
        names.push(name);
        return token.startsWith("*") ? "(.+)" : "([^/]+)";
      })}/?$`,
    );
    routes.push({ method, pattern, names, handler });
  }

  /** The owner the request's token is bound to; every read and write is scoped to it. */
  function authorize(request: Request): string {
    const token = bearer(request);
    const grant = token ? tokens.find((known) => tokensEqual(token, known.token)) : undefined;
    if (!grant) throw new HttpError(401, "unauthorized", "a valid token is required");
    return grant.owner;
  }

  // --- health -----------------------------------------------------------------

  route("GET", "/healthz", () => json({ ok: true, version: VERSION }));

  // --- identity -----------------------------------------------------------------

  route("GET", "/v1/me", ({ request }) => {
    const owner = authorize(request);
    return json({ owner, storage });
  });

  // --- sessions ---------------------------------------------------------

  /** The pipeline (`ingest/session.ts`) as a response: 201 for a new trace, 200 for a duplicate
   * or a trivial session, 422 for a transcript it refuses, 409 for a chunk that does not start
   * where the session's log ends (`expected` says where it does). */
  async function stored(upload: SessionUpload): Promise<Response> {
    let result: StoreSessionResult;
    try {
      result = await storeSession(upload, { store, client, now });
    } catch (err) {
      if (err instanceof OffsetMismatch) {
        return json(
          { error: { code: err.code, message: err.message, expected: err.expected } },
          409,
        );
      }
      if (err instanceof SessionRejected) throw new HttpError(422, err.code, err.message);
      if (err instanceof IngestRejected) throw new HttpError(422, err.code, err.message);
      throw err;
    }
    return json(result, result.status === "stored" ? 201 : 200);
  }

  route("POST", "/v1/sessions", async ({ request }) => {
    const owner = authorize(request);
    const body = await readJson(request);
    const agent = sourceOf(str(body, "agent", true) as string);
    const format = (str(body, "format") ?? "jsonl") as RawFormat;
    if (format !== "jsonl" && format !== "json") {
      throw new HttpError(400, "bad_field", "format must be jsonl or json");
    }
    const offset = body.offset ?? 0;
    if (!Number.isInteger(offset) || (offset as number) < 0) {
      throw new HttpError(400, "bad_field", "offset must be a byte offset ≥ 0");
    }
    const shipped = body.shipped as { records?: unknown; prefix_sha256?: unknown } | undefined;
    if (
      shipped !== undefined &&
      (typeof shipped !== "object" ||
        shipped === null ||
        !Number.isInteger(shipped.records) ||
        typeof shipped.prefix_sha256 !== "string")
    ) {
      throw new HttpError(400, "bad_field", "shipped needs records and prefix_sha256");
    }
    return stored({
      owner,
      agent,
      session_id: str(body, "session_id", true) as string,
      transcript: str(body, "transcript", true) as string,
      format,
      offset: offset as number,
      project: str(body, "project"),
      branch: str(body, "branch"),
      parent_session_id: str(body, "parent_session_id"),
      fork_of: str(body, "fork_of"),
      ...(shipped
        ? {
            shipped: {
              records: shipped.records as number,
              prefix_sha256: shipped.prefix_sha256 as string,
            },
          }
        : {}),
    });
  });

  route("GET", "/v1/sessions", async ({ request, url }) => {
    const owner = authorize(request);
    const page = await listSessions(store, owner, {
      startAfter: url.searchParams.get("after") ?? undefined,
      limit: intParam(url, "limit", 100, 1000),
    });
    return json(page);
  });

  route("GET", "/v1/sessions/:agent/:session_id", async ({ request, params }) => {
    const owner = authorize(request);
    const metadata = await getSession(
      store,
      owner,
      decodeURIComponent(params.agent as string),
      decodeURIComponent(params.session_id as string),
    );
    if (!metadata) throw new HttpError(404, "not_found", "no such session");
    return json(metadata);
  });

  route("GET", "/v1/sessions/:agent/:session_id/trace", async ({ request, params, url }) => {
    const owner = authorize(request);
    const agent = decodeURIComponent(params.agent as string);
    const sessionId = decodeURIComponent(params.session_id as string);
    const metadata = await getSession(store, owner, agent, sessionId);
    if (!metadata) throw new HttpError(404, "not_found", "no such session");
    if (metadata.status === "redacted") {
      throw new HttpError(410, "redacted", "session was redacted; no trace");
    }
    const hash = url.searchParams.get("hash") ?? metadata.head;
    if (!hash) throw new HttpError(404, "no_trace", "session is stored raw only; no trace yet");
    const trace = await getTrace(store, owner, archiveId(owner, agent, sessionId), hash);
    if (!trace) throw new HttpError(404, "not_found", "no such trace");
    return json(trace);
  });

  route("DELETE", "/v1/sessions/:agent/:session_id", async ({ request, params }) => {
    const owner = authorize(request);
    const result = await tombstone({
      store,
      owner,
      agent: decodeURIComponent(params.agent as string),
      session_id: decodeURIComponent(params.session_id as string),
      now,
    });
    if (!result) throw new HttpError(404, "not_found", "no such session");
    return json(result);
  });

  route("GET", "/v1/changes", async ({ request, url }) => {
    const owner = authorize(request);
    const page = await readChanges(store, owner, {
      after: url.searchParams.get("after") ?? undefined,
      since: url.searchParams.get("since") ?? undefined,
      limit: intParam(url, "limit", 100, 1000),
    });
    return json(page);
  });

  // --- dispatch -----------------------------------------------------------------

  async function fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    let pathMatched = false;
    for (const r of routes) {
      const m = r.pattern.exec(url.pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== request.method) continue;
      const params: Record<string, string> = {};
      r.names.forEach((name, i) => {
        params[name] = m[i + 1] as string;
      });
      try {
        return await r.handler({ request, url, params });
      } catch (err) {
        if (err instanceof HttpError) return error(err.status, err.code, err.message);
        if (err instanceof StoreError) {
          return error(502, "storage_error", `storage failed: ${err.message}`);
        }
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[sessiondb] ${request.method} ${url.pathname}: ${message}`);
        return error(500, "internal", "internal error");
      }
    }
    return pathMatched
      ? error(405, "method_not_allowed", `${request.method} not allowed`)
      : error(404, "not_found", `no route ${url.pathname}`);
  }

  return { fetch };
}

export type App = ReturnType<typeof createApp>;
