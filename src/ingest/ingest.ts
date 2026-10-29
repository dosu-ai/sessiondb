/** The write path: normalized, redacted records in, objects in the store out.
 *
 * `ingest`: cap → parse (validate, strip NUL, events, hash) → dedupe on `(owner, content_hash)`
 * → publish trace → swap `metadata.json` → change entry. `putRaw` and `tombstone` are the two
 * sibling operations. Redaction happened in `normalizeTranscript`; the hash is over what it
 * produced. */

import {
  METADATA_SCHEMA,
  type RawFormat,
  type SessionMetadata,
  type SessionTraceRef,
} from "../schemas/store";
import type { Trace, TraceMetadata } from "../schemas/trace";
import { type NormalizedRecord, TrajectoryError } from "../schemas/trajectory";
import { archiveId, keys } from "../store/layout";
import {
  appendChange,
  decodeJson,
  ensureLayout,
  gunzipJson,
  gzipJson,
  publishObject,
  readMetadata,
  sha256,
  swapMetadata,
} from "../store/publish";
import type { Store } from "../store/store";
import { parseTrajectory } from "../trace/parse";
import { LIMITS } from "./limits";

export interface IngestMetadata {
  session_id: string;
  /** The trajectory source (`claude-code`, `codex`, …). */
  agent: string;
  project?: string;
  branch?: string;
  parent_session_id?: string;
  continuation?: { from_record: number; prefix_sha256: string };
  trace_context?: { trace_id: string; span_id: string };
  normalizer?: { name: string; version: string };
}

export interface IngestInput {
  store: Store;
  owner: string;
  /** Normalized and redacted; `parseTrajectory` validates the shape. */
  records: readonly NormalizedRecord[];
  metadata: IngestMetadata;
  /** Identifies the writer in the layout marker (`sessiondb-server/0.1.0`). */
  client?: string;
  now?: () => Date;
}

export interface IngestResult {
  status: "stored" | "duplicate";
  archive_id: string;
  content_hash: string;
  session_id: string;
  records: number;
  events: number;
}

/** A session the store will not take; a 422, not a retry. */
export class IngestRejected extends Error {
  constructor(
    readonly code: "too_large" | "invalid" | "redacted",
    message: string,
  ) {
    super(message);
    this.name = "IngestRejected";
  }
}

function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

export async function ingest(input: IngestInput): Promise<IngestResult> {
  const { store, owner, metadata } = input;
  const now = input.now ?? (() => new Date());

  if (input.records.length > LIMITS.maxRecords) {
    throw new IngestRejected("too_large", `${input.records.length} records > ${LIMITS.maxRecords}`);
  }
  if (byteLength(input.records) > LIMITS.maxRecordsBytes) {
    throw new IngestRejected("too_large", `records exceed ${LIMITS.maxRecordsBytes} bytes`);
  }

  const traceMetadata: TraceMetadata = {};
  if (metadata.parent_session_id) traceMetadata.parent_session_id = metadata.parent_session_id;
  if (metadata.continuation) traceMetadata.continuation = metadata.continuation;
  if (metadata.trace_context) traceMetadata.trace_context = metadata.trace_context;
  if (metadata.normalizer) traceMetadata.normalizer = metadata.normalizer;

  let trace: Trace;
  try {
    trace = parseTrajectory(input.records, {
      agent: metadata.agent,
      session_id: metadata.session_id,
      project: metadata.project,
      branch: metadata.branch,
      metadata: traceMetadata,
    });
  } catch (err) {
    if (err instanceof TrajectoryError) throw new IngestRejected("invalid", err.message);
    throw err;
  }

  const archive = archiveId(owner, metadata.agent, metadata.session_id);
  const at = now().toISOString();
  await ensureLayout(store, input.client ?? "sessionstorage");

  const existing = await readMetadata(store, owner, archive);
  if (existing?.status === "redacted") {
    throw new IngestRejected("redacted", "session was redacted; it will not be stored again");
  }
  const already = existing?.traces.find((t) => t.content_hash === trace.content_hash);

  const outcome = await publishObject(
    store,
    keys.trace(owner, archive, trace.content_hash),
    gzipJson(trace),
    "application/gzip",
  );

  const ref: SessionTraceRef = {
    content_hash: trace.content_hash,
    created_at: already?.created_at ?? at,
    records: trace.records.length,
  };
  if (metadata.continuation) ref.continuation = metadata.continuation;

  const next: SessionMetadata = {
    schema: METADATA_SCHEMA,
    owner,
    archive_id: archive,
    session_id: metadata.session_id,
    agent: metadata.agent,
    source: trace.source,
    status: "stored",
    head: trace.content_hash,
    traces: already ? (existing?.traces ?? []) : [...(existing?.traces ?? []), ref],
    raw: existing?.raw ?? [],
    created_at: existing?.created_at ?? at,
    updated_at: at,
  };
  if (metadata.project ?? existing?.project) next.project = metadata.project ?? existing?.project;
  if (metadata.branch ?? existing?.branch) next.branch = metadata.branch ?? existing?.branch;
  // Lineage is backfilled onto an existing session: a duplicate upload that knows the parent
  // adds that knowledge rather than being ignored.
  const parent = metadata.parent_session_id ?? existing?.parent_session_id;
  if (parent) next.parent_session_id = parent;
  if (existing?.raw_format) next.raw_format = existing.raw_format;

  // A duplicate is one the pointer already lists and whose object was there: nothing new to say.
  // An object that exists without a pointer entry (an interrupted earlier publish) is completed
  // here, pointer and change entry included.
  const duplicate = already !== undefined && outcome === "exists";
  const pointerChanged =
    !existing ||
    JSON.stringify({ ...next, updated_at: "" }) !== JSON.stringify({ ...existing, updated_at: "" });
  if (pointerChanged) await swapMetadata(store, next);
  if (!duplicate) {
    await appendChange(store, {
      kind: "published",
      at,
      owner,
      archive_id: archive,
      session_id: metadata.session_id,
      content_hash: trace.content_hash,
      ...(metadata.continuation ? { continuation: metadata.continuation } : {}),
    });
  }

  return {
    status: duplicate ? "duplicate" : "stored",
    archive_id: archive,
    content_hash: trace.content_hash,
    session_id: metadata.session_id,
    records: trace.records.length,
    events: trace.events.length,
  };
}

export interface PutRawInput {
  store: Store;
  owner: string;
  agent: string;
  session_id: string;
  part: number;
  format: RawFormat;
  /** Already redacted (`redactRaw`) and gzipped. */
  bytes: Uint8Array;
  now?: () => Date;
}

export type PutRawResult = { status: "stored" | "exists"; part: number };

/** Store one raw part beside a session that has a trace. Idempotent for the same bytes. */
export async function putRaw(input: PutRawInput): Promise<PutRawResult> {
  const { store, owner, part, format } = input;
  if (input.bytes.length > LIMITS.maxRawPartBytes) {
    throw new IngestRejected("too_large", `raw part exceeds ${LIMITS.maxRawPartBytes} bytes`);
  }
  if (!Number.isInteger(part) || part < 0) throw new IngestRejected("invalid", "part must be ≥ 0");
  const archive = archiveId(owner, input.agent, input.session_id);
  const existing = await readMetadata(store, owner, archive);
  if (!existing) throw new IngestRejected("invalid", "no trace stored for this session yet");
  if (existing.status === "redacted") throw new IngestRejected("redacted", "session was redacted");

  const outcome = await publishObject(
    store,
    keys.raw(owner, archive, part, format),
    input.bytes,
    "application/gzip",
    "replace",
  );
  if (outcome === "exists" && existing.raw.some((r) => r.part === part)) {
    return { status: "exists", part };
  }
  const at = (input.now ?? (() => new Date()))().toISOString();
  const raw = [
    ...existing.raw.filter((r) => r.part !== part),
    { part, format, size: input.bytes.length, sha256: sha256(input.bytes), created_at: at },
  ].sort((a, b) => a.part - b.part);
  await swapMetadata(store, { ...existing, raw, raw_format: format, updated_at: at });
  return { status: "stored", part };
}

export interface TombstoneInput {
  store: Store;
  owner: string;
  agent: string;
  session_id: string;
  now?: () => Date;
}

/** Remove a session's trace and raw objects and mark it redacted. Irreversible; a later ingest
 * of the same session is refused, so a tombstoned session stays gone. */
export async function tombstone(input: TombstoneInput): Promise<{ removed: number } | null> {
  const { store, owner } = input;
  const archive = archiveId(owner, input.agent, input.session_id);
  const existing = await readMetadata(store, owner, archive);
  if (!existing) return null;
  let removed = 0;
  for (const t of existing.traces) {
    await store.delete(keys.trace(owner, archive, t.content_hash));
    removed++;
  }
  for (const r of existing.raw) {
    await store.delete(keys.raw(owner, archive, r.part, r.format));
    removed++;
  }
  const at = (input.now ?? (() => new Date()))().toISOString();
  const { head: _head, ...rest } = existing;
  await swapMetadata(store, { ...rest, status: "redacted", traces: [], raw: [], updated_at: at });
  await appendChange(store, {
    kind: "tombstone",
    at,
    owner,
    archive_id: archive,
    session_id: input.session_id,
    content_hash: existing.head ?? null,
  });
  return { removed };
}

// --- read side ----------------------------------------------------------------

export async function getTrace(
  store: Store,
  owner: string,
  archive: string,
  contentHash: string,
): Promise<Trace | null> {
  const bytes = await store.get(keys.trace(owner, archive, contentHash));
  return bytes === null ? null : gunzipJson<Trace>(bytes);
}

export async function getSession(
  store: Store,
  owner: string,
  agent: string,
  sessionId: string,
): Promise<SessionMetadata | null> {
  return readMetadata(store, owner, archiveId(owner, agent, sessionId));
}

/** Every session's metadata under an owner, by walking `sessions/`. A full listing, paged by
 * key; a reader that wants an index builds its own from `changes/`. */
export async function listSessions(
  store: Store,
  owner: string,
  options: { startAfter?: string; limit?: number } = {},
): Promise<{ sessions: SessionMetadata[]; cursor: string | undefined; truncated: boolean }> {
  const prefix = keys.sessions(owner);
  const page = await store.list(prefix, { startAfter: options.startAfter, limit: options.limit });
  const metadataKeys = page.keys.filter((k) => k.endsWith("/metadata.json"));
  const sessions = (
    await Promise.all(
      metadataKeys.map(async (k) => {
        const bytes = await store.get(k);
        return bytes === null ? null : decodeJson<SessionMetadata>(bytes);
      }),
    )
  ).filter((m): m is SessionMetadata => m !== null);
  return { sessions, cursor: page.keys.at(-1), truncated: page.truncated };
}
