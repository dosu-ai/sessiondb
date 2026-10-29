/** One session into the store, however it arrived: the transcript is stored first, as a raw
 * part of the session, and the trace is made from what was stored. So every way in is the same
 * two steps, store → normalize, and the second can run again on its own (an adapter
 * improved, a format was recognized later) without the first.
 *
 * - `storeSession`: redact the transcript, write it as a raw part (the first one creates the
 *   session), then `normalizeStored`.
 * - `normalizeStored`: read the stored raw, normalize it to `trajectory-v1` (a Datadog
 *   Trajectory stream becomes Letta records here, like every other format), decide what is
 *   new, write the trace.
 *
 * A transcript arrives whole, or as a chunk: the log's bytes from where the last upload ended
 * (`offset`, which must be the session's `normalized.bytes`). A chunk is stored as its own raw
 * part and normalized on its own, as the records those lines stand for, and ships as a
 * continuation of the head: the meta record plus the chunk's records, marked with where they
 * start. The server keeps what the continuation needs between chunks (`metadata.normalized`:
 * bytes covered, records so far, the prefix hash mid-stream), so a chunk needs no `shipped`.
 * Until the session has a head, there is nothing to continue and the chunks so far are
 * normalized together as the whole log, judged for worth the way a whole upload is; once it
 * has one, every chunk with records in it ships. Whether a session is worth a trace is decided
 * once, not per chunk.
 *
 * The HTTP routes call `storeSession` with what they read off the wire. Nothing here knows
 * about HTTP. */

import { gunzipSync, gzipSync } from "node:zlib";
import { NORMALIZER, NormalizeError, normalizeTranscript, type Source } from "../normalize";
import { redactRaw } from "../redact/raw";
import type { NormalizedState, RawFormat, RawPart, SessionMetadata } from "../schemas/store";
import type { NormalizedRecord } from "../schemas/trajectory";
import { keys } from "../store/layout";
import type { Store } from "../store/store";
import { copiedPrefix, planShipment, type ShippedPrefix } from "./continuation";
import {
  getSession,
  getTrace,
  IngestRejected,
  type IngestResult,
  ingest,
  type PutRawResult,
  putRaw,
  recordNormalized,
} from "./ingest";
import { PrefixHash } from "./prefix-hash";
import { isTrivialTrajectory } from "./worthiness";

export interface SessionUpload {
  owner: string;
  agent: Source;
  session_id: string;
  transcript: string;
  format: RawFormat;
  /** The byte offset of `transcript` in the session's log: 0 (the default) when it is the whole
   * log, else where the last upload ended, the `bytes_total` it answered. */
  offset?: number;
  project?: string;
  branch?: string;
  parent_session_id?: string;
  fork_of?: string;
  /** What the client stored from the last answer for this session, if it was stored before. */
  shipped?: ShippedPrefix;
}

export interface SessionOptions {
  store: Store;
  /** Identifies the writer in the layout marker. */
  client?: string;
  now?: () => Date;
}

/** What the client keeps after the call, whatever was written: its shipped prefix, and where
 * the next chunk starts. */
interface Whole {
  records_total: number;
  prefix_sha256: string;
  /** Bytes of the log normalized so far; absent for a session stored before parts recorded
   * where they sit, which takes a whole upload before it can take a chunk. */
  bytes_total?: number;
}

type NormalizeStoredResult =
  /** Stored, and nothing in it worth a trace: no head, or nothing new for it. */
  ({ status: "trivial" } & Whole) | (IngestResult & Whole);

export type StoreSessionResult = NormalizeStoredResult & { raw: PutRawResult };

/** A transcript the normalizer refuses: nothing in it, or not readable by the adapter. The raw
 * part is stored either way; `code` is what the server reports. */
export class SessionRejected extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SessionRejected";
  }
}

/** A chunk that does not start where the session's log ends: nothing is stored. The client
 * resumes from `expected` (0 when the session has no chunk state: it sends the whole log). */
export class OffsetMismatch extends Error {
  readonly code = "offset_mismatch";
  constructor(
    readonly offset: number,
    readonly expected: number,
  ) {
    super(`chunk starts at byte ${offset}; the session's log ends at ${expected}`);
    this.name = "OffsetMismatch";
  }
}

/** A recorded branch name, or undefined for the detached (`HEAD`) and empty values agents
 * record. */
function recordedBranch(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const branch = value.trim();
  return branch && branch !== "HEAD" ? branch : undefined;
}

/** What a fork copied from the session it was made from, when that parent is stored here. */
async function forkCopy(
  store: Store,
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

interface NormalizeStoredInput {
  owner: string;
  agent: Source;
  session_id: string;
  /** The raw part just stored, when one was: a chunk past the head continues it. Without one,
   * or when the session has no head to continue, every part is normalized together as the
   * whole log. */
  part?: number;
  project?: string;
  branch?: string;
  parent_session_id?: string;
  fork_of?: string;
  shipped?: ShippedPrefix;
}

/** The records of a transcript; none for one the adapter reads but finds no conversation in
 * (a session that has only started), which is trivial rather than refused. A blank transcript
 * is refused: there is nothing in it to store. */
function normalize(input: Parameters<typeof normalizeTranscript>[0]): NormalizedRecord[] {
  if (input.transcript.trim() === "") {
    throw new SessionRejected("empty", "transcript is empty");
  }
  try {
    return normalizeTranscript(input).records;
  } catch (err) {
    if (err instanceof NormalizeError)
      throw new SessionRejected(`normalize_${err.code}`, err.message);
    throw err;
  }
}

async function readPart(
  store: Store,
  owner: string,
  archive: string,
  part: RawPart,
): Promise<string> {
  const bytes = await store.get(keys.raw(owner, archive, part.part, part.format));
  if (bytes === null) throw new IngestRejected("invalid", `raw part ${part.part} is missing`);
  return new TextDecoder().decode(gunzipSync(bytes));
}

/** The parts in log order: by where they sit, else by number. */
function inLogOrder(parts: readonly RawPart[]): RawPart[] {
  return [...parts].sort((a, b) => (a.offset ?? a.part) - (b.offset ?? b.part) || a.part - b.part);
}

/** Where the log ends after `parts`, when every part says where it sits. */
function logEnd(parts: readonly RawPart[]): number | undefined {
  const last = parts.at(-1);
  if (!last || parts.some((p) => p.offset === undefined || p.length === undefined)) {
    return undefined;
  }
  return (last.offset as number) + (last.length as number);
}

/** The second step on its own: the stored raw to a trace. */
async function normalizeStored(
  input: NormalizeStoredInput,
  options: SessionOptions,
): Promise<NormalizeStoredResult> {
  const { store } = options;
  const { owner, agent, session_id: sessionId } = input;
  const metadata = await getSession(store, owner, agent, sessionId);
  if (!metadata || metadata.raw.length === 0) {
    throw new IngestRejected("invalid", "no raw part stored for this session");
  }
  const stored =
    input.part === undefined ? undefined : metadata.raw.find((r) => r.part === input.part);
  if (input.part !== undefined && !stored) {
    throw new IngestRejected("invalid", `no raw part ${input.part} stored for this session`);
  }
  const continues =
    stored !== undefined &&
    stored.offset !== undefined &&
    stored.offset > 0 &&
    metadata.head !== undefined &&
    metadata.normalized !== undefined &&
    stored.offset === metadata.normalized.bytes;
  return continues
    ? continueStored(input, metadata, stored, options)
    : wholeStored(input, metadata, options);
}

/** Every part together as the whole log, shipped the way a whole upload is: all of it, or the
 * tail past what the client says shipped before. */
async function wholeStored(
  input: NormalizeStoredInput,
  metadata: SessionMetadata,
  options: SessionOptions,
): Promise<NormalizeStoredResult> {
  const { store, client, now } = options;
  const { owner, agent, session_id: sessionId } = input;
  const parts = inLogOrder(metadata.raw);
  const chunks: string[] = [];
  for (const part of parts) chunks.push(await readPart(store, owner, metadata.archive_id, part));
  const transcript = chunks.join("");

  const records = normalize({ source: agent, transcript });
  const hash = PrefixHash.of(records);
  const bytes = logEnd(parts);
  const normalized: NormalizedState | undefined =
    bytes === undefined
      ? undefined
      : {
          bytes,
          records: records.length,
          prefix_sha256: hash.digest(),
          hash_state: hash.export(),
        };
  const whole: Whole = {
    records_total: records.length,
    prefix_sha256: hash.digest(),
    ...(bytes === undefined ? {} : { bytes_total: bytes }),
  };

  // A resumed session: the client says how much shipped before (what it stored from the last
  // answer); the planner picks the tail, and falls back to the whole session when the prefix
  // no longer matches. A fork's copy of its parent's history is the parent's to ship.
  let plan = input.shipped ? planShipment(records, input.shipped) : { records, fresh: records };
  const copied = await forkCopy(store, owner, agent, input.fork_of, records);
  if (!plan.continuation && copied) plan = planShipment(records, copied);
  if (isTrivialTrajectory(plan.fresh)) {
    if (normalized)
      await recordNormalized({ store, owner, agent, session_id: sessionId, normalized, now });
    return { status: "trivial", ...whole };
  }

  // The branch the transcript recorded as it began, else what the client resolved.
  const meta = records[0]?.role === "meta" ? records[0] : undefined;
  const branch = recordedBranch(meta?.git_branch) ?? input.branch;

  const result = await ingest({
    store,
    owner,
    records: plan.records,
    metadata: {
      session_id: sessionId,
      agent,
      project: input.project,
      branch,
      parent_session_id: input.parent_session_id,
      ...(plan.continuation ? { continuation: plan.continuation } : {}),
      normalizer: NORMALIZER,
    },
    normalized,
    client,
    now,
  });
  return { ...result, ...whole };
}

/** One chunk past the head: its records, as a continuation of what the server knows shipped. */
async function continueStored(
  input: NormalizeStoredInput,
  metadata: SessionMetadata,
  stored: RawPart,
  options: SessionOptions,
): Promise<NormalizeStoredResult> {
  const { store, client, now } = options;
  const { owner, agent, session_id: sessionId } = input;
  const state = metadata.normalized as NormalizedState;
  const offset = stored.offset as number;
  const bytes = offset + (stored.length as number);

  const transcript = await readPart(store, owner, metadata.archive_id, stored);
  const records = normalize({
    source: agent,
    transcript,
    chunk: { offset, session_id: sessionId },
  });
  if (records.length === 0) {
    // Lines with no records in them (transport, progress): the log moved on, nothing shipped.
    const normalized = { ...state, bytes };
    await recordNormalized({ store, owner, agent, session_id: sessionId, normalized, now });
    return {
      status: "trivial",
      records_total: state.records,
      prefix_sha256: state.prefix_sha256,
      bytes_total: bytes,
    };
  }

  const hash = PrefixHash.resume(state.hash_state);
  for (const record of records) hash.append(record);
  const normalized: NormalizedState = {
    bytes,
    records: hash.records,
    prefix_sha256: hash.digest(),
    hash_state: hash.export(),
  };

  // The session's meta record is the head's: a chunk has none of its own.
  const head = await getTrace(store, owner, metadata.archive_id, metadata.head as string);
  const meta = head?.records[0]?.role === "meta" ? [head.records[0]] : [];

  const result = await ingest({
    store,
    owner,
    records: [...meta, ...records],
    metadata: {
      session_id: sessionId,
      agent,
      project: input.project ?? metadata.project,
      branch: input.branch ?? metadata.branch,
      parent_session_id: input.parent_session_id,
      continuation: { from_record: state.records, prefix_sha256: state.prefix_sha256 },
      normalizer: NORMALIZER,
    },
    normalized,
    client,
    now,
  });
  return {
    ...result,
    records_total: normalized.records,
    prefix_sha256: normalized.prefix_sha256,
    bytes_total: bytes,
  };
}

/** Both steps: the transcript into the store, then the trace out of it. A chunk (`offset` > 0)
 * must start where the session's log ends, else `OffsetMismatch` and nothing is stored. */
export async function storeSession(
  upload: SessionUpload,
  options: SessionOptions,
): Promise<StoreSessionResult> {
  const { store, client, now } = options;
  const { owner, agent, session_id: sessionId, transcript, format } = upload;
  const offset = upload.offset ?? 0;
  const length = new TextEncoder().encode(transcript).length;

  let part = 0;
  if (offset > 0) {
    if (format !== "jsonl") {
      throw new SessionRejected("bad_chunk", "only a jsonl log can be sent in chunks");
    }
    if (!transcript.endsWith("\n")) {
      throw new SessionRejected("bad_chunk", "a chunk must end at a line boundary");
    }
    const existing = await getSession(store, owner, agent, sessionId);
    const expected = existing?.normalized?.bytes ?? 0;
    if (offset !== expected) throw new OffsetMismatch(offset, expected);
    // A chunk sent again after its normalization failed takes the same part number.
    const parts = existing?.raw ?? [];
    part =
      parts.find((r) => r.offset === offset)?.part ?? Math.max(-1, ...parts.map((r) => r.part)) + 1;
  }

  const raw = await putRaw({
    store,
    owner,
    agent,
    session_id: sessionId,
    part,
    format,
    bytes: new Uint8Array(gzipSync(redactRaw(transcript, format))),
    offset,
    length,
    whole: offset === 0,
    client,
    now,
  });
  const result = await normalizeStored({ ...upload, part }, options);
  return { ...result, raw };
}
