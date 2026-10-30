/** One client API, two backends.
 *
 * `connect({ store, owner })` writes a store directly: the transcript is redacted and
 * normalized here, on the machine that calls, and the bucket is written with that machine's
 * credential. Nothing else is involved: serverless. `connect({ server, token })` posts the
 * transcript to a sessiondb server, which runs the same pipeline against the bucket it owns,
 * under the owner the token names. Either way the calls, their results and what they throw are
 * the same, so a program (the CLI, a harness hook) picks a backend from its configuration and
 * is otherwise indifferent.
 *
 * What differs is who holds what: the store backend puts a bucket credential on the laptop and
 * makes redaction a library the laptop runs; the server backend keeps the credential and the
 * redaction on the server, and sees the transcript before redaction. One person with their own
 * bucket wants the first; a team wants the second. */

import { gzipSync } from "node:zlib";
import { OffsetMismatch, SessionRejected } from "./ingest/errors";
import { getSession, getTrace, listSessions, tombstone } from "./ingest/ingest";
import { type SessionUpload, type StoreSessionResult, storeSession } from "./ingest/session";
import type { SessionMetadata } from "./schemas/store";
import type { Trace } from "./schemas/trace";
import { type ChangesPage, type ReadChangesOptions, readChanges } from "./store/changes";
import { archiveId, assertOwner } from "./store/layout";
import { type OpenStoreOptions, openStore, type StorageView } from "./store/open";
import { ensureLayout, probe } from "./store/publish";
import { type Store, StoreError } from "./store/store";
import { VERSION } from "./version";

/** A session to store: `SessionUpload` without the owner, which the backend knows. `format`
 * defaults to `jsonl`. */
export type Upload = Omit<SessionUpload, "owner" | "format"> & { format?: SessionUpload["format"] };

export interface ListSessionsOptions {
  /** The cursor from the last page. */
  after?: string;
  limit?: number;
}

export interface SessionsPage {
  sessions: SessionMetadata[];
  cursor: string | undefined;
  truncated: boolean;
}

export interface Identity {
  owner: string;
  /** Where the sessions go, as a reader would need to know it. */
  storage: StorageView;
}

export interface SessionDB {
  /** Store a session, whole or as a chunk from `offset`. Throws `SessionRejected` for a
   * transcript that cannot be stored, `OffsetMismatch` for a chunk that does not start where
   * the log ends, `StoreError` when the store fails. */
  ingest(upload: Upload): Promise<StoreSessionResult>;
  /** The session's pointer, or null for one not stored. */
  getSession(agent: string, sessionId: string): Promise<SessionMetadata | null>;
  /** The head trace, or the one named by `hash`; null for a session not stored, stored raw
   * only, or redacted. */
  getTrace(agent: string, sessionId: string, hash?: string): Promise<Trace | null>;
  listSessions(options?: ListSessionsOptions): Promise<SessionsPage>;
  /** Drop the session's objects and append a tombstone; null for one not stored. */
  tombstone(agent: string, sessionId: string): Promise<{ removed: number } | null>;
  /** The change feed after a cursor. */
  changes(options?: ReadChangesOptions): Promise<ChangesPage>;
  /** Who this client is and where its sessions go. */
  me(): Promise<Identity>;
}

// --- over a store ----------------------------------------------------------------------------

export interface StoreClientOptions {
  store: Store;
  owner: string;
  /** What `me()` reports as the store's location; derived from the store's URL when omitted. */
  storage?: StorageView;
  /** Identifies this writer in the layout marker (`sessiondb-cli/0.2.0`). */
  client?: string;
  now?: () => Date;
}

/** The pipeline over a `Store`, scoped to one owner. */
export class StoreSessionDB implements SessionDB {
  readonly owner: string;
  readonly store: Store;
  private readonly storage: StorageView;
  private readonly client: string;
  private readonly now: () => Date;

  constructor(options: StoreClientOptions) {
    this.owner = assertOwner(options.owner);
    this.store = options.store;
    this.storage = options.storage ?? { url: options.store.url };
    this.client = options.client ?? `@dosu-ai/sessiondb/${VERSION}`;
    this.now = options.now ?? (() => new Date());
  }

  /** Write the layout marker and this owner's probe, so a wrong bucket or key fails here and
   * not on the first session. */
  async check(): Promise<void> {
    await ensureLayout(this.store, this.client);
    await probe(this.store, this.owner);
  }

  ingest(upload: Upload): Promise<StoreSessionResult> {
    return storeSession(
      { ...upload, format: upload.format ?? "jsonl", owner: this.owner },
      { store: this.store, client: this.client, now: this.now },
    );
  }

  getSession(agent: string, sessionId: string): Promise<SessionMetadata | null> {
    return getSession(this.store, this.owner, agent, sessionId);
  }

  async getTrace(agent: string, sessionId: string, hash?: string): Promise<Trace | null> {
    const metadata = await this.getSession(agent, sessionId);
    if (!metadata || metadata.status === "redacted") return null;
    const wanted = hash ?? metadata.head;
    if (!wanted) return null;
    return getTrace(this.store, this.owner, archiveId(this.owner, agent, sessionId), wanted);
  }

  listSessions(options: ListSessionsOptions = {}): Promise<SessionsPage> {
    return listSessions(this.store, this.owner, {
      startAfter: options.after,
      limit: options.limit,
    });
  }

  tombstone(agent: string, sessionId: string): Promise<{ removed: number } | null> {
    return tombstone({
      store: this.store,
      owner: this.owner,
      agent,
      session_id: sessionId,
      now: this.now,
    });
  }

  changes(options: ReadChangesOptions = {}): Promise<ChangesPage> {
    return readChanges(this.store, this.owner, options);
  }

  async me(): Promise<Identity> {
    return { owner: this.owner, storage: this.storage };
  }
}

// --- over a server ---------------------------------------------------------------------------

/** The shape of `fetch` the HTTP backend needs: a URL and an init to a `Response`. */
export type Fetch = (input: URL | string, init?: RequestInit) => Promise<Response>;

export interface HttpClientOptions {
  /** The server's base URL (`https://sessiondb.example.com`). */
  server: string;
  token: string;
  /** For tests and custom transports: defaults to the global `fetch`. */
  fetch?: Fetch;
  /** Bodies past this many bytes are sent `Content-Encoding: gzip`. Default 8 KiB. */
  gzipFrom?: number;
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

interface ErrorBody {
  error?: { code?: string; message?: string; expected?: number };
}

/** The server's API over `fetch`. Every refusal the server maps to a status comes back as the
 * error the pipeline would have thrown. */
export class HttpSessionDB implements SessionDB {
  readonly server: string;
  private readonly token: string;
  private readonly fetch: Fetch;
  private readonly gzipFrom: number;

  constructor(options: HttpClientOptions) {
    this.server = options.server.replace(/\/+$/, "");
    this.token = options.token;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.gzipFrom = options.gzipFrom ?? 8 * 1024;
  }

  private async request(
    method: string,
    path: string,
    options: { body?: unknown; query?: Record<string, string | number | undefined> } = {},
  ): Promise<{ status: number; body: unknown }> {
    const url = new URL(`${this.server}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}` };
    let body: BodyInit | undefined;
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
      const json = new TextEncoder().encode(JSON.stringify(options.body));
      if (json.length >= this.gzipFrom) {
        headers["content-encoding"] = "gzip";
        body = new Uint8Array(gzipSync(json));
      } else {
        body = json;
      }
    }
    let response: Response;
    try {
      response = await this.fetch(url, { method, headers, body });
    } catch (err) {
      throw new StoreError(`cannot reach ${this.server}: ${(err as Error).message}`, err);
    }
    const text = await response.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new ServerError(response.status, "bad_response", `not JSON: ${text.slice(0, 200)}`);
      }
    }
    return { status: response.status, body: parsed };
  }

  /** A non-2xx response as the error it stands for. */
  private static refuse(status: number, body: unknown): never {
    const error = (body as ErrorBody | null)?.error ?? {};
    const code = error.code ?? "unknown";
    const message = error.message ?? `HTTP ${status}`;
    if (status === 409 && code === "offset_mismatch") {
      throw new OffsetMismatch(-1, error.expected ?? 0);
    }
    if (status === 422) throw new SessionRejected(code, message);
    if (status === 502) throw new StoreError(message);
    throw new ServerError(status, code, message);
  }

  async ingest(upload: Upload): Promise<StoreSessionResult> {
    const { status, body } = await this.request("POST", "/v1/sessions", { body: upload });
    if (status === 409) {
      const error = (body as ErrorBody | null)?.error;
      throw new OffsetMismatch(upload.offset ?? 0, error?.expected ?? 0);
    }
    if (status !== 200 && status !== 201) HttpSessionDB.refuse(status, body);
    return body as StoreSessionResult;
  }

  private sessionPath(agent: string, sessionId: string): string {
    return `/v1/sessions/${encodeURIComponent(agent)}/${encodeURIComponent(sessionId)}`;
  }

  async getSession(agent: string, sessionId: string): Promise<SessionMetadata | null> {
    const { status, body } = await this.request("GET", this.sessionPath(agent, sessionId));
    if (status === 404) return null;
    if (status !== 200) HttpSessionDB.refuse(status, body);
    return body as SessionMetadata;
  }

  async getTrace(agent: string, sessionId: string, hash?: string): Promise<Trace | null> {
    const { status, body } = await this.request(
      "GET",
      `${this.sessionPath(agent, sessionId)}/trace`,
      { query: { hash } },
    );
    if (status === 404 || status === 410) return null;
    if (status !== 200) HttpSessionDB.refuse(status, body);
    return body as Trace;
  }

  async listSessions(options: ListSessionsOptions = {}): Promise<SessionsPage> {
    const { status, body } = await this.request("GET", "/v1/sessions", {
      query: { after: options.after, limit: options.limit },
    });
    if (status !== 200) HttpSessionDB.refuse(status, body);
    return body as SessionsPage;
  }

  async tombstone(agent: string, sessionId: string): Promise<{ removed: number } | null> {
    const { status, body } = await this.request("DELETE", this.sessionPath(agent, sessionId));
    if (status === 404) return null;
    if (status !== 200) HttpSessionDB.refuse(status, body);
    return body as { removed: number };
  }

  async changes(options: ReadChangesOptions = {}): Promise<ChangesPage> {
    const { status, body } = await this.request("GET", "/v1/changes", {
      query: { after: options.after, since: options.since, limit: options.limit },
    });
    if (status !== 200) HttpSessionDB.refuse(status, body);
    return body as ChangesPage;
  }

  async me(): Promise<Identity> {
    const { status, body } = await this.request("GET", "/v1/me");
    if (status !== 200) HttpSessionDB.refuse(status, body);
    return body as Identity;
  }
}

// --- choosing --------------------------------------------------------------------------------

export type ConnectOptions =
  | { server: string; token: string; fetch?: Fetch }
  | ({
      /** A `Store`, or its URL: `s3://bucket/prefix`, `r2://bucket/prefix`, `file:///path`. */
      store: Store | string;
      owner: string;
      client?: string;
    } & OpenStoreOptions);

/** A client from its configuration: a server and a token, or a store and an owner. */
export function connect(options: ConnectOptions): SessionDB {
  if ("server" in options) {
    return new HttpSessionDB(options);
  }
  const { store: target, owner, client, ...open } = options;
  if (typeof target === "string") {
    const { store, storage } = openStore(target, open);
    return new StoreSessionDB({ store, storage, owner, client });
  }
  return new StoreSessionDB({ store: target, owner, client });
}
