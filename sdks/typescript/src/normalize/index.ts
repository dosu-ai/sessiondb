/** Native transcript → redacted trajectory-v1 records. Normalization is `@letta-ai/trajectory`'s
 * job; this module applies the fixups its adapters need (Claude Code's background-task input,
 * Codex's inherited history and subagent reports), runs the adapter, and redacts. The one
 * source it has no adapter for, a Datadog Trajectory session stream, has its own here. String
 * in, records out.
 *
 * A transcript can come in whole or as a chunk: the bytes of a log past a point already
 * normalized. A chunk is normalized on its own and yields the records those lines stand for,
 * without the meta record (the session's meta was made from its first chunk) and without the
 * demand that it hold a conversation. The Letta adapters do this through their canonical API
 * (`partial` source context), whose records are the same trajectory-v1 records; the Datadog
 * adapter has its own partial mode. Cut at a line boundary, a log's chunks normalize to exactly
 * the records the whole log does, in order. */

import {
  normalizeTranscript as letta,
  normalizeToCanonical as lettaCanonical,
  type TranscriptTrajectorySource,
} from "@letta-ai/trajectory";
import trajectoryPackage from "@letta-ai/trajectory/package.json";
import { redactRecords } from "../redact/records";
import type { NormalizedRecord } from "../schemas/trajectory";
import { VERSION } from "../version";
import { markClaudeInputs, markedAsObservations } from "./claude-inputs";
import { subagentReportsAsObservations, withoutInheritedHistory } from "./codex-rollout";
import { DATADOG_TRAJECTORY, normalizeDatadogTrajectory } from "./datadog-trajectory";

/** What a stored trace records as its normalizer: this SDK's release plus the
 * `@letta-ai/trajectory` it ran, as semver build metadata. Either changing can change the
 * records a transcript normalizes to, so a reader can tell which traces a change affected. The
 * SDK is the normalizer whoever runs it, the server or a client writing the bucket directly;
 * who that was is the layout marker's `created_by`. */
export const NORMALIZER = {
  name: "@dosu-ai/sessiondb",
  version: `${VERSION}+trajectory.${trajectoryPackage.version}`,
} as const;

/** The native logs `@letta-ai/trajectory` reads, by their trajectory source name. */
const LETTA_SOURCES = [
  "claude-code",
  "cursor",
  "codex",
  "opencode",
  "pi",
  "gemini-cli",
] as const satisfies readonly TranscriptTrajectorySource[];

/** The transcript formats this server accepts: the native logs, and a Datadog Trajectory
 * session stream. The name is also the `agent` a client sends and what the archive id is
 * derived from. */
export const SOURCES = [...LETTA_SOURCES, DATADOG_TRAJECTORY] as const;

export type Source = (typeof SOURCES)[number];

type LettaSource = (typeof LETTA_SOURCES)[number];

export function isSource(value: string): value is Source {
  return (SOURCES as readonly string[]).includes(value);
}

/** The adapter's refusals that only mean "no conversation here": the session is trivial, not
 * unsupported. */
const EMPTY_CONVERSATION_CODES = new Set(["missing_user_records", "missing_assistant_records"]);

export type NormalizeOutcome =
  | { records: NormalizedRecord[]; empty?: false }
  /** A log with no conversation in it. */
  | { records: []; empty: true };

/** Thrown when a transcript cannot be normalized (unsupported source, unparseable transcript). */
export class NormalizeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "NormalizeError";
    this.code = code;
  }
}

/** Where a chunk sits in its log. */
export interface Chunk {
  /** The byte offset of the chunk's first byte in the log. */
  offset: number;
  /** The session the log is of, for an adapter whose chunks do not say (a Codex rollout's
   * `session_meta` is in its first chunk only). */
  session_id: string;
}

/** The per-source rewrite the adapter needs to see. The inherited history a forked Codex
 * rollout starts with is cut by what its `session_meta` says; a chunk past the rollout's head
 * never holds any of it, since a session has a head only once the subagent's own records,
 * which come after, were stored. */
function prepare(source: LettaSource, transcript: string): string {
  switch (source) {
    case "codex":
      return withoutInheritedHistory(transcript);
    case "claude-code":
      return markClaudeInputs(transcript);
    default:
      return transcript;
  }
}

/** The adapter's records for a chunk: its canonical records' `record_json`, which is the
 * trajectory-v1 record each stands for, less the meta record it emits for a chunk at offset
 * 0 (a chunk's records are never the session's meta). The session id is declared only when
 * the adapter asks for it, since one that reads its own id refuses a declared one that
 * differs. */
function lettaChunk(source: LettaSource, transcript: string, chunk: Chunk): NormalizedRecord[] {
  const run = (groupId?: string) =>
    lettaCanonical({
      source,
      transcript,
      sourceContext: { baseByteOffset: chunk.offset, partial: true, groupId },
    })
      .records.filter((record) => record.record_type !== "meta")
      .map((record) => JSON.parse(record.record_json) as NormalizedRecord);
  try {
    return run();
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code !== "source_group_required") throw err;
    return run(chunk.session_id);
  }
}

/** The records of one transcript before redaction: the Datadog stream through its own adapter,
 * every native log through `@letta-ai/trajectory` with its fixups around it. */
function recordsOf(source: Source, transcript: string, chunk?: Chunk): NormalizedRecord[] {
  if (source === DATADOG_TRAJECTORY) {
    return normalizeDatadogTrajectory(transcript, { partial: chunk !== undefined });
  }
  const prepared = prepare(source, transcript);
  const records = chunk
    ? lettaChunk(source, prepared, chunk)
    : letta({ source, transcript: prepared }).records;
  switch (source) {
    case "codex":
      return subagentReportsAsObservations(records);
    case "claude-code":
      return markedAsObservations(records);
    default:
      return records;
  }
}

/** Normalize one transcript to redacted trajectory-v1 records. `empty` for a transcript the
 * adapter reads but finds no conversation in; throws `NormalizeError` for one it cannot read.
 * With `chunk`, the transcript is a chunk of a log and the records are the chunk's own: no meta
 * record, and `empty` only when it holds no records at all. */
export function normalizeTranscript(input: {
  source: Source;
  transcript: string;
  chunk?: Chunk;
}): NormalizeOutcome {
  const { source, transcript, chunk } = input;
  if (transcript.trim() === "") return { records: [], empty: true };
  try {
    const records = redactRecords(recordsOf(source, transcript, chunk));
    if (chunk && records.length === 0) return { records: [], empty: true };
    return { records };
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    if (typeof code === "string" && EMPTY_CONVERSATION_CODES.has(code)) {
      return { records: [], empty: true };
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new NormalizeError(typeof code === "string" ? code : "normalize_failed", message);
  }
}
