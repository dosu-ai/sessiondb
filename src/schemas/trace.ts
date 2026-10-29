/** `sessionstorage/trace/1`: the immutable, content-addressed object a session's records become.
 * `docs/layout.md` is the contract; `trace/parse.ts` derives the events and `content_hash`. */

import type { NormalizedRecord } from "./trajectory";

export const TRACE_SCHEMA = "sessionstorage/trace/1" as const;

export type EventRole =
  | "user"
  | "assistant"
  | "tool_call"
  | "tool_result"
  | "system"
  | "observation"
  | "reasoning";

/** One unit of a trace. `index` is stable for the life of the object: anything that addresses a
 * span of a session (an episode, an excerpt) does so by `event_start..event_end`. `text` is the
 * canonical string every excerpt is validated against. */
export interface TraceEvent {
  index: number;
  role: EventRole;
  text: string;
  /** The record's timestamp as it was shipped (ISO 8601); null when the record had none that
   * parses. */
  timestamp: string | null;
  tool_name?: string;
  tool_call_id?: string;
  ok?: boolean;
}

/** Lineage and scope the client attaches at ingest; stored on `trace.metadata` as-is, plus the
 * meta record's `cwd`, `git_branch` and `model` when present. */
export interface TraceMetadata {
  cwd?: string;
  git_branch?: string;
  model?: string;
  /** The session this one was spawned by (a subagent, a fork). */
  parent_session_id?: string;
  /** Set when this trace is the tail of an already-stored session. */
  continuation?: Continuation;
  /** W3C trace context of the run that produced the session, when the hook saw one. */
  trace_context?: { trace_id: string; span_id: string };
  /** Which client normalized the records and with what. */
  normalizer?: { name: string; version: string };
  [key: string]: unknown;
}

export interface Continuation {
  /** Index of the first record in this upload within the session's full record list. */
  from_record: number;
  /** sha256 of the canonical JSON of the records before it (`prefixSha256`). */
  prefix_sha256: string;
}

export interface Trace {
  schema: typeof TRACE_SCHEMA;
  content_hash: string;
  /** The meta record's `source` (`claude-code`, `codex`, …): what normalized it. */
  source: string;
  /** What the client posted the session as; the archive id derives from it. The server accepts
   * only source names, so it equals `source` for everything it normalized itself. */
  agent: string;
  project?: string;
  branch?: string;
  session_id: string | null;
  started_at: string | null;
  ended_at: string | null;
  /** The shipped records, after redaction and NUL stripping; what `events` were derived from. */
  records: NormalizedRecord[];
  events: TraceEvent[];
  metadata: TraceMetadata;
}
