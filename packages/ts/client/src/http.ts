import { gzipSync } from "node:zlib";
import {
  type AllChangesPage,
  type ChangesPage,
  type Fetch,
  Forbidden,
  type Identity,
  type IngestOptions,
  type ListSessionsOptions,
  OffsetMismatch,
  type ReadChangesOptions,
  type RenderFormat,
  type SearchRequest,
  type SearchResults,
  type Seshi,
  SessionConflict,
  SessionExcluded,
  type SessionMetadata,
  SessionRejected,
  type SessionsPage,
  type StaleSessionsPage,
  type StoredTrace,
  StoreError,
  type StoreSessionResult,
  type Upload,
  VERSION,
  type Visibility,
} from "@seshi/model";
import type {
  AuthConfig,
  ConfigStatus,
  ExchangeRequest,
  ExchangeResult,
  JobsStatus,
  OwnersPage,
  RecordKind,
  RecordsPage,
  ReloadReport,
  ReviewDecision,
  RuntimeConfigStatus,
  SourceDetail,
  SourceStatus,
  TokenInfo,
  TokenKind,
  TokenRequest,
  WriteCondition,
} from "./types";

/** How a client reaches the server, with or without a credential. */
export interface TransportOptions {
  /** The server's base URL (`https://seshi.example.com`). */
  server: string;
  /** For tests and custom transports: defaults to the global `fetch`. */
  fetch?: Fetch;
  /** Per request; a large transcript can take the server a while to normalize and verify.
   * Default 120 s, the server's own idle timeout. 0 disables. */
  timeoutMs?: number;
  /** Sent as `User-Agent`, so a server's logs say which program called
   * (`dosu-cli/0.68.5`). Default `@dosu/seshi-client/<version>`; the seshi CLI sends
   * `seshi/<version>`. */
  userAgent?: string;
}

export interface HttpClientOptions extends TransportOptions {
  token: string;
  /** With the org key (X5.12): the username to write as, sent as `X-Seshi-User`. The CLI
   * resolves it from SESHI_USER, the CLI config's `user`, git's user.email, then the OS user
   * name (X5.7). Other credentials name their owner themselves. */
  user?: string;
  /** Bodies past this many bytes are sent `Content-Encoding: gzip`. Default 8 KiB. */
  gzipFrom?: number;
}

/** The header a retraction carries its secret in (F9.7). */
export const RETRACT_HEADER = "x-seshi-retract";

/** Whose session a read or change is about: the caller's own when `owner` is omitted. A member
 * reads another owner's sessions as far as visibility allows (X5.10). */
export interface OwnerOption {
  owner?: string;
}

/** A response the server gave that is not one of the pipeline's own refusals: unauthorized, a
 * bad request, an internal error, a route that is not there. */
export class ServerError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ServerError";
  }
}

/** A conditional runtime config write whose condition did not hold: it changed since its ETag
 * was read, or exists when created. Read it again and redo the change. */
export class PreconditionFailed extends Error {
  readonly code = "precondition_failed";
  constructor(message: string) {
    super(message);
    this.name = "PreconditionFailed";
  }
}

/** A runtime config change the server refused before writing anything (`invalid`, `sealing`),
 * with each problem. */
export class ConfigRejected extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly problems: string[],
  ) {
    super(message);
    this.name = "ConfigRejected";
  }
}

interface ErrorBody {
  error?: { code?: string; message?: string; expected?: number; problems?: string[] };
}

interface RequestOptions {
  body?: unknown;
  /** Sent as it is (`application/octet-stream`), instead of `body` as JSON. */
  content?: Uint8Array;
  query?: Record<string, string | number | boolean | readonly string[] | undefined>;
  headers?: Record<string, string>;
  gzipFrom?: number;
}

interface Answer {
  status: number;
  body: unknown;
  headers: Headers;
}

async function send(
  transport: TransportOptions,
  method: string,
  path: string,
  options: RequestOptions = {},
): Promise<Answer> {
  const server = transport.server.replace(/\/+$/, "");
  const fetchImpl = transport.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const timeoutMs = transport.timeoutMs ?? 120_000;
  const url = new URL(`${server}${path}`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (Array.isArray(value)) for (const item of value) url.searchParams.append(key, String(item));
    else if (value !== undefined) url.searchParams.set(key, String(value));
  }
  const headers: Record<string, string> = {
    "user-agent": transport.userAgent ?? `@dosu/seshi-client/${VERSION}`,
    ...options.headers,
  };
  let body: BodyInit | undefined;
  if (options.content !== undefined) {
    headers["content-type"] = "application/octet-stream";
    body = new Uint8Array(options.content);
  } else if (options.body !== undefined) {
    headers["content-type"] = "application/json";
    const json = new TextEncoder().encode(JSON.stringify(options.body));
    if (json.length >= (options.gzipFrom ?? Number.POSITIVE_INFINITY)) {
      headers["content-encoding"] = "gzip";
      body = new Uint8Array(gzipSync(json));
    } else {
      body = json;
    }
  }
  let response: Response;
  try {
    response = await fetchImpl(url.toString(), {
      method,
      headers,
      body,
      ...(timeoutMs > 0 ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new StoreError(`cannot reach ${server}: ${reason}`, err);
  }
  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      if (response.ok) {
        throw new ServerError(response.status, "bad_response", `not JSON: ${text.slice(0, 200)}`);
      }
    }
  }
  return { status: response.status, body: parsed, headers: response.headers };
}

function errorCode(body: unknown): string | undefined {
  return (body as ErrorBody | null)?.error?.code;
}

function refuse(status: number, body: unknown, offset = 0): never {
  const error = (body as ErrorBody | null)?.error ?? {};
  const code = error.code ?? "unknown";
  const message = error.message ?? `HTTP ${status}`;
  if (status === 409 && code === "offset_mismatch") {
    throw new OffsetMismatch(offset, error.expected ?? 0);
  }
  if (status === 409 && code === "conflict") throw new SessionConflict(message);
  if (status === 403 && code === "forbidden") throw new Forbidden(message);
  if (status === 403 && code === "excluded") throw new SessionExcluded(message);
  if (status === 422) throw new SessionRejected(code, message);
  if (status === 502) throw new StoreError(message);
  throw new ServerError(status, code, message);
}

/** A runtime config write's refusal: 412 and 422 as their own errors, the rest as `refuse`. */
function refuseChange(status: number, body: unknown): never {
  const error = (body as ErrorBody | null)?.error ?? {};
  const message = error.message ?? `HTTP ${status}`;
  if (status === 412) throw new PreconditionFailed(message);
  if (status === 422)
    throw new ConfigRejected(error.code ?? "invalid", message, error.problems ?? []);
  refuse(status, body);
}

function conditionHeaders(condition: WriteCondition = {}): Record<string, string> {
  if (condition.ifMatch !== undefined && condition.create) {
    throw new TypeError("pass ifMatch or create, not both");
  }
  if (condition.ifMatch !== undefined) {
    return {
      "if-match": condition.ifMatch.startsWith('"') ? condition.ifMatch : `"${condition.ifMatch}"`,
    };
  }
  return condition.create ? { "if-none-match": "*" } : {};
}

/** `GET /v1/auth/config`: whether the server takes the org key and which IdP it signs in
 * through (X5.7). Needs no credential. */
export async function authConfig(transport: TransportOptions): Promise<AuthConfig> {
  const { status, body } = await send(transport, "GET", "/v1/auth/config");
  if (status !== 200) refuse(status, body);
  return body as AuthConfig;
}

/** `POST /v1/auth/exchange`: an IdP ID token for a session token, and a device token when the
 * request names a machine (X5.2). Needs no credential; a token the server does not accept is
 * `ServerError` 401, a server without an IdP 404 `no_idp`. */
export async function exchangeIdToken(
  transport: TransportOptions,
  request: ExchangeRequest,
): Promise<ExchangeResult> {
  const { status, body } = await send(transport, "POST", "/v1/auth/exchange", { body: request });
  if (status !== 200) refuse(status, body);
  return body as ExchangeResult;
}

/** The server's API over `fetch`. Every refusal the server maps to a status comes back as the
 * error the pipeline would have thrown. */
export class HttpSeshi implements Seshi {
  readonly server: string;
  private readonly token: string;
  private readonly user: string | undefined;
  private readonly transport: TransportOptions;
  private readonly gzipFrom: number;

  constructor(options: HttpClientOptions) {
    this.server = options.server.replace(/\/+$/, "");
    this.token = options.token;
    this.user = options.user;
    this.gzipFrom = options.gzipFrom ?? 8 * 1024;
    this.transport = {
      server: this.server,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.userAgent !== undefined ? { userAgent: options.userAgent } : {}),
    };
  }

  private request(method: string, path: string, options: RequestOptions = {}): Promise<Answer> {
    return send(this.transport, method, path, {
      ...options,
      gzipFrom: this.gzipFrom,
      headers: {
        ...options.headers,
        authorization: `Bearer ${this.token}`,
        ...(this.user !== undefined ? { "x-seshi-user": this.user } : {}),
      },
    });
  }

  /** `POST /v1/sessions`. With `retractSecret` (for a `replace` with the org key) the secret
   * goes in `X-Seshi-Retract`, never the body. */
  async ingest(upload: Upload, options: IngestOptions = {}): Promise<StoreSessionResult> {
    const { status, body } = await this.request("POST", "/v1/sessions", {
      body: upload,
      ...(options.retractSecret !== undefined
        ? { headers: { [RETRACT_HEADER]: options.retractSecret } }
        : {}),
    });
    if (status !== 200 && status !== 201) refuse(status, body, upload.offset ?? 0);
    return body as StoreSessionResult;
  }

  private sessionPath(format: string, sessionId: string): string {
    return `/v1/sessions/${encodeURIComponent(format)}/${encodeURIComponent(sessionId)}`;
  }

  /** The session's metadata; null for one not stored, or one the caller may not read. */
  async getSession(
    format: string,
    sessionId: string,
    options: OwnerOption = {},
  ): Promise<SessionMetadata | null> {
    const { status, body } = await this.request("GET", this.sessionPath(format, sessionId), {
      query: { owner: options.owner },
    });
    if (status === 404) return null;
    if (status !== 200) refuse(status, body);
    return body as SessionMetadata;
  }

  /** The head trace, or `hash`, rendered as `render`; null for a session not stored,
   * unreadable or redacted. */
  async getTrace(
    format: string,
    sessionId: string,
    hash?: string,
    render?: RenderFormat,
    options: OwnerOption = {},
  ): Promise<StoredTrace | null> {
    const { status, body } = await this.request(
      "GET",
      `${this.sessionPath(format, sessionId)}/trace`,
      { query: { hash, render, owner: options.owner } },
    );
    if (status === 404 || status === 410) return null;
    if (status !== 200) refuse(status, body);
    return body as StoredTrace;
  }

  private archivePath(owner: string, archiveId: string): string {
    return `/v1/owners/${encodeURIComponent(owner)}/sessions/${encodeURIComponent(archiveId)}`;
  }

  /** The session's metadata by its owner and archive id, as change entries, search results and
   * listings name it (that owner's folder exactly); null when not stored or not readable. */
  async getSessionByArchive(owner: string, archiveId: string): Promise<SessionMetadata | null> {
    const { status, body } = await this.request("GET", this.archivePath(owner, archiveId));
    if (status === 404) return null;
    if (status !== 200) refuse(status, body);
    return body as SessionMetadata;
  }

  /** `getTrace` by owner and archive id. */
  async getTraceByArchive(
    owner: string,
    archiveId: string,
    hash?: string,
    render?: RenderFormat,
  ): Promise<StoredTrace | null> {
    const { status, body } = await this.request(
      "GET",
      `${this.archivePath(owner, archiveId)}/trace`,
      { query: { hash, render } },
    );
    if (status === 404 || status === 410) return null;
    if (status !== 200) refuse(status, body);
    return body as StoredTrace;
  }

  /** `reviews` by owner and archive id. */
  async reviewsByArchive(owner: string, archiveId: string): Promise<ReviewDecision[] | null> {
    const { status, body } = await this.request(
      "GET",
      `${this.archivePath(owner, archiveId)}/reviews`,
    );
    if (status === 404) return null;
    if (status !== 200) refuse(status, body);
    return (body as { reviews: ReviewDecision[] }).reviews;
  }

  async listSessions(options: ListSessionsOptions = {}): Promise<SessionsPage> {
    const { status, body } = await this.request("GET", "/v1/sessions", {
      query: { after: options.after, limit: options.limit, owner: options.owner },
    });
    if (status !== 200) refuse(status, body);
    return body as SessionsPage;
  }

  /** `GET /v1/sessions/stale`: the caller's own sessions an older normalizer built (X4.9), a
   * page at a time. Needs `sessions:write`, which the uploader's credential has. */
  async staleSessions(
    options: { after?: string; limit?: number } = {},
  ): Promise<StaleSessionsPage> {
    const { status, body } = await this.request("GET", "/v1/sessions/stale", {
      query: { after: options.after, limit: options.limit },
    });
    if (status !== 200) refuse(status, body);
    return body as StaleSessionsPage;
  }

  /** Delete the session: a tombstone in its owner's change feed (X5.3); null for one not
   * stored. Needs `sessions:delete`, and with an IdP a session token under 10 minutes old.
   * With `retractSecret` it is a retraction instead (F9.7): the machine that uploaded the
   * session proves it with the secret whose hash it sent, using its normal upload credential
   * (`sessions:write`), and the tombstone says `retracted`. A refused retraction is
   * `ServerError` 403 `bad_retract_secret` or `retract_disabled`. */
  async tombstone(
    format: string,
    sessionId: string,
    options: OwnerOption & { retractSecret?: string } = {},
  ): Promise<{ removed: number } | null> {
    const { status, body } = await this.request("DELETE", this.sessionPath(format, sessionId), {
      query: { owner: options.owner },
      ...(options.retractSecret !== undefined
        ? { headers: { [RETRACT_HEADER]: options.retractSecret } }
        : {}),
    });
    if (status === 404) return null;
    if (status !== 200) refuse(status, body);
    return body as { removed: number };
  }

  /** Change who may read a session (X5.10); the metadata as it now is, null for one not
   * stored. A redacted session is `ServerError` 410. The owner or an admin may. */
  async setVisibility(
    format: string,
    sessionId: string,
    visibility: Visibility,
    options: OwnerOption = {},
  ): Promise<SessionMetadata | null> {
    const { status, body } = await this.request("PATCH", this.sessionPath(format, sessionId), {
      body: { visibility },
      query: { owner: options.owner },
    });
    if (status === 404) return null;
    if (status !== 200) refuse(status, body);
    return body as SessionMetadata;
  }

  /** What model review decided for each stored write of the session, oldest first (F3.8,
   * `GET …/reviews`): the whole audit record for admins, only `n`, `at`, `content_hash` and
   * `decision` for anyone else who may read it. Null for a session not stored. */
  async reviews(
    format: string,
    sessionId: string,
    options: OwnerOption = {},
  ): Promise<ReviewDecision[] | null> {
    const { status, body } = await this.request(
      "GET",
      `${this.sessionPath(format, sessionId)}/reviews`,
      { query: { owner: options.owner } },
    );
    if (status === 404) return null;
    if (status !== 200) refuse(status, body);
    return (body as { reviews: ReviewDecision[] }).reviews;
  }

  async changes(options: ReadChangesOptions = {}): Promise<ChangesPage> {
    const { status, body } = await this.request("GET", "/v1/changes", {
      query: { after: options.after, since: options.since, limit: options.limit },
    });
    if (status !== 200) refuse(status, body);
    return body as ChangesPage;
  }

  /** Every owner's change feed as one (`GET /v1/changes/all`), by stamp, then owner, then
   * key; each entry names its owner. Only for a credential that reads every session (a
   * service token or an admin): any other is `Forbidden`. `after` is the last page's opaque
   * `cursor`. While the server's search index is first being built it is a `ServerError` with
   * status 503 (`index_building`), and 404 (`search_disabled`) when search is turned off. */
  async allChanges(options: ReadChangesOptions = {}): Promise<AllChangesPage> {
    const { status, body } = await this.request("GET", "/v1/changes/all", {
      query: { after: options.after, since: options.since, limit: options.limit },
    });
    if (status !== 200) refuse(status, body);
    return body as AllChangesPage;
  }

  /** Keyword search over the sessions this credential may read (F10, `GET /v1/search`). A
   * request the server cannot run is a `ServerError` with status 400 (`bad_query`); while the
   * server's index is first being built, status 503 (`index_building`), and 404
   * (`search_disabled`) when the server has search turned off. */
  async search(request: SearchRequest): Promise<SearchResults> {
    const { status, body } = await this.request("GET", "/v1/search", {
      query: {
        q: request.q,
        owner: request.owner,
        agent: request.agent,
        repo: request.repo,
        branch: request.branch,
        harness: request.harness,
        agent_version: request.agent_version,
        model: request.model,
        label: Object.entries(request.labels ?? {}).map(([key, value]) => `${key}=${value}`),
        source: request.source,
        since: request.since,
        until: request.until,
        sort: request.sort,
        limit: request.limit,
        matches: request.matches,
        cursor: request.cursor,
      },
    });
    if (status !== 200) refuse(status, body);
    return body as SearchResults;
  }

  async me(): Promise<Identity> {
    const { status, body } = await this.request("GET", "/v1/me");
    if (status !== 200) refuse(status, body);
    return body as Identity;
  }

  /** The org's redaction rule packs (`GET /v1/redaction/rules`, F2.4), for redacting before
   * upload: a `seshi/redaction-rules/1` document, unchecked. `@seshi/redact`'s
   * `ruleSetFromDocument` validates it and builds the rule set. */
  async redactionRules(): Promise<unknown> {
    const { status, body } = await this.request("GET", "/v1/redaction/rules");
    if (status !== 200) refuse(status, body);
    return body;
  }

  /** `redactionRules` with HTTP caching, for a client that keeps the document between runs:
   * `etag`, from an earlier answer, goes as If-None-Match. `null` means the rule set has not
   * changed since; otherwise the document comes back with its own ETag. */
  async redactionRulesSince(
    etag?: string,
  ): Promise<{ document: unknown; etag: string | undefined } | null> {
    const { status, body, headers } = await this.request("GET", "/v1/redaction/rules", {
      ...(etag ? { headers: { "if-none-match": etag } } : {}),
    });
    if (status === 304 && etag) return null;
    if (status !== 200) refuse(status, body);
    return { document: body, etag: headers.get("etag") ?? undefined };
  }

  /** The org's capture rules (`GET /v1/capture/rules`): the server's exclude list, which a
   * laptop applies before upload, with HTTP caching as `redactionRulesSince`. `null` means the
   * list has not changed since `etag`; a server older than the route answers 404 (`ServerError`). */
  async captureRulesSince(
    etag?: string,
  ): Promise<{ document: unknown; etag: string | undefined } | null> {
    const { status, body, headers } = await this.request("GET", "/v1/capture/rules", {
      ...(etag ? { headers: { "if-none-match": etag } } : {}),
    });
    if (status === 304 && etag) return null;
    if (status !== 200) refuse(status, body);
    return { document: body, etag: headers.get("etag") ?? undefined };
  }

  /** The owners with sessions stored. */
  async owners(options: { after?: string; limit?: number } = {}): Promise<OwnersPage> {
    const { status, body } = await this.request("GET", "/v1/owners", {
      query: { after: options.after, limit: options.limit },
    });
    if (status !== 200) refuse(status, body);
    return body as OwnersPage;
  }

  /** Issue a token; its secret is in the answer only. */
  async createToken(request: TokenRequest): Promise<{ token: string; record: TokenInfo }> {
    const { status, body } = await this.request("POST", "/v1/tokens", { body: request });
    if (status !== 201) refuse(status, body);
    return body as { token: string; record: TokenInfo };
  }

  /** Live tokens, or every one with `all`. */
  async listTokens(
    filter: { owner?: string; kind?: TokenKind; all?: boolean } = {},
  ): Promise<TokenInfo[]> {
    const { status, body } = await this.request("GET", "/v1/tokens", {
      query: { owner: filter.owner, kind: filter.kind, all: filter.all ? "true" : undefined },
    });
    if (status !== 200) refuse(status, body);
    return (body as { tokens: TokenInfo[] }).tokens;
  }

  /** Revoke one token; null for an unknown id. */
  async revokeToken(id: string): Promise<TokenInfo | null> {
    const { status, body } = await this.request("DELETE", `/v1/tokens/${encodeURIComponent(id)}`);
    if (status === 404) return null;
    if (status !== 200) refuse(status, body);
    return (body as { token: TokenInfo }).token;
  }

  /** Revoke every token of an owner (offboarding, X5.11), or every one of a kind. */
  async revokeOwnerTokens(owner: string, kind?: TokenKind): Promise<TokenInfo[]> {
    const { status, body } = await this.request("POST", "/v1/tokens/revoke", {
      body: { owner, ...(kind ? { kind } : {}) },
    });
    if (status !== 200) refuse(status, body);
    return (body as { revoked: TokenInfo[] }).revoked;
  }

  /** The worker, its jobs and every source. */
  async jobs(): Promise<JobsStatus> {
    const { status, body } = await this.request("GET", "/v1/admin/jobs");
    if (status !== 200) refuse(status, body);
    return body as JobsStatus;
  }

  /** The running config's generation, hash and rule set, and how the last reload went. */
  async configStatus(): Promise<ConfigStatus> {
    const { status, body } = await this.request("GET", "/v1/admin/reload");
    if (status !== 200) refuse(status, body);
    return body as ConfigStatus;
  }

  /** Have the server read its config files again and apply them (all or nothing). A rejected
   * reload is returned, not thrown: its `errors` say why, and the running config stays. */
  async reload(): Promise<{ reload: ReloadReport; config: ConfigStatus }> {
    const { status, body } = await this.request("POST", "/v1/admin/reload");
    const answer = body as { reload?: ReloadReport; config?: ConfigStatus } | null;
    if ((status === 200 || status === 422) && answer?.reload && answer.config) {
      return { reload: answer.reload, config: answer.config };
    }
    refuse(status, body);
  }

  /** Every configured source and `upload`: checkpoints, record counts, health over `days`. */
  async sources(options: { days?: number } = {}): Promise<SourceStatus[]> {
    const { status, body } = await this.request("GET", "/v1/admin/sources", {
      query: { days: options.days },
    });
    if (status !== 200) refuse(status, body);
    return (body as { sources: SourceStatus[] }).sources;
  }

  /** One source's status; null for an unknown source. */
  async source(id: string, options: { days?: number } = {}): Promise<SourceDetail | null> {
    const { status, body } = await this.request(
      "GET",
      `/v1/admin/sources/${encodeURIComponent(id)}`,
      { query: { days: options.days } },
    );
    if (status === 404 && errorCode(body) === "unknown_source") return null;
    if (status !== 200) refuse(status, body);
    return body as SourceDetail;
  }

  /** A source's failure or drop records, oldest first (X6.4); null for an unknown source. */
  async records(
    kind: RecordKind,
    id: string,
    options: { since?: string; after?: string; limit?: number } = {},
  ): Promise<RecordsPage | null> {
    const { status, body } = await this.request(
      "GET",
      `/v1/admin/sources/${encodeURIComponent(id)}/${kind}`,
      { query: { since: options.since, after: options.after, limit: options.limit } },
    );
    if (status === 404 && errorCode(body) === "unknown_source") return null;
    if (status !== 200) refuse(status, body);
    return body as RecordsPage;
  }

  // The runtime config (server.runtime_config = store; docs/config.md, "Runtime config in the
  // bucket"). Each write is checked as a reload would check it before anything is written
  // (`ConfigRejected`), made under its condition (`PreconditionFailed`), and applied on the
  // server that took it at once; the other instances apply it within `server.config_poll`.

  /** The bucket's runtime config, its version, the settings the files lock, and which live
   * instances run it; `wait` (`"30s"`) waits for them all to. */
  async runtimeConfig(options: { wait?: string } = {}): Promise<RuntimeConfigStatus> {
    const { status, body } = await this.request("GET", "/v1/admin/config", {
      query: { wait: options.wait },
    });
    if (status !== 200) refuse(status, body);
    return body as RuntimeConfigStatus;
  }

  /** Change data-policy settings in `config/seshi.toml`: `set` maps dotted paths to values,
   * `unset` removes paths. */
  async patchRuntimeConfig(
    change: { set?: Record<string, unknown>; unset?: string[] },
    condition: WriteCondition = {},
  ): Promise<{ etag: string; version: string }> {
    const { status, body } = await this.request("PATCH", "/v1/admin/config", {
      body: change,
      headers: conditionHeaders(condition),
    });
    if (status !== 200) refuseChange(status, body);
    return body as { etag: string; version: string };
  }

  /** Write a file under `config/` (`packs/org.json`), checked when the doc names it. */
  async putConfigFile(
    name: string,
    content: Uint8Array | string,
    condition: WriteCondition = {},
  ): Promise<{ name: string; etag?: string; version: string }> {
    const { status, body } = await this.request(
      "PUT",
      `/v1/admin/config/files/${encodeURIComponent(name)}`,
      {
        content: typeof content === "string" ? new TextEncoder().encode(content) : content,
        headers: conditionHeaders(condition),
      },
    );
    if (status !== 200) refuseChange(status, body);
    return body as { name: string; etag?: string; version: string };
  }

  /** Remove a file under `config/`; null when there is none. */
  async deleteConfigFile(
    name: string,
    condition: { ifMatch?: string } = {},
  ): Promise<{ name: string; deleted: boolean; version: string } | null> {
    const { status, body } = await this.request(
      "DELETE",
      `/v1/admin/config/files/${encodeURIComponent(name)}`,
      { headers: conditionHeaders(condition) },
    );
    if (status === 404 && errorCode(body) === "no_such_file") return null;
    if (status !== 200) refuseChange(status, body);
    return body as { name: string; deleted: boolean; version: string };
  }

  /** Store source `id` in the bucket: its settings as in `[[sources]]`. Secret values are
   * sealed and never returned; one left out keeps its sealed value when the type stays. */
  async putSource(
    id: string,
    source: Record<string, unknown>,
    condition: WriteCondition = {},
  ): Promise<{ id: string; etag: string; source: Record<string, unknown>; version: string }> {
    const { status, body } = await this.request(
      "PUT",
      `/v1/admin/sources/${encodeURIComponent(id)}`,
      { body: source, headers: conditionHeaders(condition) },
    );
    if (status !== 200 && status !== 201) refuseChange(status, body);
    return body as { id: string; etag: string; source: Record<string, unknown>; version: string };
  }

  /** Remove a stored source; null when there is none. Its sessions and checkpoint stay. */
  async deleteSource(
    id: string,
    condition: { ifMatch?: string } = {},
  ): Promise<{ id: string; deleted: boolean; version: string } | null> {
    const { status, body } = await this.request(
      "DELETE",
      `/v1/admin/sources/${encodeURIComponent(id)}`,
      { headers: conditionHeaders(condition) },
    );
    if (status === 404 && errorCode(body) === "unknown_source") return null;
    if (status !== 200) refuseChange(status, body);
    return body as { id: string; deleted: boolean; version: string };
  }

  /** Seal every stored source's secrets again with `secrets.key_id`'s key. */
  async resealSecrets(): Promise<{
    key_id: string | null;
    resealed: string[];
    changed: string[];
    current: string[];
  }> {
    const { status, body } = await this.request("POST", "/v1/admin/secrets/reseal");
    if (status !== 200) refuseChange(status, body);
    return body as {
      key_id: string | null;
      resealed: string[];
      changed: string[];
      current: string[];
    };
  }
}
