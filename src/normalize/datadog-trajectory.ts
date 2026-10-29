/** Datadog Trajectory's session file format → trajectory-v1 records.
 *
 * Trajectory (github.com/datadog-labs/trajectory) is Datadog's capture daemon for coding agents.
 * It records each session it captures, from Claude Code, Codex, Cursor, Pi and the rest, as one
 * canonical event per line at `~/.trajectory/trajectories/sessions/<date>/session-<id>.jsonl`.
 * This server has nothing to do with the daemon itself; it reads that format, wherever the
 * files end up (a bucket an owner synced the directory into, a transcript posted by hand).
 * `@letta-ai/trajectory` has no adapter for it, so this is the server's own, and what it
 * produces is the same trajectory-v1 the Letta adapters produce, hashed, redacted and stored
 * the same way. The events are the daemon's shape, the same for every client it captures, so
 * one adapter covers them all and the records say which client ran the session in the meta
 * record's `source` (`datadog-trajectory:claude-code`).
 *
 * A session the daemon imported from a client's own history (`trajectory session import`,
 * `_backfilled: true`) is thinner than one it captured live: `session_start` carries `cwd`
 * instead of `project_dir`, a tool call appears only as its `phase: post` event, and the
 * agent's prose is not in it at all.
 *
 * What ships, by `event_type`:
 *
 * - `session_start`: the meta record (`project_dir` or `cwd`, `git_branch`, `model`).
 * - `user_prompt` / `input_prompt`: a user record; an observation when the daemon says nobody
 *   typed it (`provenance.actor_type` other than `human`).
 * - `tool_use` with `phase: pre`: an assistant tool call, under the client's own tool name
 *   (`native_tool_name`, else the daemon's shared `tool_name`).
 * - `tool_use` with `phase: post`: the tool result (`output_summary`, else the `error`), with
 *   `ok` from `success`. One whose call was never seen (a backfilled session) gets the call
 *   synthesized in front of it, so the result has something to answer.
 * - `agent_message`: a reasoning record for `thinking_text`, an assistant record for `text`.
 *
 * Everything else is dropped: `turn_end`, `llm_call`, `session_end`, `inventory.snapshot` and
 * the permission and elicitation events carry no conversation, and `subagent_start` /
 * `subagent_stop` repeat what the `Agent` tool's result already says. The subagent's own session
 * arrives as its own stream. */

import type {
  AssistantToolCallRecord,
  MetaRecord,
  NormalizedRecord,
  ToolResultRecord,
} from "../schemas/trajectory";

/** The `agent` these sessions are filed under, and the prefix of their trace `source`. */
export const DATADOG_TRAJECTORY = "datadog-trajectory" as const;

type Event = Record<string, unknown>;

/** Thrown for a stream this adapter cannot turn into a session. `code` is what the server
 * reports (`missing_session_start`); `missing_user_records` and `missing_assistant_records` mean
 * there is no conversation in it yet. */
export class DatadogTrajectoryError extends Error {
  constructor(
    readonly code: "missing_session_start" | "missing_user_records" | "missing_assistant_records",
    message: string,
  ) {
    super(message);
    this.name = "DatadogTrajectoryError";
  }
}

/** What a delivery is about, read without normalizing it. */
export interface StreamSummary {
  session_id: string;
  /** The client the daemon captured (`claude-code`, `pi`, …), as it names it. */
  client_source?: string;
  parent_session_id?: string;
  /** Whether a `session_end` is in the stream: the delivery the daemon makes once the session
   * is over, as opposed to the snapshots it sends while the session runs. */
  finished: boolean;
  /** How many events the stream holds. */
  events: number;
}

function parseEvents(transcript: string): Event[] {
  const events: Event[] = [];
  for (const line of transcript.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        events.push(value as Event);
      }
    } catch {
      // Not an event; the daemon's own files are one JSON object per line.
    }
  }
  return events;
}

/** A string with something in it, else undefined. */
function present(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function sessionStart(events: readonly Event[]): Event {
  const start = events.find((event) => event.event_type === "session_start");
  if (!start || !present(start.session_id)) {
    throw new DatadogTrajectoryError(
      "missing_session_start",
      "stream has no session_start event with a session_id",
    );
  }
  return start;
}

/** Read the stream's identity and whether it is finished. Throws `DatadogTrajectoryError` when
 * there is no `session_start` to identify it by. */
export function describeStream(transcript: string): StreamSummary {
  const events = parseEvents(transcript);
  const start = sessionStart(events);
  const summary: StreamSummary = {
    session_id: start.session_id as string,
    finished: events.some((event) => event.event_type === "session_end"),
    events: events.length,
  };
  const client = present(start.client_source);
  const parent = present(start.parent_session_id);
  if (client !== undefined) summary.client_source = client;
  if (parent !== undefined) summary.parent_session_id = parent;
  return summary;
}

function metaOf(start: Event): MetaRecord {
  const client = present(start.client_source) ?? "unknown";
  const meta: MetaRecord = { role: "meta", source: `${DATADOG_TRAJECTORY}:${client}` };
  const cwd = present(start.project_dir) ?? present(start.cwd);
  const branch = present(start.git_branch);
  const model = present(start.model);
  if (cwd !== undefined) meta.cwd = cwd;
  if (branch !== undefined) meta.git_branch = branch;
  if (model !== undefined) meta.model = model;
  return meta;
}

/** Whether the daemon attributes an input to a person. It marks every prompt with who produced
 * it; only one it does not attribute to a human is something the agent observed. */
function typedByHuman(event: Event): boolean {
  const provenance = event.provenance;
  if (typeof provenance !== "object" || provenance === null) return true;
  const actor = (provenance as Event).actor_type;
  return actor === undefined || actor === "human";
}

/** The records of one stream, meta first. Throws `DatadogTrajectoryError` when the stream has
 * no `session_start`, or holds no conversation (no prompt, or nothing answering one). */
export function normalizeDatadogTrajectory(transcript: string): NormalizedRecord[] {
  const events = parseEvents(transcript);
  const start = sessionStart(events);
  const records: NormalizedRecord[] = [metaOf(start)];
  // An event without a timestamp takes the last one seen, so order is kept.
  let last = present(start.timestamp) ?? present(start.started_at) ?? "";
  let asked = false;
  let answered = false;
  /** Tool calls seen as `phase: pre`, so a result can tell whether its call was shipped. */
  const called = new Set<string>();

  /** The assistant record for one tool call. */
  function toolCall(event: Event, id: string, timestamp: string): AssistantToolCallRecord | null {
    const name = present(event.native_tool_name) ?? present(event.tool_name);
    if (name === undefined) return null;
    return {
      role: "assistant",
      content: null,
      tool_calls: [{ id, name, args: JSON.stringify(event.input ?? {}) }],
      timestamp,
    };
  }

  for (const event of events) {
    const timestamp = present(event.timestamp) ?? last;
    last = timestamp;
    switch (event.event_type) {
      case "user_prompt":
      case "input_prompt": {
        const prompt = present(event.prompt);
        if (prompt === undefined) break;
        if (typedByHuman(event)) {
          asked = true;
          records.push({ role: "user", content: prompt, timestamp });
        } else {
          records.push({ role: "observation", content: prompt, timestamp });
        }
        break;
      }
      case "tool_use": {
        const id = present(event.tool_use_id);
        if (id === undefined) break;
        if (event.phase === "pre") {
          const call = toolCall(event, id, timestamp);
          if (call === null) break;
          answered = true;
          called.add(id);
          records.push(call);
        } else if (event.phase === "post") {
          if (!called.has(id)) {
            // A result whose call never shipped: the call is what the result's own event says
            // it was, with whatever input the event kept.
            const call = toolCall(event, id, timestamp);
            if (call === null) break;
            answered = true;
            called.add(id);
            records.push(call);
          }
          const error = typeof event.error === "string" ? event.error : undefined;
          const result: ToolResultRecord = {
            role: "tool",
            tool_call_id: id,
            content:
              typeof event.output_summary === "string" ? event.output_summary : (error ?? ""),
            timestamp,
          };
          if (typeof event.success === "boolean") result.ok = event.success;
          else if (error !== undefined) result.ok = false;
          records.push(result);
        }
        break;
      }
      case "agent_message": {
        const thinking = present(event.thinking_text);
        const text = present(event.text);
        if (thinking !== undefined)
          records.push({ role: "reasoning", content: thinking, timestamp });
        if (text !== undefined) {
          answered = true;
          records.push({ role: "assistant", content: text, timestamp });
        }
        break;
      }
      default:
        break;
    }
  }

  if (!asked) {
    throw new DatadogTrajectoryError("missing_user_records", "stream has no user prompt");
  }
  if (!answered) {
    throw new DatadogTrajectoryError(
      "missing_assistant_records",
      "stream has no assistant message or tool call",
    );
  }
  return records;
}
