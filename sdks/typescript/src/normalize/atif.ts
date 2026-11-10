/** ATIF documents, adjusted around what @letta-ai/trajectory's atif adapter does with them.
 *
 * ATIF is Harbor's Agent Trajectory Interchange Format (harbor-framework/harbor, RFC 0001): one
 * JSON document per session, exported by a tool such as Decant from whichever harness ran it.
 * The adapter reads ATIF-v1.0 through ATIF-v1.7 and loses two things a reader wants.
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

/** The schema versions the pinned adapter reads. */
const SUPPORTED_VERSION = /^ATIF-v1\.[0-7]$/;

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
  return `${version} is not supported: this normalizer reads ATIF-v1.0 through ATIF-v1.7`;
}

/** The trace source for a document: its `agent.name` when that is a non-blank scope
 * coordinate, else `atif`. */
export function atifSource(document: Json | null): string {
  const agent = document?.agent;
  const name = isObject(agent) ? agent.name : undefined;
  return typeof name === "string" && name.trim() !== "" && isScopeCoordinate(name) ? name : ATIF;
}

/** Each tool call id's error flags, in document order, for the results that carry one. A
 * result without a boolean `extra.is_error` holds its place with undefined. */
function errorFlags(document: Json | null): Map<string, (boolean | undefined)[]> {
  const flags = new Map<string, (boolean | undefined)[]>();
  const steps = document?.steps;
  if (!Array.isArray(steps)) return flags;
  for (const step of steps) {
    if (!isObject(step) || !isObject(step.observation)) continue;
    const results = step.observation.results;
    if (!Array.isArray(results)) continue;
    for (const result of results) {
      if (!isObject(result) || typeof result.source_call_id !== "string") continue;
      const isError = isObject(result.extra) ? result.extra.is_error : undefined;
      const list = flags.get(result.source_call_id) ?? [];
      list.push(typeof isError === "boolean" ? isError : undefined);
      flags.set(result.source_call_id, list);
    }
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
    // Results answer their calls in document order; the nth record for an id is its nth result.
    const isError = flags.get(record.tool_call_id)?.shift();
    return isError === undefined ? record : { ...record, ok: !isError };
  });
}
