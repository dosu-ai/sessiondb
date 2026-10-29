/** The HTTP surface: one `fetch(Request) → Response` the tests call directly and `main.ts`
 * serves. One bucket, one token list, both from the environment. Each token names a person,
 * and that person's sessions live under `owners/<name>/`: a token writes there and reads only
 * there, so teammates never see each other's transcripts. A client with a token posts raw
 * transcripts; the server normalizes, redacts and writes them to the bucket in the layout, so
 * the laptop never holds a bucket credential and the bucket never holds an unredacted byte. */

import { timingSafeEqual } from "node:crypto";
import { copiedPrefix, planShipment, prefixSha256 } from "./ingest/continuation";
import {
  getSession,
  getTrace,
  IngestRejected,
  ingest,
  listSessions,
  putRaw,
  tombstone,
} from "./ingest/ingest";
import { LIMITS } from "./ingest/limits";
import { isTrivialTrajectory } from "./ingest/worthiness";
import {
  isSource,
  NORMALIZER,
  NormalizeError,
  normalizeTranscript,
  SOURCES,
  type Source,
} from "./normalize";
import { redactRaw } from "./redact/raw";
import type { RawFormat } from "./schemas/store";
import type { NormalizedRecord } from "./schemas/trajectory";
import { readChanges } from "./store/changes";
import { archiveId, assertOwner, keys } from "./store/layout";
import { type Store, StoreError } from "./store/store";
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

  /** A recorded branch name, or undefined for the detached (`HEAD`) and empty values agents
   * record. */
  function recordedBranch(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const branch = value.trim();
    return branch && branch !== "HEAD" ? branch : undefined;
  }

  /** What a fork copied from the session it was made from, when that parent is stored here. */
  async function forkCopy(
    owner: string,
    agent: string,
    forkOf: string | undefined,
    records: NormalizedRecord[],
  ) {
    if (!forkOf) return undefined;
    const parent = await getSession(store, owner, agent, forkOf);
    if (!parent?.head) return undefined;
    const trace = await getTrace(store, owner, parent.archive_id, parent.head);
    return copiedPrefix(records, trace?.records ?? null);
  }

  route("POST", "/v1/sessions", async ({ request }) => {
    const owner = authorize(request);
    const body = await readJson(request);
    const agent = str(body, "agent", true) as string;
    const sessionId = str(body, "session_id", true) as string;
    const transcript = str(body, "transcript", true) as string;
    const format = (str(body, "format") ?? "jsonl") as RawFormat;
    if (format !== "jsonl" && format !== "json") {
      throw new HttpError(400, "bad_field", "format must be jsonl or json");
    }
    const keepRaw = body.keep_raw === undefined ? true : body.keep_raw === true;
    const source = sourceOf(agent);
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

    let records: NormalizedRecord[];
    try {
      const outcome = normalizeTranscript({ source, transcript });
      if (outcome.empty) throw new HttpError(422, "empty", "transcript has no conversation");
      records = outcome.records;
    } catch (err) {
      if (err instanceof HttpError) throw err;
      if (err instanceof NormalizeError) {
        throw new HttpError(422, `normalize_${err.code}`, err.message);
      }
      throw err;
    }
    // What the client stores as its shipped prefix after this call, whatever is written.
    const whole = {
      records_total: records.length,
      prefix_sha256: prefixSha256(records, records.length),
    };

    // A resumed session: the client says how much shipped before (what it stored from the last
    // answer); the planner picks the tail, and falls back to the whole session when the prefix
    // no longer matches. A fork's copy of its parent's history is the parent's to ship.
    let plan = shipped
      ? planShipment(records, {
          records: shipped.records as number,
          prefix_sha256: shipped.prefix_sha256 as string,
        })
      : { records, fresh: records };
    const copied = await forkCopy(owner, agent, str(body, "fork_of"), records);
    if (!plan.continuation && copied) plan = planShipment(records, copied);
    if (isTrivialTrajectory(plan.fresh)) return json({ status: "trivial", ...whole });

    // The branch the transcript recorded as it began, else what the client resolved.
    const meta = records[0]?.role === "meta" ? records[0] : undefined;
    const branch = recordedBranch(meta?.git_branch) ?? str(body, "branch");

    try {
      const result = await ingest({
        store,
        owner,
        records: plan.records,
        metadata: {
          session_id: sessionId,
          agent,
          project: str(body, "project"),
          branch,
          parent_session_id: str(body, "parent_session_id"),
          ...(plan.continuation ? { continuation: plan.continuation } : {}),
          normalizer: NORMALIZER,
        },
        client,
        now,
      });
      let raw: { status: "stored" | "exists" | "skipped" | "too_large"; part?: number } = {
        status: "skipped",
      };
      if (keepRaw) {
        const bytes = Bun.gzipSync(new TextEncoder().encode(redactRaw(transcript, format)));
        if (bytes.length > LIMITS.maxRawPartBytes) {
          raw = { status: "too_large" };
        } else {
          raw = await putRaw({
            store,
            owner,
            agent,
            session_id: sessionId,
            part: 0,
            format,
            bytes,
            now,
          });
        }
      }
      return json({ ...result, ...whole, raw }, result.status === "stored" ? 201 : 200);
    } catch (err) {
      if (err instanceof IngestRejected) throw new HttpError(422, err.code, err.message);
      throw err;
    }
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
    const hash = url.searchParams.get("hash") ?? metadata.head;
    if (!hash) throw new HttpError(410, "redacted", "session was redacted; no trace");
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

  // --- raw object reads ----------------------------------------------------------
  // Read-only access to the keys under the token's own `owners/<owner>/`, so a client can read
  // the layout over HTTP. Writes stay behind /v1/sessions, where normalization and redaction
  // happen.

  function ownedKey(owner: string, key: string): string {
    const root = `${keys.owner(owner)}/`;
    if (key !== root.slice(0, -1) && !key.startsWith(root)) {
      throw new HttpError(403, "forbidden", `keys must be under ${root}`);
    }
    return key;
  }

  route("GET", "/v1/objects", async ({ request, url }) => {
    const owner = authorize(request);
    const prefix = ownedKey(owner, url.searchParams.get("prefix") ?? keys.owner(owner));
    const page = await store.list(prefix, {
      startAfter: url.searchParams.get("after") ?? undefined,
      limit: intParam(url, "limit", 1000, 1000),
    });
    return json(page);
  });

  route("GET", "/v1/objects/*key", async ({ request, params }) => {
    const owner = authorize(request);
    const key = ownedKey(owner, params.key as string);
    const bytes = await store.get(key);
    if (bytes === null) throw new HttpError(404, "not_found", `no object ${key}`);
    return new Response(new Uint8Array(bytes) as Uint8Array<ArrayBuffer>, {
      headers: { "content-type": "application/octet-stream", "content-length": `${bytes.length}` },
    });
  });

  route("HEAD", "/v1/objects/*key", async ({ request, params }) => {
    const owner = authorize(request);
    const key = ownedKey(owner, params.key as string);
    const stat = await store.stat(key);
    if (stat === null) return new Response(null, { status: 404 });
    return new Response(null, {
      headers: {
        "content-length": `${stat.size}`,
        ...(stat.etag ? { etag: stat.etag } : {}),
      },
    });
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
