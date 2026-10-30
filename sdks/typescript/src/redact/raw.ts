/** Redaction of a native transcript before it is stored as a session's raw part, the first
 * object written for a session and what its trace is normalized from. Two passes, by
 * `RawFormat`:
 *
 * - `jsonl` (Claude Code, Cursor, Codex, pi): each line parsed, every string value redacted, keys
 *   and non-string values untouched; a line that is not JSON is redacted whole.
 * - `json` (OpenCode's export document, the folded Gemini session): every string value in the
 *   document, keys untouched.
 *
 * Unlike the record pass there is no structural-key allowlist: nothing downstream links raw
 * values by identity, and over-redacting a raw id costs nothing. */

import type { RawFormat } from "../schemas/store";
import { redactSecrets } from "./secrets";

function redactString(text: string): string {
  return redactSecrets(text).text;
}

function redactStrings(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(redactStrings);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactStrings(v)]));
  }
  return value;
}

/** The line pass. Line endings are preserved (`\n`; a trailing newline stays). */
function redactJsonl(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      if (line.trim() === "") return line;
      try {
        return JSON.stringify(redactStrings(JSON.parse(line)));
      } catch {
        return redactString(line);
      }
    })
    .join("\n");
}

/** The document pass. Output is re-serialized compact JSON; a document that does not parse is
 * redacted as one string. */
function redactJsonDocument(text: string): string {
  try {
    return JSON.stringify(redactStrings(JSON.parse(text)));
  } catch {
    return redactString(text);
  }
}

export function redactRaw(text: string, format: RawFormat): string {
  return format === "jsonl" ? redactJsonl(text) : redactJsonDocument(text);
}
