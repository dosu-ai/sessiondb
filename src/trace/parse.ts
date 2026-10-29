/** trajectory-v1 records → a `Trace`: validate, derive events, hash. The derivation is pinned
 * by `testdata/goldens/` (`goldens.test.ts`), since `content_hash` is a layout contract. One
 * assistant record carrying N `tool_calls` fans out into N `tool_call` events so an excerpt can
 * point at a single call. */

import { createHash } from "node:crypto";
import {
  type Continuation,
  TRACE_SCHEMA,
  type Trace,
  type TraceEvent,
  type TraceMetadata,
} from "../schemas/trace";
import {
  type MetaRecord,
  type NormalizedRecord,
  TrajectoryError,
  validateRecords,
} from "../schemas/trajectory";
import { canonicalText, stripNul } from "./canonical";

/** Hash of what was said, independent of timestamps, so re-exports dedupe.
 * `sha256(source + "\n" + "\x1e".join(role + "\x1f" + text))`, UTF-8. A continuation hashes
 * where in the session it starts too (`source + "@" + from_record`): the same words at two
 * places in one session are two pieces of it, not one re-exported. */
function contentHash(
  source: string,
  events: readonly TraceEvent[],
  continuation?: Continuation,
): string {
  const body = events.map((e) => `${e.role}\x1f${e.text}`).join("\x1e");
  const head = continuation ? `${source}@${continuation.from_record}` : source;
  return createHash("sha256").update(`${head}\n${body}`, "utf8").digest("hex");
}

/** The epoch milliseconds of an ISO 8601 timestamp, or null when it does not parse; what
 * `started_at` / `ended_at` are chosen by. */
function epochOf(value: string): number | null {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

export interface ParseOptions {
  /** The harness name; defaults to the meta record's `source`. */
  agent?: string;
  session_id?: string;
  /** Merged over the meta record's `cwd` / `git_branch` / `model`. */
  metadata?: TraceMetadata;
  project?: string;
  branch?: string;
}

/** The events of a validated record list (meta first), with stable indices. */
function eventsOf(records: readonly NormalizedRecord[]): TraceEvent[] {
  const events: TraceEvent[] = [];
  const toolNames = new Map<string, string>();
  for (const record of records.slice(1)) {
    if (record.role === "meta") {
      throw new TrajectoryError("only the first record may be a meta record");
    }
    const timestamp = epochOf(record.timestamp) === null ? null : record.timestamp;
    const index = events.length;
    switch (record.role) {
      case "user":
      case "system":
      case "observation":
      case "reasoning":
        events.push({ index, role: record.role, text: canonicalText(record.content), timestamp });
        break;
      case "assistant": {
        const calls = "tool_calls" in record ? record.tool_calls : undefined;
        if (calls && calls.length > 0) {
          for (const call of calls) {
            toolNames.set(call.id, call.name);
            events.push({
              index: events.length,
              role: "tool_call",
              text: canonicalText(`${call.name} ${call.args}`),
              timestamp,
              tool_name: call.name,
              tool_call_id: call.id,
            });
          }
        } else if (record.content) {
          events.push({ index, role: "assistant", text: canonicalText(record.content), timestamp });
        }
        break;
      }
      case "tool": {
        const event: TraceEvent = {
          index,
          role: "tool_result",
          text: canonicalText(record.content),
          timestamp,
          tool_call_id: record.tool_call_id,
        };
        const name = toolNames.get(record.tool_call_id);
        if (name !== undefined) event.tool_name = name;
        if (record.ok !== undefined) event.ok = record.ok;
        events.push(event);
        break;
      }
    }
  }
  return events;
}

/** Whether the events are a usable conversation: a user record, and (unless the source is a
 * human chat, `chat:<origin>`) the agent acting. Anything else is not a trajectory. Judged on
 * a whole session only: a continuation is the tail of one already judged, and a tail is often
 * all tool traffic. */
function conversationError(source: string, events: readonly TraceEvent[]): string | null {
  const roles = new Set(events.map((e) => e.role));
  if (!roles.has("user")) return "trajectory has no user records";
  if (!source.startsWith("chat:") && !roles.has("assistant") && !roles.has("tool_call")) {
    return "trajectory has no assistant records";
  }
  return null;
}

/** Validate, strip NUL, derive events, hash. Throws `TrajectoryError` for anything that is not
 * a trajectory. */
export function parseTrajectory(input: unknown, options: ParseOptions = {}): Trace {
  const records = validateRecords(stripNul(input));
  const first = records[0];
  if (first?.role !== "meta") {
    throw new TrajectoryError("first record must be the meta record");
  }
  const meta: MetaRecord = first;
  const events = eventsOf(records);
  const continuation = options.metadata?.continuation;
  const problem = continuation ? null : conversationError(meta.source, events);
  if (problem) throw new TrajectoryError(problem);

  const stamps = events
    .map((e) => (e.timestamp === null ? null : epochOf(e.timestamp)))
    .filter((ms): ms is number => ms !== null);
  const at = (ms: number) =>
    events.find((e) => e.timestamp !== null && epochOf(e.timestamp) === ms);
  const started = stamps.length ? at(Math.min(...stamps)) : undefined;
  const ended = stamps.length ? at(Math.max(...stamps)) : undefined;

  const metadata: TraceMetadata = {};
  if (meta.cwd !== undefined) metadata.cwd = meta.cwd;
  if (meta.git_branch !== undefined) metadata.git_branch = meta.git_branch;
  if (meta.model !== undefined) metadata.model = meta.model;
  Object.assign(metadata, options.metadata ?? {});

  const trace: Trace = {
    schema: TRACE_SCHEMA,
    content_hash: contentHash(meta.source, events, continuation),
    source: meta.source,
    agent: options.agent ?? meta.source,
    session_id: options.session_id ?? null,
    started_at: started?.timestamp ?? null,
    ended_at: ended?.timestamp ?? null,
    records,
    events,
    metadata,
  };
  if (options.project !== undefined) trace.project = options.project;
  if (options.branch !== undefined) trace.branch = options.branch;
  return trace;
}
