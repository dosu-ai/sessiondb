/** Which source wrote a transcript, from the start of the file: for a caller that holds raw logs
 * and does not know which agent wrote them (a bucket of them, say).
 *
 * Two kinds of file. A document format (ATIF, an OpenCode export, a Gemini CLI session) is one
 * JSON object, told apart by its top-level keys, which a truncated sample still has: they are
 * read from the prefix without parsing the whole. A JSONL format is told apart by its records'
 * shape; each source has a predicate for a record only it writes, and the sample is that source's
 * when its records match one source's predicate and no other's. A sample whose records match
 * none, or more than one, is `null`: a guess would file a session under the wrong archive. */

import { validateRecords } from "../schemas/trajectory";
import { ATIF } from "./atif";
import { DATADOG_TRAJECTORY } from "./datadog-trajectory";
import type { Source } from "./index";
import { TRAJECTORY } from "./trajectory";

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A top-level key's value in a document's head: its kind, and the text of a string. */
interface HeadValue {
  kind: "string" | "object" | "array" | "scalar";
  text?: string;
}

type Head = Map<string, HeadValue>;

/** The document formats, by their top-level keys. */
const DOCUMENT_RULES: readonly [Source, (head: Head) => boolean][] = [
  [ATIF, (head) => head.get("schema_version")?.text?.startsWith("ATIF-v") === true],
  // `{ info, messages[] }`: an OpenCode session export.
  [
    "opencode",
    (head) => head.get("info")?.kind === "object" && head.get("messages")?.kind === "array",
  ],
  // `{ sessionId, projectHash, startTime, lastUpdated, messages[] }`: a Gemini CLI session.
  [
    "gemini-cli",
    (head) => head.get("projectHash")?.kind === "string" && head.get("messages")?.kind === "array",
  ],
];

/** The JSONL formats, by a record only that source writes. */
const RECORD_RULES: readonly [Source, (row: Json) => boolean][] = [
  // `{ type: "user" | "assistant", uuid, sessionId, message: { role, content } }`.
  [
    "claude-code",
    (row) =>
      (row.type === "user" || row.type === "assistant") &&
      isObject(row.message) &&
      typeof row.uuid === "string",
  ],
  // `{ timestamp, type: "session_meta" | "response_item" | …, payload: {…} }`.
  [
    "codex",
    (row) =>
      typeof row.type === "string" &&
      ["session_meta", "response_item", "event_msg", "turn_context"].includes(row.type) &&
      isObject(row.payload),
  ],
  // `{ role, message: { content } }`, no `type`.
  [
    "cursor",
    (row) =>
      (row.role === "user" || row.role === "assistant") &&
      isObject(row.message) &&
      !("type" in row),
  ],
  // A `{ type: "session", id, cwd }` header, then `{ type: "message", id, message: { role } }`.
  [
    "pi",
    (row) =>
      (row.type === "session" && typeof row.id === "string" && typeof row.cwd === "string") ||
      (row.type === "message" && isObject(row.message) && typeof row.message.role === "string"),
  ],
  // `{ session_id, event_type, sequence_number, … }`: a Datadog Trajectory session stream.
  [
    DATADOG_TRAJECTORY,
    (row) =>
      typeof row.session_id === "string" &&
      typeof row.event_type === "string" &&
      typeof row.sequence_number === "number",
  ],
  // A trajectory-v1 record: `role` and flat fields, nothing a native log wraps it in.
  [TRAJECTORY, (row) => !("type" in row) && !("message" in row) && isTrajectoryRecord(row)],
];

function isTrajectoryRecord(row: Json): boolean {
  try {
    validateRecords([row]);
    return true;
  } catch {
    return false;
  }
}

/** The source whose distinctive shape `sample` (the start of one file, any length; its last line
 * may be cut short) matches, or `null` when it matches none or more than one. */
export function detectSource(sample: string): Source | null {
  const text = sample.replace(/^﻿/, "");
  const head = documentHead(text);
  if (head) {
    const documents = DOCUMENT_RULES.filter(([, matches]) => matches(head));
    if (documents.length > 0) return documents.length === 1 ? documents[0][0] : null;
  }
  const rows = jsonLines(text);
  if (!rows) return null;
  const found = new Set<Source>();
  for (const row of rows) {
    for (const [source, matches] of RECORD_RULES) if (matches(row)) found.add(source);
  }
  return found.size === 1 ? [...found][0] : null;
}

/** The sample's lines as JSON objects, less a last line that does not parse (cut short), or
 * `null` when any other line is not a JSON object: then it is not JSONL. */
function jsonLines(text: string): Json[] | null {
  const lines = text.split("\n");
  const rows: Json[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      if (index === lines.length - 1) break;
      return null;
    }
    if (!isObject(value)) return null;
    rows.push(value);
  }
  return rows;
}

/** The top-level keys of the JSON object `text` starts with, as far as `text` goes, or `null`
 * when it does not start with one. A key whose value is cut short is left out. */
function documentHead(text: string): Head | null {
  let at = skipSpace(text, 0);
  if (text[at] !== "{") return null;
  const head: Head = new Map();
  at += 1;
  for (;;) {
    at = skipSpace(text, at);
    if (text[at] === ",") at = skipSpace(text, at + 1);
    if (text[at] !== '"') return head;
    const keyEnd = skipValue(text, at);
    if (keyEnd < 0) return head;
    const key = JSON.parse(text.slice(at, keyEnd)) as string;
    at = skipSpace(text, keyEnd);
    if (text[at] !== ":") return head;
    at = skipSpace(text, at + 1);
    const end = skipValue(text, at);
    if (end < 0) {
      // Cut short inside the value; its kind is still known.
      const kind = text[at] === "{" ? "object" : text[at] === "[" ? "array" : undefined;
      if (kind) head.set(key, { kind });
      return head;
    }
    const first = text[at];
    if (first === '"') head.set(key, { kind: "string", text: JSON.parse(text.slice(at, end)) });
    else if (first === "{") head.set(key, { kind: "object" });
    else if (first === "[") head.set(key, { kind: "array" });
    else head.set(key, { kind: "scalar" });
    at = end;
  }
}

function skipSpace(text: string, at: number): number {
  while (at < text.length && /\s/.test(text[at])) at += 1;
  return at;
}

/** The index just past the JSON value starting at `at`, or -1 when the text ends inside it. */
function skipValue(text: string, at: number): number {
  let depth = 0;
  let inString = false;
  for (let i = at; i < text.length; i += 1) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i += 1;
      else if (c === '"') {
        inString = false;
        if (depth === 0) return i + 1;
      }
    } else if (c === '"') inString = true;
    else if (c === "{" || c === "[") depth += 1;
    else if (c === "}" || c === "]") {
      depth -= 1;
      if (depth === 0) return i + 1;
      if (depth < 0) return i;
    } else if (depth === 0 && (c === "," || /\s/.test(c))) return i;
  }
  return -1;
}
