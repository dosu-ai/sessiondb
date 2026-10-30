/** Text canonicalization before hashing. `content_hash` is computed over the result, so these
 * follow Python's string semantics (`str.rstrip`, `str.splitlines`) on purpose: a reader in any
 * language can reproduce the hash from the documented rule without matching ECMAScript quirks. */

/** The characters Python's `str.rstrip()` strips with no argument: those for which
 * `str.isspace()` is true (bidirectional class WS, B or S, or category Zs). Not the same set as
 * ECMAScript's `trimEnd()`, which strips U+FEFF and not U+001C–U+001F. */
const PY_WHITESPACE = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001,
  0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f,
  0x205f, 0x3000,
]);

/** Python's `str.rstrip()`. */
function pyRstrip(s: string): string {
  let end = s.length;
  while (end > 0 && PY_WHITESPACE.has(s.charCodeAt(end - 1))) end--;
  return end === s.length ? s : s.slice(0, end);
}

/** Normalize line endings and trailing whitespace so excerpt matching is stable. */
export function canonicalText(text: string): string {
  return text.replaceAll("\r\n", "\n").split("\n").map(pyRstrip).join("\n");
}

/** A copy of `value` with U+0000 removed from every string. Postgres text and jsonb reject NUL,
 * and real transcripts (a Codex rollout, 2026-09) carry it. */
export function stripNul<T>(value: T): T {
  if (typeof value === "string") return value.replaceAll("\0", "") as T;
  if (Array.isArray(value)) return value.map(stripNul) as T;
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, stripNul(v)]),
    ) as T;
  }
  return value;
}
