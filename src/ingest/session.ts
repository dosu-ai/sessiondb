/** One session into the store, however it arrived: the transcript is stored first, as the
 * session's raw part, and the trace is made from what was stored. So every way in is the same
 * two steps, store → normalize, and the second can run again on its own (an adapter
 * improved, a format was recognized later) without the first.
 *
 * - `storeSession`: redact the transcript, write it as raw part 0 (that creates the session),
 *   then `normalizeStored`.
 * - `normalizeStored`: read a stored raw part, normalize it to `trajectory-v1` (a Datadog
 *   Trajectory stream becomes Letta records here, like every other format), decide what is
 *   new, write the trace.
 *
 * The HTTP routes call `storeSession` with what they read off the wire; the bucket scan calls
 * it with a stream it found in an owner's folder. Nothing here knows about HTTP. */

import { gunzipSync, gzipSync } from "node:zlib";
import { NORMALIZER, NormalizeError, normalizeTranscript, type Source } from "../normalize";
import { redactRaw } from "../redact/raw";
import type { RawFormat } from "../schemas/store";
import type { NormalizedRecord } from "../schemas/trajectory";
import { archiveId, keys } from "../store/layout";
import type { Store } from "../store/store";
import { copiedPrefix, planShipment, prefixSha256, type ShippedPrefix } from "./continuation";
import {
  getSession,
  getTrace,
  IngestRejected,
  type IngestResult,
  ingest,
  type PutRawResult,
  putRaw,
} from "./ingest";
import { isTrivialTrajectory } from "./worthiness";

export interface SessionUpload {
  owner: string;
  agent: Source;
  session_id: string;
  transcript: string;
  format: RawFormat;
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

/** What the client keeps as its shipped prefix after the call, whatever was written. */
interface Whole {
  records_total: number;
  prefix_sha256: string;
}

export type NormalizeStoredResult =
  /** Stored, and nothing in it worth a trace: no head. */
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

export interface NormalizeStoredInput {
  owner: string;
  agent: Source;
  session_id: string;
  /** Which raw part to read; the transcript is part 0. */
  part?: number;
  project?: string;
  branch?: string;
  parent_session_id?: string;
  fork_of?: string;
  shipped?: ShippedPrefix;
}

/** The second step on its own: a stored raw part to a trace. */
export async function normalizeStored(
  input: NormalizeStoredInput,
  options: SessionOptions,
): Promise<NormalizeStoredResult> {
  const { store, client, now } = options;
  const { owner, agent, session_id: sessionId } = input;
  const part = input.part ?? 0;

  const archive = archiveId(owner, agent, sessionId);
  const metadata = await getSession(store, owner, agent, sessionId);
  const stored = metadata?.raw.find((r) => r.part === part);
  if (!metadata || !stored) {
    throw new IngestRejected("invalid", `no raw part ${part} stored for this session`);
  }
  const bytes = await store.get(keys.raw(owner, archive, part, stored.format));
  if (bytes === null) throw new IngestRejected("invalid", `raw part ${part} is missing`);
  const transcript = new TextDecoder().decode(gunzipSync(bytes));

  let records: NormalizedRecord[];
  try {
    const outcome = normalizeTranscript({ source: agent, transcript });
    if (outcome.empty) throw new SessionRejected("empty", "transcript has no conversation");
    records = outcome.records;
  } catch (err) {
    if (err instanceof NormalizeError)
      throw new SessionRejected(`normalize_${err.code}`, err.message);
    throw err;
  }
  const whole: Whole = {
    records_total: records.length,
    prefix_sha256: prefixSha256(records, records.length),
  };

  // A resumed session: the client says how much shipped before (what it stored from the last
  // answer); the planner picks the tail, and falls back to the whole session when the prefix
  // no longer matches. A fork's copy of its parent's history is the parent's to ship.
  let plan = input.shipped ? planShipment(records, input.shipped) : { records, fresh: records };
  const copied = await forkCopy(store, owner, agent, input.fork_of, records);
  if (!plan.continuation && copied) plan = planShipment(records, copied);
  if (isTrivialTrajectory(plan.fresh)) return { status: "trivial", ...whole };

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
    client,
    now,
  });
  return { ...result, ...whole };
}

/** Both steps: the transcript into the store, then the trace out of it. */
export async function storeSession(
  upload: SessionUpload,
  options: SessionOptions,
): Promise<StoreSessionResult> {
  const { store, client, now } = options;
  const { owner, agent, session_id: sessionId, transcript, format } = upload;

  const raw = await putRaw({
    store,
    owner,
    agent,
    session_id: sessionId,
    part: 0,
    format,
    bytes: new Uint8Array(gzipSync(redactRaw(transcript, format))),
    client,
    now,
  });
  const result = await normalizeStored(upload, options);
  return { ...result, raw };
}
