/** ATIF documents, adjusted around what @letta-ai/trajectory's atif adapter does with them.
 *
 * ATIF is Harbor's Agent Trajectory Interchange Format (harbor-framework/harbor, RFC 0001): one
 * JSON document per session, exported by a tool such as Decant from whichever harness ran it.
 * The adapter reads ATIF-v1.0 through ATIF-v1.7 and loses two things a reader wants.
 *
 * ATIF-v1.8, the current version, differs from v1.7 only by the `audio` content part. The
 * adapter is handed a v1.8 document as v1.7 with each audio part turned into the text
 * `[audio]`, the placeholder it already writes for an image; one it was given as is would be
 * dropped from the text without a trace.
 *
 * The harness: the adapter stamps every meta record `source: "atif"`, so a Claude Code session
 * and a Codex session look the same in a trace. The document names the harness in `agent.name`
 * (Harbor's names: `claude-code`, `codex`, `copilot-cli`), and that becomes the meta record's
 * `source` when it is usable as one; `atif` otherwise. The session stays filed under
 * `agent: "atif"`, which is what the archive id derives from.
 *
 * Tool errors: ATIF has no standard success flag, so the adapter emits tool records with no
 * `ok`. A result whose `extra.is_error` is a boolean (Decant writes it) gets `ok` from it.
 *
 * Embedded `subagent_trajectories` are left as the adapter leaves them, unnormalized: each
 * subagent is posted as its own session with `parent_session_id`. */

import type { NormalizedRecord } from "../schemas/trajectory";
import { isScopeCoordinate } from "../schemas/trajectory";

/** The `agent` these sessions are filed under, and their trace `source` when the document does
 * not name a usable harness. */
export const ATIF = "atif" as const;

/** The schema versions this normalizer reads: the adapter's v1.0 through v1.7, and v1.8 through
 * `asAdapterVersion`. */
const SUPPORTED_VERSION = /^ATIF-v1\.[0-8]$/;

/** The one version the adapter does not read itself. */
const AUDIO_VERSION = "ATIF-v1.8";

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function parseDocument(transcript: string): Json | null {
  try {
    const value = JSON.parse(transcript) as unknown;
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

/** Why a document's `schema_version` cannot be read, in words a client can act on; null when it
 * can (or when the document is unreadable for another reason, which the adapter reports). */
export function unsupportedAtifVersion(transcript: string): string | null {
  const version = parseDocument(transcript)?.schema_version;
  if (typeof version !== "string" || SUPPORTED_VERSION.test(version)) return null;
  return `${version} is not supported: this normalizer reads ATIF-v1.0 through ATIF-v1.8`;
}

/** A content value (a `message` or a result's `content`) with each audio part as the text
 * `[audio]`. */
function withoutAudio(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  return content.map((part) =>
    isObject(part) && part.type === "audio" ? { type: "text", text: "[audio]" } : part,
  );
}

/** The transcript the adapter is given: an ATIF-v1.8 document as v1.7, its audio parts as text;
 * any other transcript as it is. */
export function asAdapterVersion(transcript: string): string {
  const document = parseDocument(transcript);
  if (document?.schema_version !== AUDIO_VERSION || !Array.isArray(document.steps)) {
    return transcript;
  }
  const steps = document.steps.map((step) => {
    if (!isObject(step)) return step;
    const observation = step.observation;
    const results = isObject(observation) ? observation.results : undefined;
    return {
      ...step,
      message: withoutAudio(step.message),
      ...(Array.isArray(results)
        ? {
            observation: {
              ...(observation as Json),
              results: results.map((result) =>
                isObject(result) ? { ...result, content: withoutAudio(result.content) } : result,
              ),
            },
          }
        : {}),
    };
  });
  return JSON.stringify({ ...document, schema_version: "ATIF-v1.7", steps });
}

/** The trace source for a document: its `agent.name` when that is a non-blank scope
 * coordinate, else `atif`. */
export function atifSource(document: Json | null): string {
  const agent = document?.agent;
  const name = isObject(agent) ? agent.name : undefined;
  return typeof name === "string" && name.trim() !== "" && isScopeCoordinate(name) ? name : ATIF;
}

/** A non-empty string, else undefined: the adapter's test for an id. */
const nonEmpty = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

/** The error flag of each tool record the adapter emits, by the record's `tool_call_id`.
 *
 * The adapter renames a call id the document repeats (`c`, `c__2`, …) and links each result to
 * the first call with its id that no earlier result took, dropping a result with none left. This
 * follows the same two passes over the same events, so a flag lands on the record of the result
 * that carried it: every call's final id first, then each result in document order. Only agent
 * steps' calls count, and only results with a `source_call_id`; a user step's observation is
 * never read. */
function errorFlags(document: Json | null): Map<string, boolean> {
  const flags = new Map<string, boolean>();
  const steps = document?.steps;
  if (!Array.isArray(steps)) return flags;

  const used = new Set<string>();
  const open = new Map<string, { id: string; taken: boolean }[]>();
  const results: { callId: string; isError: unknown }[] = [];
  // The adapter's event index, which names a call that has no id of its own.
  let event = 0;
  for (const step of steps) {
    if (!isObject(step)) continue;
    event += 1; // the step's message
    if (step.source === "user") continue;
    if (step.source === "agent") {
      if (typeof step.reasoning_content === "string") event += 1;
      for (const call of Array.isArray(step.tool_calls) ? step.tool_calls : []) {
        event += 1;
        const sourceId =
          nonEmpty(isObject(call) ? call.tool_call_id : undefined) ?? `call_${event}`;
        let id = sourceId;
        for (let suffix = 2; used.has(id); suffix += 1) id = `${sourceId}__${suffix}`;
        used.add(id);
        open.set(sourceId, [...(open.get(sourceId) ?? []), { id, taken: false }]);
      }
    }
    const observed = isObject(step.observation) ? step.observation.results : undefined;
    for (const result of Array.isArray(observed) ? observed : []) {
      event += 1;
      const callId = nonEmpty(isObject(result) ? result.source_call_id : undefined);
      if (callId === undefined) continue;
      const extra = isObject(result) && isObject(result.extra) ? result.extra : undefined;
      results.push({ callId, isError: extra?.is_error });
    }
  }
  for (const { callId, isError } of results) {
    const call = open.get(callId)?.find((entry) => !entry.taken);
    if (!call) continue;
    call.taken = true;
    if (typeof isError === "boolean") flags.set(call.id, isError);
  }
  return flags;
}

/** The adapter's records with the harness as the meta record's `source` and `ok` on each tool
 * record whose result says whether it failed. */
export function withAtifDetails(
  transcript: string,
  records: NormalizedRecord[],
): NormalizedRecord[] {
  const document = parseDocument(transcript);
  const source = atifSource(document);
  const flags = errorFlags(document);
  return records.map((record) => {
    if (record.role === "meta") return { ...record, source };
    if (record.role !== "tool") return record;
    const isError = flags.get(record.tool_call_id);
    return isError === undefined ? record : { ...record, ok: !isError };
  });
}
