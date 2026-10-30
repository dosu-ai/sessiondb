/** Redaction of trajectory-v1 records: every non-structural string passes through
 * `redactSecrets`. Runs on the normalized records rather than the raw transcript, where the
 * entropy pass would corrupt high-entropy tool-call ids and break the records' linkage.
 * Idempotent: a redacted record set redacts to itself. Deterministic by construction, which
 * `content_hash` and continuation prefixes (computed over its output) depend on. */

import type { NormalizedRecord } from "../schemas/trajectory";
import { redactSecrets } from "./secrets";

/** Keys whose string values are structural identity, not text: redacting them would break the
 * tool_call ↔ tool_result linkage or the record framing itself, or (the meta record's
 * `git_branch`, which a Jira-style name trips the entropy pass on) scope the session by a
 * placeholder its prompts never asked with. Everything else is redacted. */
const STRUCTURAL_KEYS: ReadonlySet<string> = new Set([
  "id",
  "tool_call_id",
  "role",
  "timestamp",
  "source",
  "name",
  "git_branch",
]);

function redactValue(value: unknown, key?: string): unknown {
  if (typeof value === "string") {
    return key !== undefined && STRUCTURAL_KEYS.has(key) ? value : redactSecrets(value).text;
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactValue(v, k)]));
  }
  return value;
}

/** The records with every non-structural string redacted. */
export function redactRecords(records: readonly NormalizedRecord[]): NormalizedRecord[] {
  return records.map((record) => redactValue(record) as NormalizedRecord);
}
