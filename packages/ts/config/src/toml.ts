import { isPlainObject, type PlainObject } from "./shape";

/** TOML for a parsed config tree (what `Bun.TOML.parse` gives back): scalars and lists of
 * scalars inline, tables as `[a.b]`, lists of tables as `[[a.b]]`. Comments are not kept. */
export function stringifyToml(tree: PlainObject): string {
  const out: string[] = [];
  writeTable(out, tree, []);
  return `${out
    .join("\n")
    .replace(/^\n+/, "")
    .replace(/\n{3,}/g, "\n\n")}\n`;
}

function isTableList(value: unknown): value is PlainObject[] {
  return Array.isArray(value) && value.length > 0 && value.every(isPlainObject);
}

function writeTable(out: string[], table: PlainObject, path: string[]): void {
  const tables: [string, PlainObject][] = [];
  const lists: [string, PlainObject[]][] = [];
  for (const [key, value] of Object.entries(table)) {
    if (value === undefined) continue;
    if (isPlainObject(value)) tables.push([key, value]);
    else if (isTableList(value)) lists.push([key, value]);
    else out.push(`${tomlKey(key)} = ${inline(value)}`);
  }
  for (const [key, value] of tables) {
    const at = [...path, key];
    const scalars = Object.values(value).some((v) => !isPlainObject(v) && !isTableList(v));
    if (scalars || Object.keys(value).length === 0) out.push("", `[${at.map(tomlKey).join(".")}]`);
    writeTable(out, value, at);
  }
  for (const [key, items] of lists) {
    const at = [...path, key];
    for (const item of items) {
      out.push("", `[[${at.map(tomlKey).join(".")}]]`);
      writeTable(out, item, at);
    }
  }
}

export function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : tomlString(key);
}

/** A TOML basic string: JSON's escapes are TOML's, and DEL, which JSON leaves bare, is
 * escaped. */
export function tomlString(value: string): string {
  return JSON.stringify(value).replace(/\x7f/g, "\\u007f");
}

function inline(value: unknown): string {
  if (typeof value === "string") return tomlString(value);
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${value} has no TOML form`);
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(inline).join(", ")}]`;
  if (isPlainObject(value)) {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    return entries.length === 0
      ? "{}"
      : `{ ${entries.map(([k, v]) => `${tomlKey(k)} = ${inline(v)}`).join(", ")} }`;
  }
  if (value instanceof Date) return value.toISOString();
  throw new Error(`a ${typeof value} has no TOML form`);
}
