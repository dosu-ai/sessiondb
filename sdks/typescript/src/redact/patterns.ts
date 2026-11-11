/** An operator's own redaction patterns, applied to a transcript before the built-in secret
 * patterns. Each is a JavaScript regular expression: its match becomes
 * `[redacted:custom-pattern]`, or only the part a named group `secret` matched, so
 * `api-key: (?<secret>\S+)` keeps `api-key: `.
 *
 * A transcript is JSON: patterns run over each string value of each line (keys and other values
 * are left alone), so a match never breaks the JSON around it. A line with nothing to replace
 * keeps its exact bytes, and the same patterns always turn the same line into the same text.
 *
 * The format is the one Dosu's CLI takes for an org's patterns, so a list works in either. */

import type { RawFormat } from "../schemas/store";

export const CUSTOM_PATTERN_KIND = "custom-pattern";

export interface CompiledPatterns {
  /** Compiled, in the order given. */
  patterns: RegExp[];
  /** Those that are not a usable regular expression, with why. */
  invalid: { pattern: string; reason: string }[];
}

/** Compile `sources`, skipping blank ones; a pattern that does not compile, or that matches the
 * empty string (it would mark every position of every string), is left out and reported. */
export function compilePatterns(sources: readonly string[]): CompiledPatterns {
  const patterns: RegExp[] = [];
  const invalid: CompiledPatterns["invalid"] = [];
  for (const source of sources) {
    if (!source.trim()) continue;
    let re: RegExp;
    try {
      // `d`: where the `secret` group matched; `g`: every match.
      re = new RegExp(source, "dg");
    } catch (err) {
      invalid.push({ pattern: source, reason: err instanceof Error ? err.message : String(err) });
      continue;
    }
    if (new RegExp(re.source).test("")) {
      invalid.push({ pattern: source, reason: "matches empty text" });
      continue;
    }
    patterns.push(re);
  }
  return { patterns, invalid };
}

/** `text` with every match of `patterns` replaced by `[redacted:<kind>]`; the same string when
 * nothing matched. */
export function redactPatterns(
  text: string,
  patterns: readonly RegExp[],
  kind: string = CUSTOM_PATTERN_KIND,
): string {
  const marker = `[redacted:${kind}]`;
  let out = text;
  for (const re of patterns) {
    re.lastIndex = 0;
    let result = "";
    let from = 0;
    for (let m = re.exec(out); m !== null; m = re.exec(out)) {
      const whole = m.indices?.[0];
      if (!whole || whole[0] === whole[1]) {
        // An empty match (a pattern that matches empty text only here): step past it.
        re.lastIndex = m.index + 1;
        continue;
      }
      const secret = m.indices?.groups?.secret;
      const [start, end] = secret ?? whole;
      if (start === end) continue;
      result += out.slice(from, start) + marker;
      from = end;
      if (secret) {
        // The rest of the match is kept, and the search goes on after it.
        result += out.slice(end, whole[1]);
        from = whole[1];
      }
    }
    if (from > 0) out = result + out.slice(from);
  }
  return out;
}

function redactValue(
  value: unknown,
  patterns: readonly RegExp[],
  kind: string,
): { value: unknown; changed: boolean } {
  if (typeof value === "string") {
    const next = redactPatterns(value, patterns, kind);
    return { value: next, changed: next !== value };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const r = redactValue(item, patterns, kind);
      changed ||= r.changed;
      return r.value;
    });
    return changed ? { value: next, changed } : { value, changed };
  }
  if (value !== null && typeof value === "object") {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const r = redactValue(item, patterns, kind);
      changed ||= r.changed;
      next[key] = r.value;
    }
    return changed ? { value: next, changed } : { value, changed };
  }
  return { value, changed: false };
}

/** One JSON document (or a line that is not JSON) with its string values redacted. */
function redactDocument(text: string, patterns: readonly RegExp[], kind: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return redactPatterns(text, patterns, kind);
  }
  const r = redactValue(parsed, patterns, kind);
  return r.changed ? JSON.stringify(r.value) : text;
}

/** A transcript with `patterns` applied: each line of a `jsonl` log, or the whole of a `json`
 * document. */
export function redactTranscriptPatterns(
  transcript: string,
  format: RawFormat,
  patterns: readonly RegExp[],
  kind: string = CUSTOM_PATTERN_KIND,
): string {
  if (patterns.length === 0) return transcript;
  if (format === "json") return redactDocument(transcript, patterns, kind);
  return transcript
    .split("\n")
    .map((line) => (line.trim() ? redactDocument(line, patterns, kind) : line))
    .join("\n");
}
