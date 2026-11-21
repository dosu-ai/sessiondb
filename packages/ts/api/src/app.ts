import { createHash, timingSafeEqual } from "node:crypto";
import {
  AuthRequestError,
  canRead,
  type Principal,
  pickClaims,
  requireDelete,
  requireReadOwner,
  requireScope,
  requireVisibilityChange,
  type Scope,
  seesEverything,
  serviceSourceId,
  type TokenRequest,
  tokenInfo,
  USER_HEADER,
} from "@seshi/auth";
import {
  ConfigError,
  parseDuration,
  RUNTIME_SECTIONS,
  SealingError,
  sourceId,
} from "@seshi/config";
import { renderTrace } from "@seshi/formats";
import { type Instance, RuntimeChangeError, type WriteCondition } from "@seshi/instance";
import {
  CAPTURE_RULES_SCHEMA,
  type CaptureRulesDocument,
  type ChangesPage,
  Forbidden,
  type Identity,
  type IngestOptions,
  IngestRejected,
  isRenderFormat,
  isStub,
  labelsProblems,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  OffsetMismatch,
  type RawFormat,
  RENDER_FORMATS,
  type RenderFormat,
  SCOPE_FIELDS,
  SessionConflict,
  SessionExcluded,
  type SessionMetadata,
  SessionRejected,
  type StorageView,
  StoreError,
  type StoreSessionResult,
  Unauthorized,
  UPLOAD_SOURCE,
  type Upload,
  VERSION,
  type Visibility,
  type Writer,
} from "@seshi/model";
import {
  DEFAULT_LIMITS,
  finishTombstone,
  getSession,
  getTrace,
  listSessions,
  type StoreSeshi,
  setVisibility,
  staleSessions,
  tombstone,
} from "@seshi/pipeline";
import { rulesDocument } from "@seshi/redact";
import {
  FEED_DEFAULT_LIMIT,
  FEED_MAX_LIMIT,
  SearchQueryError,
  SearchUnavailable,
  viewerFor,
} from "@seshi/search";
import {
  isOwner,
  isPreconditionFailed,
  keys,
  listOwners,
  listRecords,
  listReviews,
  type MetadataRead,
  type ReviewRecord,
  readChanges,
  readMetadata,
  sourcesWithRecords,
  type TokenKind,
} from "@seshi/store";
import { inflateCapped, readCapped } from "./otlp/body";
import { otlpTraces } from "./otlp/receiver";
import { searchRequestOf } from "./search";

export type { StorageView };

const SEARCH_RETRY_AFTER_S = 5;

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
    /** Each thing wrong, one a line, when there are several (a refused config change). */
    readonly problems?: string[],
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

function error(status: number, code: string, message: string, problems?: string[]): Response {
  return json({ error: { code, message, ...(problems ? { problems } : {}) } }, status);
}

const RETRACT_HEADER = "x-seshi-retract";

function retractHashOf(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function bearer(request: Request): string | undefined {
  const header = request.headers.get("authorization");
  if (!header) return undefined;
  const [scheme, token] = header.split(/\s+/, 2);
  return scheme?.toLowerCase() === "bearer" && token ? token : undefined;
}

const JSON_STRING_GROWTH = 2;
const ENVELOPE_FIELDS_ALLOWANCE = 1024 * 1024;

export function maxBodyBytes(maxUploadBytes: number): number {
  return maxUploadBytes * JSON_STRING_GROWTH + ENVELOPE_FIELDS_ALLOWANCE;
}

function tooLarge(max: number): HttpError {
  return new HttpError(413, "too_large", `request body exceeds ${max} bytes`);
}

async function readBody(request: Request, max: number): Promise<Uint8Array> {
  const declared = Number(request.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > max) throw tooLarge(max);
  const encoding = request.headers.get("content-encoding")?.toLowerCase();
  if (encoding && encoding !== "identity" && encoding !== "gzip") {
    throw new HttpError(415, "unsupported_encoding", `Content-Encoding ${encoding} not supported`);
  }
  const stream = request.body;
  if (!stream) return new Uint8Array();
  if (!encoding || encoding === "identity") return readCapped(stream, max, () => tooLarge(max));
  return inflateCapped(
    stream,
    { wire: max, inflated: max },
    {
      wire: () => tooLarge(max),
      inflated: () => tooLarge(max),
      invalid: () => new HttpError(400, "bad_encoding", "body is not valid gzip"),
    },
  );
}

async function readJson(request: Request, max: number): Promise<Record<string, unknown>> {
  const bytes = await readBody(request, max);
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

function optionalStrings<K extends string>(
  body: Record<string, unknown>,
  keys: readonly K[],
): Partial<Record<K, string>> {
  const out: Partial<Record<K, string>> = {};
  for (const key of keys) {
    const value = str(body, key);
    if (value !== undefined) out[key] = value;
  }
  return out;
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

function assertKnownSource(formats: Instance["formats"], format: string): string {
  if (!formats.has(format)) {
    throw new HttpError(
      422,
      "unsupported_agent",
      `no normalizer for '${format}' (one of ${formats.sources.join(", ")})`,
    );
  }
  return format;
}

function intParam(url: URL, name: string, fallback: number, max: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, "bad_query", `${name} must be ≥ 1`);
  return Math.min(n, max);
}

function bool(body: Record<string, unknown>, key: string): boolean {
  const value = body[key] ?? false;
  if (typeof value !== "boolean") throw new HttpError(400, "bad_field", `${key} must be a boolean`);
  return value;
}

function visibilityField(value: unknown, where = "visibility"): Visibility | undefined {
  if (value === undefined || value === null) return undefined;
  if (value !== "org" && value !== "owner") {
    throw new HttpError(400, "bad_field", `${where} must be org or owner`);
  }
  return value;
}

function writerFor(principal: Principal): Writer {
  return {
    kind: principal.kind,
    principal: principal.owner,
    credential_id: principal.credential_id,
    source_id: (principal.kind === "service" && serviceSourceId(principal.owner)) || UPLOAD_SOURCE,
  };
}

function identityOf(principal: Principal, storage: StorageView): Identity {
  return {
    owner: principal.owner,
    storage,
    kind: principal.kind,
    role: principal.role,
    scopes: [...principal.scopes].sort(),
    owner_basis: principal.owner_basis,
    credential_id: principal.credential_id,
    ...(principal.visibility ? { visibility: principal.visibility } : {}),
    ...(principal.expires_at ? { expires_at: principal.expires_at.toISOString() } : {}),
  };
}

const TOKEN_KINDS: readonly TokenKind[] = ["org", "admin", "device", "service"];

export function createApp(instance: Instance) {
  const { store, storage, formats, auth, pipeline, now } = instance;
  const aliases = auth.aliases;
  const routes: Route[] = [];
  const bodyLimit = maxBodyBytes(instance.limits.max_upload_bytes);

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

  function authenticate(request: Request): Promise<Principal> {
    return auth.authenticate(bearer(request), request.headers.get(USER_HEADER) ?? undefined);
  }

  async function caller(request: Request, scope: Scope): Promise<Principal> {
    const principal = await authenticate(request);
    requireScope(principal, scope);
    return principal;
  }

  function writerClient(principal: Principal): StoreSeshi {
    return instance.sessions({
      owner: principal.owner,
      writer: writerFor(principal),
      owner_basis: principal.owner_basis,
      claims: principal.claims,
      ...(principal.visibility ? { visibility: principal.visibility } : {}),
    });
  }

  function ownerOf(url: URL, principal: Principal): string {
    const owner = url.searchParams.get("owner") ?? principal.owner;
    if (!isOwner(owner)) throw new HttpError(400, "bad_query", "owner is not an owner id");
    return owner;
  }

  function canManageStub(principal: Principal, stub: SessionMetadata): boolean {
    return canRead(principal, { ...stub, visibility: "owner" }, aliases);
  }

  async function readable(
    principal: Principal,
    owner: string,
    format: string,
    sessionId: string,
    options: { stubs?: boolean } = {},
  ): Promise<{ folder: string; metadata: SessionMetadata }> {
    for (const folder of aliases.storedAs(owner)) {
      const metadata = await getSession(store, folder, format, sessionId);
      if (metadata === null) continue;
      if (isStub(metadata)) {
        if (!options.stubs || !canManageStub(principal, metadata)) break;
      } else if (!canRead(principal, metadata, aliases)) break;
      return { folder, metadata };
    }
    throw new HttpError(404, "not_found", "no such session");
  }

  function sessionParams(params: Record<string, string>): { format: string; sessionId: string } {
    return {
      format: decodeURIComponent(params.format as string),
      sessionId: decodeURIComponent(params.session_id as string),
    };
  }

  route("GET", "/healthz", () => json({ ok: true, version: VERSION }));

  if (!instance.api) return { fetch: dispatch(routes), auth, pipeline };

  route("GET", "/v1/auth/config", () => json({ version: VERSION, ...auth.modes() }));

  route("POST", "/v1/auth/exchange", async ({ request }) => {
    const body = await readJson(request, 64 * 1024);
    const idToken = str(body, "id_token", true) as string;
    const nonce = str(body, "nonce");
    const rawMachine = body.machine;
    let machine: { id: string; name?: string } | undefined;
    if (rawMachine !== undefined && rawMachine !== null) {
      if (typeof rawMachine !== "object" || Array.isArray(rawMachine)) {
        throw new HttpError(400, "bad_field", "machine must be an object with an id");
      }
      const m = rawMachine as Record<string, unknown>;
      const id = str(m, "id", true) as string;
      const name = str(m, "name");
      machine = { id, ...(name ? { name } : {}) };
    }
    const visibility = visibilityField(body.visibility);
    try {
      const result = await auth.exchange({
        id_token: idToken,
        ...(nonce !== undefined ? { nonce } : {}),
        ...(machine ? { machine } : {}),
        ...(visibility ? { visibility } : {}),
      });
      return json(result);
    } catch (err) {
      if (err instanceof AuthRequestError) {
        throw new HttpError(err.code === "no_idp" ? 404 : 400, err.code, err.message);
      }
      throw err;
    }
  });

  route("GET", "/v1/me", async ({ request }) => {
    const principal = await authenticate(request);
    return json(identityOf(principal, storage));
  });

  route("GET", "/v1/owners", async ({ request, url }) => {
    await caller(request, "sessions:read");
    const after = url.searchParams.get("after") ?? undefined;
    if (after !== undefined && !isOwner(after)) {
      throw new HttpError(400, "bad_query", "after is not an owner id");
    }
    return json(await listOwners(store, { after, limit: intParam(url, "limit", 100, 1000) }));
  });

  async function stored(
    db: StoreSeshi,
    upload: Upload,
    options: IngestOptions = {},
  ): Promise<Response> {
    let result: StoreSessionResult;
    try {
      result = await db.ingest(upload, options);
    } catch (err) {
      if (err instanceof OffsetMismatch) {
        return json(
          { error: { code: err.code, message: err.message, expected: err.expected } },
          409,
        );
      }
      if (err instanceof SessionConflict) throw new HttpError(409, err.code, err.message);
      if (err instanceof SessionExcluded) throw new HttpError(403, err.code, err.message);
      if (err instanceof SessionRejected) throw new HttpError(422, err.code, err.message);
      throw err;
    }
    return json(result, result.status === "stored" ? 201 : 200);
  }

  route("POST", "/v1/sessions", async ({ request }) => {
    const principal = await caller(request, "sessions:write");
    const body = await readJson(request, bodyLimit);
    // Before seshi 0.16 the format was sent as `agent` and the encoding as `format`: a body
    // with `agent` is read that way, so uploaders installed before keep working.
    const legacy = body.agent !== undefined;
    const formatField = legacy ? "agent" : "format";
    const encodingField = legacy ? "format" : "encoding";
    const format = assertKnownSource(formats, str(body, formatField, true) as string);
    const encoding = (str(body, encodingField) ?? "jsonl") as RawFormat;
    if (encoding !== "jsonl" && encoding !== "json") {
      throw new HttpError(400, "bad_field", `${encodingField} must be jsonl or json`);
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
    const replace = bool(body, "replace");
    const rebuild = bool(body, "rebuild");
    const visibility = visibilityField(body.visibility);
    if (body.claims !== undefined && (typeof body.claims !== "object" || body.claims === null)) {
      throw new HttpError(400, "bad_field", "claims must be an object");
    }
    const claims = pickClaims(body.claims);
    const retractHash = str(body, "retract_hash");
    if (retractHash !== undefined && !/^[0-9a-f]{64}$/.test(retractHash)) {
      throw new HttpError(400, "bad_field", "retract_hash must be a sha256 in lowercase hex");
    }
    const idempotencyKey =
      request.headers.get("idempotency-key") ?? str(body, "idempotency_key") ?? undefined;
    if (idempotencyKey === "") {
      throw new HttpError(400, "bad_field", "an idempotency key must not be empty");
    }
    if (idempotencyKey !== undefined && idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
      throw new HttpError(
        400,
        "bad_field",
        `an idempotency key must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`,
      );
    }
    const labels = body.labels;
    if (labels !== undefined && labels !== null) {
      const problems = labelsProblems(labels);
      if (problems.length > 0) throw new HttpError(400, "bad_field", problems.join("; "));
    }
    const retractSecret =
      replace || rebuild ? (request.headers.get(RETRACT_HEADER) ?? undefined) : undefined;
    const upload: Upload = {
      format,
      session_id: str(body, "session_id", true) as string,
      transcript: str(body, "transcript", true) as string,
      encoding,
      offset: offset as number,
      project: str(body, "project"),
      branch: str(body, "branch"),
      ...optionalStrings(body, SCOPE_FIELDS),
      ...(labels !== undefined && labels !== null
        ? { labels: labels as Record<string, string> }
        : {}),
      parent_session_id: str(body, "parent_session_id"),
      fork_of: str(body, "fork_of"),
      ...(replace ? { replace } : {}),
      ...(rebuild ? { rebuild } : {}),
      ...(visibility ? { visibility } : {}),
      ...(claims ? { claims } : {}),
      ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
      ...(retractHash ? { retract_hash: retractHash } : {}),
      ...(shipped
        ? {
            shipped: {
              records: shipped.records as number,
              prefix_sha256: shipped.prefix_sha256 as string,
            },
          }
        : {}),
    };
    return stored(writerClient(principal), upload, retractSecret ? { retractSecret } : {});
  });

  route("GET", "/v1/sessions", async ({ request, url }) => {
    // Its own sessions any credential lists (X5.10); another owner's need sessions:read.
    const principal = await authenticate(request);
    const owner = ownerOf(url, principal);
    requireReadOwner(principal, owner, aliases);
    const after = url.searchParams.get("after") ?? undefined;
    const limit = intParam(url, "limit", 100, 1000);
    const folders = aliases
      .storedAs(owner)
      .map((folder) => ({ folder, prefix: keys.sessions(folder) }))
      .sort((a, b) => (a.prefix < b.prefix ? -1 : 1));
    const sessions: SessionMetadata[] = [];
    let cursor: string | undefined;
    let truncated = false;
    for (const { folder, prefix } of folders) {
      let startAfter: string | undefined;
      if (after !== undefined) {
        if (after.startsWith(prefix)) startAfter = after;
        else if (after > prefix) continue;
      }
      const page = await listSessions(store, folder, { startAfter, limit });
      sessions.push(...page.sessions.filter((m) => !isStub(m) && canRead(principal, m, aliases)));
      cursor = page.cursor ?? cursor;
      if (page.truncated) {
        truncated = true;
        break;
      }
    }
    return json({ sessions, cursor, truncated });
  });

  route("GET", "/v1/sessions/stale", async ({ request, url }) => {
    const principal = await caller(request, "sessions:write");
    const after = url.searchParams.get("after") ?? undefined;
    const limit = intParam(url, "limit", 1000, 1000);
    return json(
      await staleSessions(store, principal.owner, formats, {
        ...(after !== undefined ? { after } : {}),
        limit,
      }),
    );
  });

  /** A session as the archive-id routes address it: exactly the folder `owner` (no aliases
   * folded) and the archive id in it, as change entries, search results and listings name
   * them. Like the format routes, `404` for one the caller may not read, and for a stub. */
  async function readableByArchive(
    principal: Principal,
    params: Record<string, string>,
  ): Promise<{ folder: string; metadata: SessionMetadata }> {
    const owner = decodeURIComponent(params.owner as string);
    const archive = decodeURIComponent(params.archive_id as string);
    if (!isOwner(owner)) throw new HttpError(400, "bad_query", "owner is not an owner id");
    if (!/^[0-9a-f]{64}$/.test(archive)) {
      throw new HttpError(400, "bad_query", "archive_id is not a sha256 in lowercase hex");
    }
    const metadata = await readMetadata(store, owner, archive);
    if (metadata === null || isStub(metadata) || !canRead(principal, metadata, aliases)) {
      throw new HttpError(404, "not_found", "no such session");
    }
    return { folder: owner, metadata };
  }

  /** The session the request names, by `{format}/{session_id}` (with `?owner=`) or by
   * `{owner}/{archive_id}`. Any credential reads its own sessions, being their owner (X5.10);
   * one without `sessions:read` finds no one else's (canRead), so those are `404`. */
  async function located(
    request: Request,
    params: Record<string, string>,
    url: URL,
  ): Promise<{ principal: Principal; folder: string; metadata: SessionMetadata }> {
    const principal = await authenticate(request);
    if (params.archive_id !== undefined) {
      return { principal, ...(await readableByArchive(principal, params)) };
    }
    const { format, sessionId } = sessionParams(params);
    return {
      principal,
      ...(await readable(principal, ownerOf(url, principal), format, sessionId)),
    };
  }

  async function sessionOf({ request, params, url }: Context): Promise<Response> {
    return json((await located(request, params, url)).metadata);
  }

  async function renderedTrace(request: Request, params: Record<string, string>, url: URL) {
    const { folder, metadata } = await located(request, params, url);
    if (metadata.status === "redacted") {
      throw new HttpError(410, "redacted", "session was redacted; no trace");
    }
    // `render`; until 0.17 also `format`, its name before the session's format took that name.
    const render = url.searchParams.get("render") ?? url.searchParams.get("format") ?? "seshi";
    if (!isRenderFormat(render)) {
      throw new HttpError(400, "bad_query", `render must be one of ${RENDER_FORMATS.join(", ")}`);
    }
    const hash = url.searchParams.get("hash") ?? metadata.head;
    if (!hash) throw new HttpError(404, "no_trace", "session has no trace");
    if (!metadata.traces.some((ref) => ref.content_hash === hash)) {
      throw new HttpError(404, "not_found", "no such trace");
    }
    const trace = await getTrace(store, folder, metadata.archive_id, hash);
    if (!trace) throw new HttpError(404, "not_found", "no such trace");
    return { metadata, render: render as RenderFormat, hash, body: renderTrace(trace, render) };
  }

  async function traceOf({ request, params, url }: Context): Promise<Response> {
    return json((await renderedTrace(request, params, url)).body);
  }

  async function exportOf({ request, params, url }: Context): Promise<Response> {
    const { metadata, render, hash, body } = await renderedTrace(request, params, url);
    const name =
      `${metadata.format}-${metadata.session_id}-${hash.slice(0, 12)}.${render}.json`.replace(
        /[^A-Za-z0-9._-]/g,
        "_",
      );
    return json(body, 200, { "content-disposition": `attachment; filename="${name}"` });
  }

  async function reviewsOf({ request, params, url }: Context): Promise<Response> {
    const { principal, folder, metadata } = await located(request, params, url);
    const records = await listReviews(store, folder, metadata.archive_id);
    const audit = principal.role === "admin";
    const view = (r: ReviewRecord) =>
      audit
        ? r
        : {
            schema: r.schema,
            n: r.n,
            at: r.at,
            content_hash: r.content_hash,
            decision: r.decision,
          };
    return json({ reviews: records.map(view) });
  }

  route("GET", "/v1/sessions/:format/:session_id", sessionOf);
  route("GET", "/v1/sessions/:format/:session_id/trace", traceOf);
  route("GET", "/v1/sessions/:format/:session_id/export", exportOf);
  route("GET", "/v1/sessions/:format/:session_id/reviews", reviewsOf);
  route("GET", "/v1/owners/:owner/sessions/:archive_id", sessionOf);
  route("GET", "/v1/owners/:owner/sessions/:archive_id/trace", traceOf);
  route("GET", "/v1/owners/:owner/sessions/:archive_id/export", exportOf);
  route("GET", "/v1/owners/:owner/sessions/:archive_id/reviews", reviewsOf);

  route("PATCH", "/v1/sessions/:format/:session_id", async ({ request, params, url }) => {
    // The owner's own credential may share or unshare: a sign-in reads, a device token only
    // writes, and either may (X5.10). One without sessions:read finds only its own sessions
    // (canRead), and requireVisibilityChange checks the scope.
    const principal = await authenticate(request);
    const { format, sessionId } = sessionParams(params);
    const body = await readJson(request, 64 * 1024);
    const visibility = visibilityField(body.visibility);
    if (visibility === undefined) {
      throw new HttpError(400, "missing_field", "visibility is required");
    }
    const { folder, metadata: current } = await readable(
      principal,
      ownerOf(url, principal),
      format,
      sessionId,
      { stubs: true },
    );
    requireVisibilityChange(principal, folder, aliases, current.owner_basis);
    let metadata: SessionMetadata | null;
    try {
      metadata = await setVisibility({
        store,
        owner: folder,
        format,
        session_id: sessionId,
        visibility,
        now,
        writer: writerFor(principal),
      });
    } catch (err) {
      if (err instanceof IngestRejected && err.code === "redacted") {
        throw new HttpError(410, "redacted", err.message);
      }
      throw err;
    }
    if (!metadata) throw new HttpError(404, "not_found", "no such session");
    return json(metadata);
  });

  async function retracted(request: Request, params: Record<string, string>, secret: string) {
    const principal = await caller(request, "sessions:write");
    const { format, sessionId } = sessionParams(params);
    if (!instance.config.capture.allow_retract) {
      throw new HttpError(
        403,
        "retract_disabled",
        "this server does not allow retraction (capture.allow_retract)",
      );
    }
    let folder: string | undefined;
    let metadata: SessionMetadata | null = null;
    for (const candidate of aliases.storedAs(principal.owner)) {
      metadata = await getSession(store, candidate, format, sessionId);
      if (metadata !== null) {
        folder = candidate;
        break;
      }
    }
    if (metadata === null || folder === undefined) {
      throw new HttpError(404, "not_found", "no such session");
    }
    if (metadata.status === "redacted") {
      await finishTombstone({ store, owner: folder, format, session_id: sessionId });
      throw new HttpError(410, "redacted", "session was already removed");
    }
    if (!metadata.retract_hash || !sameHash(retractHashOf(secret), metadata.retract_hash)) {
      throw new HttpError(
        403,
        "bad_retract_secret",
        "the retraction secret is not the one this session was uploaded with",
      );
    }
    const result = await tombstone({
      store,
      owner: folder,
      format,
      session_id: sessionId,
      now,
      reason: "retracted",
      writer: writerFor(principal),
    });
    if (!result) throw new HttpError(404, "not_found", "no such session");
    return json(result);
  }

  route("DELETE", "/v1/sessions/:format/:session_id", async ({ request, params, url }) => {
    const secret = request.headers.get(RETRACT_HEADER);
    if (secret !== null) return retracted(request, params, secret);
    const principal = await caller(request, "sessions:delete");
    const { format, sessionId } = sessionParams(params);
    const { folder } = await readable(principal, ownerOf(url, principal), format, sessionId, {
      stubs: true,
    });
    requireDelete(principal, folder, now(), aliases);
    const result = await tombstone({
      store,
      owner: folder,
      format,
      session_id: sessionId,
      now,
      reason: "deleted",
      writer: writerFor(principal),
    });
    if (!result) throw new HttpError(404, "not_found", "no such session");
    return json(result);
  });

  route("GET", "/v1/changes", async ({ request, url }) => {
    // Its own feed any credential reads (X5.10); another owner's needs sessions:read.
    const principal = await authenticate(request);
    const owner = ownerOf(url, principal);
    requireReadOwner(principal, owner, aliases);
    // The metadata the page read (to name an old entry's format), so it is not read again here.
    const read: MetadataRead = new Map();
    const page: ChangesPage = await readChanges(
      store,
      owner,
      {
        after: url.searchParams.get("after") ?? undefined,
        since: url.searchParams.get("since") ?? undefined,
        limit: intParam(url, "limit", 100, 1000),
      },
      read,
    );
    if (canRead(principal, { owner, visibility: "owner" }, aliases)) return json(page);
    const visible = new Map<string, boolean>();
    const entries = [];
    for (const item of page.entries) {
      const archive = item.entry.archive_id;
      let ok = visible.get(archive);
      if (ok === undefined) {
        const metadata = read.has(archive)
          ? (read.get(archive) ?? null)
          : await readMetadata(store, owner, archive);
        ok = metadata !== null && !isStub(metadata) && canRead(principal, metadata, aliases);
        visible.set(archive, ok);
      }
      if (ok) entries.push(item);
    }
    return json({ ...page, entries });
  });

  // Every owner's feed as one (`GET /v1/changes/all`), for readers that read everything. It
  // is served from the search index's copy of the feeds, so a poll costs no bucket request.
  route("GET", "/v1/changes/all", async ({ request, url }) => {
    const principal = await caller(request, "sessions:read");
    if (!seesEverything(principal)) {
      throw new HttpError(
        403,
        "forbidden",
        "every owner's change feed is for callers that read every session: a service token or an admin",
      );
    }
    if (url.searchParams.has("owner")) {
      throw new HttpError(400, "bad_query", "owner: this feed is every owner's; use /v1/changes");
    }
    return fromSearch((search) =>
      search.changes({
        after: url.searchParams.get("after") ?? undefined,
        since: url.searchParams.get("since") ?? undefined,
        limit: intParam(url, "limit", FEED_DEFAULT_LIMIT, FEED_MAX_LIMIT),
      }),
    );
  });

  /** Run `fn` against the search index, mapping its refusals: `404 search_disabled` with
   * search off, `400` for a request it cannot run, `503` with `Retry-After` while it builds. */
  async function fromSearch(
    fn: (search: NonNullable<Instance["search"]>) => unknown | Promise<unknown>,
  ): Promise<Response> {
    if (!instance.search) {
      throw new HttpError(404, "search_disabled", "search is turned off on this server");
    }
    try {
      return json(await fn(instance.search));
    } catch (err) {
      if (err instanceof SearchQueryError) throw new HttpError(400, err.code, err.message);
      if (err instanceof SearchUnavailable) {
        return json({ error: { code: err.code, message: err.message } }, 503, {
          "retry-after": String(SEARCH_RETRY_AFTER_S),
        });
      }
      throw err;
    }
  }

  route("GET", "/v1/search", async ({ request, url }) => {
    // A credential without `search` (a device token) searches its own sessions only: the
    // owner filter is its own owner, and naming another is refused (X5.10).
    const principal = await authenticate(request);
    return fromSearch((search) => {
      const query = searchRequestOf(url);
      if (!principal.scopes.has("search")) {
        const owner = query.owner ?? principal.owner;
        if (!isOwner(owner)) throw new SearchQueryError("owner is not an owner id");
        requireReadOwner(principal, owner, aliases, "search");
        query.owner = owner;
      }
      return search.search(viewerFor(principal, aliases), query);
    });
  });

  function tokenKind(value: unknown): TokenKind {
    if (typeof value !== "string" || !(TOKEN_KINDS as readonly string[]).includes(value)) {
      throw new HttpError(400, "bad_field", `kind must be one of ${TOKEN_KINDS.join(", ")}`);
    }
    return value as TokenKind;
  }

  route("POST", "/v1/tokens", async ({ request }) => {
    const principal = await caller(request, "tokens:admin");
    const body = await readJson(request, 64 * 1024);
    const scopes = body.scopes;
    if (
      scopes !== undefined &&
      (!Array.isArray(scopes) || !scopes.every((s) => typeof s === "string"))
    ) {
      throw new HttpError(400, "bad_field", "scopes must be a list of scopes");
    }
    const expiresAt = str(body, "expires_at");
    const expires = expiresAt === undefined ? undefined : new Date(expiresAt);
    if (expires !== undefined && Number.isNaN(expires.getTime())) {
      throw new HttpError(400, "bad_field", "expires_at must be an RFC 3339 time");
    }
    const visibility = visibilityField(body.visibility);
    const owner = str(body, "owner");
    const service = str(body, "service");
    const label = str(body, "label");
    const tokenRequest: TokenRequest = {
      kind: tokenKind(body.kind),
      ...(owner !== undefined ? { owner } : {}),
      ...(service !== undefined ? { service } : {}),
      ...(scopes !== undefined ? { scopes: scopes as Scope[] } : {}),
      ...(visibility ? { visibility } : {}),
      ...(expires !== undefined ? { expires_at: expires } : {}),
      ...(label !== undefined ? { label } : {}),
    };
    try {
      const issued = await auth.issue(tokenRequest, principal);
      return json({ token: issued.token, record: tokenInfo(issued.record) }, 201);
    } catch (err) {
      if (err instanceof AuthRequestError) throw new HttpError(400, err.code, err.message);
      throw err;
    }
  });

  route("GET", "/v1/tokens", async ({ request, url }) => {
    await caller(request, "tokens:admin");
    const owner = url.searchParams.get("owner") ?? undefined;
    const kind = url.searchParams.get("kind");
    const all = url.searchParams.get("all");
    if (all !== null && all !== "true" && all !== "false") {
      throw new HttpError(400, "bad_query", "all must be true or false");
    }
    const records = await auth.tokens.list({
      ...(owner !== undefined ? { owner } : {}),
      ...(kind !== null ? { kind: tokenKind(kind) } : {}),
      all: all === "true",
    });
    return json({ tokens: records.map(tokenInfo) });
  });

  route("POST", "/v1/tokens/revoke", async ({ request }) => {
    await caller(request, "tokens:admin");
    const body = await readJson(request, 64 * 1024);
    const owner = str(body, "owner", true) as string;
    if (!isOwner(owner)) throw new HttpError(400, "bad_field", "owner is not an owner id");
    const kind = body.kind === undefined ? undefined : tokenKind(body.kind);
    const revoked = await auth.tokens.revokeOwner(owner, kind);
    return json({ revoked: revoked.map(tokenInfo) });
  });

  route("DELETE", "/v1/tokens/:id", async ({ request, params }) => {
    await caller(request, "tokens:admin");
    const record = await auth.tokens.revoke(params.id as string);
    if (!record) throw new HttpError(404, "not_found", "no such token");
    return json({ token: tokenInfo(record) });
  });

  route("GET", "/v1/admin/jobs", async ({ request }) => {
    await caller(request, "sources:admin");
    return json(await instance.status());
  });

  route("GET", "/v1/admin/reload", async ({ request }) => {
    await caller(request, "sources:admin");
    return json(instance.configStatus());
  });

  route("POST", "/v1/admin/reload", async ({ request }) => {
    await caller(request, "sources:admin");
    if (!instance.configStatus().reloadable) {
      throw new HttpError(
        409,
        "not_reloadable",
        "this server was not started from a config file it can read again",
      );
    }
    const report = await instance.reload("api");
    const body = { reload: report, config: instance.configStatus() };
    if (report.outcome === "rejected") {
      const message = `the config was not applied; the running one stays: ${(report.errors ?? []).join("; ")}`;
      return json({ error: { code: "reload_rejected", message }, ...body }, 422);
    }
    return json(body);
  });

  route("GET", "/v1/redaction/rules", async ({ request }) => {
    await authenticate(request);
    const document = rulesDocument(instance.redaction);
    const etag = `"${document.rule_set}"`;
    const cached = request.headers.get("if-none-match");
    if (cached?.split(",").some((t) => t.trim() === etag)) {
      return new Response(null, { status: 304, headers: { etag } });
    }
    return json(document, 200, { etag, "cache-control": "private, no-cache" });
  });

  route("GET", "/v1/capture/rules", async ({ request }) => {
    await authenticate(request);
    const document: CaptureRulesDocument = {
      schema: CAPTURE_RULES_SCHEMA,
      exclude: instance.captureExclude,
      redact_tool_calls: instance.captureRedactToolCalls,
    };
    const digest = createHash("sha256").update(JSON.stringify(document)).digest("hex");
    const etag = `"${digest}"`;
    const cached = request.headers.get("if-none-match");
    if (cached?.split(",").some((t) => t.trim() === etag)) {
      return new Response(null, { status: 304, headers: { etag } });
    }
    return json(document, 200, { etag, "cache-control": "private, no-cache" });
  });

  const traces = otlpTraces(instance, {
    bearer,
    caps: {
      wire: instance.limits.max_otlp_bytes ?? (DEFAULT_LIMITS.max_otlp_bytes as number),
      inflated:
        instance.limits.max_otlp_inflated_bytes ??
        (DEFAULT_LIMITS.max_otlp_inflated_bytes as number),
    },
  });
  route("POST", "/otlp/v1/traces", ({ request }) => traces(request));

  async function knownSource(id: string, withRecords: boolean): Promise<boolean> {
    if (id === UPLOAD_SOURCE || instance.source(id) !== undefined) return true;
    return withRecords && (await sourcesWithRecords(store)).includes(id);
  }

  function unknownSource(id: string): HttpError {
    return new HttpError(404, "unknown_source", `no source '${id}'`);
  }

  function daysParam(url: URL): number {
    return intParam(url, "days", 7, 90);
  }

  route("GET", "/v1/admin/sources", async ({ request, url }) => {
    await caller(request, "sources:admin");
    const days = daysParam(url);
    const ids = [...instance.config.sources.map((s) => s.id), UPLOAD_SOURCE];
    const sources = [];
    for (const id of ids) sources.push(await instance.sources.status(id, { days }));
    return json({ sources });
  });

  route("GET", "/v1/admin/sources/:id", async ({ request, params, url }) => {
    await caller(request, "sources:admin");
    const id = decodeURIComponent(params.id as string);
    const stored = instance.runtime?.storedSource(id);
    if (!stored && !(await knownSource(id, false))) throw unknownSource(id);
    // A stored source this instance does not run (left out, or not applied yet) has no
    // status here beyond what the bucket says.
    const status =
      stored && instance.source(id) === undefined
        ? {
            id,
            type: String(stored.source.type ?? ""),
            enabled: stored.source.enabled !== false,
            polled: false,
            note: "stored in the bucket; not running on this instance",
            checkpoint: null,
            dropped: 0,
            failed: 0,
            health: {},
          }
        : await instance.sources.status(id, { days: daysParam(url) });
    if (!stored) {
      return json({ ...status, managed: id === UPLOAD_SOURCE ? "builtin" : "file" });
    }
    return json(
      {
        ...status,
        managed: "store",
        config: stored.source,
        updated_at: stored.updated_at,
        etag: stored.etag,
        running: instance.source(id) !== undefined,
      },
      200,
      { etag: `"${stored.etag}"` },
    );
  });

  route("GET", "/v1/admin/sources/:id/:kind", async ({ request, params, url }) => {
    await caller(request, "sources:admin");
    const id = decodeURIComponent(params.id as string);
    const kind = params.kind as string;
    if (kind !== "failed" && kind !== "dropped") {
      throw new HttpError(404, "not_found", `no route ${url.pathname}`);
    }
    if (!(await knownSource(id, true))) throw unknownSource(id);
    const limit = intParam(url, "limit", 50, 1000);
    const after = url.searchParams.get("after") ?? undefined;
    if (after !== undefined && !after.startsWith(keys.records(kind, id))) {
      throw new HttpError(400, "bad_query", `after is not a key of ${id}'s ${kind} records`);
    }
    const sinceParam = url.searchParams.get("since");
    let since: string | undefined;
    if (sinceParam !== null) {
      const at = new Date(sinceParam);
      if (Number.isNaN(at.getTime())) throw new HttpError(400, "bad_query", "since is not a time");
      since = at.toISOString();
    }
    const page = await listRecords(store, kind, id, {
      limit,
      ...(after !== undefined ? { after } : since !== undefined ? { since } : {}),
    });
    return json({ source: id, kind, ...page });
  });

  // The runtime config (server.runtime_config = store, docs/config.md): the data policy in
  // the bucket's config/seshi.toml and the files it names, and sources stored one object each.
  // Each change is checked as a reload would check it, written with the caller's condition,
  // and applied here at once; the other instances apply it within server.config_poll.

  function runtimeOf() {
    if (!instance.runtime) {
      throw new HttpError(
        409,
        "runtime_config_off",
        "this server's config is file-only (server.runtime_config = file): change its config files and reload",
      );
    }
    return instance.runtime;
  }

  function conditionOf(request: Request): WriteCondition {
    const match = request.headers.get("if-match");
    const none = request.headers.get("if-none-match");
    if (match && none) {
      throw new HttpError(400, "bad_header", "send If-Match or If-None-Match, not both");
    }
    if (none !== null && none.trim() !== "*") {
      throw new HttpError(400, "bad_header", "If-None-Match takes * (create only)");
    }
    return {
      ...(match ? { ifMatch: match.trim().replace(/^W\//, "").replace(/^"|"$/g, "") } : {}),
      ...(none !== null ? { ifNoneMatch: "*" as const } : {}),
    };
  }

  const CHANGE_STATUS: Record<RuntimeChangeError["code"], number> = {
    invalid: 422,
    locked: 409,
    file_owned: 409,
    unknown_source: 404,
    no_such_file: 404,
    in_use: 409,
  };

  async function change<T>(write: () => Promise<T>): Promise<T> {
    let result: T;
    try {
      result = await write();
    } catch (err) {
      if (err instanceof RuntimeChangeError) {
        throw new HttpError(CHANGE_STATUS[err.code], err.code, err.message, err.problems);
      }
      if (isPreconditionFailed(err)) {
        throw new HttpError(
          412,
          "precondition_failed",
          "it changed since it was read (or already exists): read it again and redo the change",
        );
      }
      if (err instanceof SealingError) throw new HttpError(422, "sealing", err.message);
      if (err instanceof ConfigError) {
        throw new HttpError(
          422,
          "invalid",
          `the config does not load as it stands: ${err.issues.join("; ")}`,
          err.issues,
        );
      }
      throw err;
    }
    // Written: applied here now if the bucket answers, else by the next poll. A failure to
    // read it back does not make the write a failure.
    await instance.refreshConfig().catch((err) => {
      instance.log.warn(
        `runtime config: written, but not read back yet: ${err instanceof Error ? err.message : err}`,
      );
    });
    return result;
  }

  const check = (config: Parameters<Instance["check"]>[0]) => instance.check(config);

  function quoted(etag: string): Record<string, string> {
    return etag ? { etag: `"${etag}"` } : {};
  }

  function runtimeSettings(): Record<string, unknown> {
    const config = instance.config as unknown as Record<string, unknown>;
    return JSON.parse(
      JSON.stringify(Object.fromEntries(RUNTIME_SECTIONS.map((key) => [key, config[key]]))),
    ) as Record<string, unknown>;
  }

  route("GET", "/v1/admin/config", async ({ request, url }) => {
    await caller(request, "sources:admin");
    if (!instance.runtime) {
      return json({ runtime_config: "file", effective: runtimeSettings() });
    }
    const runtime = instance.runtime;
    await instance.refreshConfig();
    const waitParam = url.searchParams.get("wait");
    let waitMs = 0;
    if (waitParam !== null) {
      const parsed = parseDuration(waitParam);
      if (parsed === undefined) {
        throw new HttpError(400, "bad_query", "wait is a duration such as 10s");
      }
      waitMs = Math.min(parsed, 60_000);
    }
    const freshMs = 3 * runtime.pollMs + 5_000;
    const deadline = now().getTime() + waitMs;
    let instances = await runtime.instances(freshMs);
    while (instances.some((i) => !i.current) && now().getTime() < deadline) {
      await Bun.sleep(500);
      instances = await runtime.instances(freshMs);
    }
    const doc = runtime.doc();
    return json(
      {
        runtime_config: "store",
        version: runtime.version,
        here: instance.configStatus().runtime,
        converged: instances.every((i) => i.current),
        instances,
        doc,
        locked: runtime.locked(),
        effective: runtimeSettings(),
      },
      200,
      quoted(doc.etag ?? ""),
    );
  });

  route("PATCH", "/v1/admin/config", async ({ request }) => {
    await caller(request, "sources:admin");
    const runtime = runtimeOf();
    const condition = conditionOf(request);
    const body = await readJson(request, 1024 * 1024);
    const set = body.set;
    const unset = body.unset;
    if (set !== undefined && (typeof set !== "object" || set === null || Array.isArray(set))) {
      throw new HttpError(400, "bad_field", "set maps dotted paths to values");
    }
    if (
      unset !== undefined &&
      (!Array.isArray(unset) || !unset.every((u) => typeof u === "string"))
    ) {
      throw new HttpError(400, "bad_field", "unset lists dotted paths");
    }
    const { etag } = await change(() =>
      runtime.patchDoc(
        {
          ...(set ? { set: set as Record<string, unknown> } : {}),
          ...(unset ? { unset: unset as string[] } : {}),
        },
        condition,
        check,
      ),
    );
    return json({ etag, version: runtime.version }, 200, quoted(etag));
  });

  route("PUT", "/v1/admin/config/files/*name", async ({ request, params }) => {
    await caller(request, "sources:admin");
    const runtime = runtimeOf();
    const name = decodeURIComponent(params.name as string);
    const condition = conditionOf(request);
    const body = await readBody(request, 1024 * 1024);
    const { etag } = await change(() => runtime.putFile(name, body, condition, check));
    return json({ name, etag, version: runtime.version }, 200, quoted(etag));
  });

  route("DELETE", "/v1/admin/config/files/*name", async ({ request, params }) => {
    await caller(request, "sources:admin");
    const runtime = runtimeOf();
    const name = decodeURIComponent(params.name as string);
    const condition = conditionOf(request);
    await change(() => runtime.deleteFile(name, condition, check));
    return json({ name, deleted: true, version: runtime.version });
  });

  function storedSourceId(raw: string): string {
    const id = decodeURIComponent(raw);
    if (id === UPLOAD_SOURCE || !sourceId.safeParse(id).success) {
      throw new HttpError(
        400,
        "bad_id",
        "a source id is lower-case letters and digits, words joined by single -, up to 63 characters, and not 'upload'",
      );
    }
    return id;
  }

  route("PUT", "/v1/admin/sources/:id", async ({ request, params }) => {
    const principal = await caller(request, "sources:admin");
    const runtime = runtimeOf();
    const id = storedSourceId(params.id as string);
    const condition = conditionOf(request);
    const body = await readJson(request, 1024 * 1024);
    const { etag, created } = await change(() =>
      runtime.putSource(id, body, condition, check, principal.owner),
    );
    const stored = runtime.storedSource(id);
    return json(
      { id, etag, source: stored?.source, version: runtime.version },
      created ? 201 : 200,
      quoted(etag),
    );
  });

  route("DELETE", "/v1/admin/sources/:id", async ({ request, params }) => {
    await caller(request, "sources:admin");
    const runtime = runtimeOf();
    const id = storedSourceId(params.id as string);
    const condition = conditionOf(request);
    await change(() => runtime.deleteSource(id, condition));
    return json({ id, deleted: true, version: runtime.version });
  });

  route("POST", "/v1/admin/secrets/reseal", async ({ request }) => {
    await caller(request, "sources:admin");
    const runtime = runtimeOf();
    const result = await change(() => runtime.reseal());
    return json({ key_id: runtime.keyring.current ?? null, ...result });
  });

  const handle = dispatch(routes);
  async function fetch(request: Request): Promise<Response> {
    // Health answers at once, whatever the bucket is doing.
    if (new URL(request.url).pathname !== "/healthz") await instance.freshen();
    return handle(request);
  }

  return { fetch, auth, pipeline };
}

function dispatch(routes: readonly Route[]): (request: Request) => Promise<Response> {
  return async function fetch(request: Request): Promise<Response> {
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
        if (err instanceof HttpError) return error(err.status, err.code, err.message, err.problems);
        if (err instanceof Unauthorized) return error(401, err.code, err.message);
        if (err instanceof Forbidden) return error(403, err.code, err.message);
        if (err instanceof StoreError) {
          return error(502, "storage_error", `storage failed: ${err.message}`);
        }
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[seshi] ${request.method} ${url.pathname}: ${message}`);
        return error(500, "internal", "internal error");
      }
    }
    return pathMatched
      ? error(405, "method_not_allowed", `${request.method} not allowed`)
      : error(404, "not_found", `no route ${url.pathname}`);
  };
}

export type App = ReturnType<typeof createApp>;
