import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import * as z from "zod";
import {
  type Assignment,
  applyAssignment,
  ENV_PREFIX,
  envAssignments,
  namesSetting,
  PlacementError,
  recordFile,
} from "./layers";
import { describeOrigin, formatPath, type Origin, Origins, type PathSegment } from "./origins";
import { Secret } from "./secret";
import {
  formatOf,
  isPlainObject,
  isSecret,
  isTable,
  type JsonSchema,
  nodeAt,
  type PlainObject,
} from "./shape";

export interface ConfigFs {
  readFile(path: string): string;
  mode(path: string): number | undefined;
  /** The names in a folder; none when it does not exist. Only drop-ins need it. */
  list?(dir: string): string[];
}

export const nodeFs: ConfigFs = {
  readFile: (path) => readFileSync(path, "utf8"),
  list(dir) {
    try {
      return readdirSync(dir);
    } catch (err) {
      if ((err as { code?: unknown }).code === "ENOENT") return [];
      throw err;
    }
  },
  mode(path) {
    try {
      return statSync(path).mode;
    } catch {
      return undefined;
    }
  },
};

export interface FlagValue {
  name: string;
  path: string;
  value: string;
}

/** A config document below the file: another file's settings, already parsed (F11.6, the
 * bucket's shared `config/seshi.toml`). Its tables are merged under the file's, value by
 * value; a list in the file replaces the base's. */
export interface BaseLayer {
  /** Where it came from, for origins and messages (`s3://acme/seshi/config/seshi.toml`). */
  path: string;
  tree: Record<string, unknown>;
}

/** A folder of `*.toml` files read after the file, in name order, that may only add to some
 * lists (`[[sources]]`, `redaction.packs`): so another program can add a source in a file of
 * its own without rewriting the operator's. */
export interface DropIns {
  dir: string;
  /** The lists a drop-in may add to, as paths (`["sources"]`). */
  lists: readonly (readonly string[])[];
}

/** Items appended to a list after the file and its drop-ins, as a drop-in adds them: the
 * bucket's runtime config (its lists, and the sources stored one object each). */
export interface ListAddition {
  /** Where they came from, for origins and messages. */
  origin: string;
  list: readonly string[];
  items: unknown[];
  /** Leave out an item whose `id` is already in the list (a file's source wins), with a
   * warning. */
  skipKnownIds?: boolean;
}

export interface LoadOptions {
  /** Lowest layer above the built-in defaults. */
  base?: BaseLayer;
  /** Added to lists after the drop-ins, before env and flags. */
  additions?: readonly ListAddition[];
  file?: string;
  dropIns?: DropIns;
  /** Top-level tables the file's own settings are read without. */
  omit?: readonly string[];
  env?: Record<string, string | undefined>;
  flags?: readonly FlagValue[];
  ignoreEnv?: readonly string[];
  foreign?: readonly JsonSchema[];
  resolveSecrets?: boolean;
  platform?: NodeJS.Platform;
  fs?: ConfigFs;
}

export interface Loaded<T> {
  config: T;
  file?: string;
  /** The drop-in files read, in order. */
  dropIns: string[];
  origins: Origins;
  warnings: string[];
  shape: JsonSchema;
}

export class ConfigError extends Error {
  file?: string;

  constructor(readonly issues: string[]) {
    super(issues.length === 1 ? issues[0] : `${issues.length} problems:\n  ${issues.join("\n  ")}`);
    this.name = "ConfigError";
  }
}

export function shapeOf(schema: z.ZodType): JsonSchema {
  return z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as JsonSchema;
}

function suffix(origin: Origin): string {
  switch (origin.source) {
    case "env":
      return ` (from env ${origin.name})`;
    case "flag":
      return ` (from flag ${origin.name})`;
    case "file":
      return ` (in ${origin.path})`;
    default:
      return "";
  }
}

function idLookup(tree: unknown) {
  return (prefix: readonly PathSegment[]): string | undefined => {
    let value: unknown = tree;
    for (const segment of prefix) {
      if (Array.isArray(value) && typeof segment === "number") value = value[segment];
      else if (isPlainObject(value) && typeof segment === "string") value = value[segment];
      else return undefined;
    }
    return isPlainObject(value) && typeof value.id === "string" ? value.id : undefined;
  };
}

function valueAt(tree: unknown, path: readonly PathSegment[]): unknown {
  let value = tree;
  for (const segment of path) {
    if (Array.isArray(value) && typeof segment === "number") value = value[segment];
    else if (isPlainObject(value) && typeof segment === "string") value = value[segment];
    else return undefined;
  }
  return value;
}

function describeIssue(
  issue: z.core.$ZodIssue,
  shape: JsonSchema,
  tree: PlainObject,
  origins: Origins,
): string[] {
  const path = issue.path as PathSegment[];
  const ids = idLookup(tree);
  if (issue.code === "unrecognized_keys") {
    return issue.keys.map((key) => {
      const at = [...path, key];
      return `${formatPath(at, ids)}: unknown key${suffix(origins.get(at))}`;
    });
  }
  const node = nodeAt(shape, tree, path);
  let message = issue.message.replace(/^Invalid input: /, "");
  const options = (issue as { options?: unknown[] }).options;
  if (
    (issue.code === "invalid_type" || issue.code === "invalid_union") &&
    valueAt(tree, path) === undefined
  ) {
    message = "required";
  } else if (issue.code === "invalid_union" && "discriminator" in issue && options) {
    message = `must be one of ${options.join(", ")}`;
  } else if (isSecret(node)) {
    message = 'expected a string, { env = "NAME" } or { file = "/path" }';
  } else if (formatOf(node) === "duration") {
    message = 'expected a duration such as "90s", "10m", "1h", "30d", or milliseconds';
  } else if (formatOf(node) === "bytes") {
    message = 'expected a size such as "512KiB", "32MiB", "1GiB", or bytes';
  }
  const required = node && isTable(node) && Array.isArray(node.required) ? node.required : [];
  if (message === "required" && required.length > 0) {
    return required.map(
      (key) => `${formatPath([...path, String(key)], ids)}: required${suffix(origins.get(path))}`,
    );
  }
  const where = path.length === 0 ? "config" : formatPath(path, ids);
  return [`${where}: ${message}${suffix(origins.get(path))}`];
}

export function secretsIn(value: unknown): Array<{ path: PathSegment[]; secret: Secret }> {
  const found: Array<{ path: PathSegment[]; secret: Secret }> = [];
  const visit = (v: unknown, path: PathSegment[]): void => {
    if (v instanceof Secret) found.push({ path, secret: v });
    else if (Array.isArray(v)) {
      v.forEach((item, i) => {
        visit(item, [...path, i]);
      });
    } else if (isPlainObject(v))
      for (const [k, child] of Object.entries(v)) visit(child, [...path, k]);
  };
  visit(value, []);
  return found;
}

export function parseConfigToml(file: string, text: string): PlainObject {
  return parseToml(file, text);
}

function mergeTables(under: PlainObject, over: PlainObject): PlainObject {
  const merged: PlainObject = { ...under };
  for (const [key, value] of Object.entries(over)) {
    const below = merged[key];
    merged[key] = isPlainObject(below) && isPlainObject(value) ? mergeTables(below, value) : value;
  }
  return merged;
}

function parseToml(file: string, text: string): PlainObject {
  try {
    const parsed: unknown = Bun.TOML.parse(text);
    return isPlainObject(parsed) ? parsed : {};
  } catch (err) {
    throw new ConfigError([`${file}: not valid TOML: ${err instanceof Error ? err.message : err}`]);
  }
}

function referencedEnv(
  shape: JsonSchema,
  tree: PlainObject,
  env: Record<string, string | undefined>,
): string[] {
  const names: string[] = [];
  const visit = (value: unknown, path: PathSegment[]): void => {
    if (isPlainObject(value)) {
      if (typeof value.env === "string" && isSecret(nodeAt(shape, tree, path))) {
        names.push(value.env);
        return;
      }
      for (const [key, child] of Object.entries(value)) visit(child, [...path, key]);
    } else if (Array.isArray(value)) {
      value.forEach((child, i) => {
        visit(child, [...path, i]);
      });
    }
  };
  visit(tree, []);
  for (const [name, value] of Object.entries(env)) {
    if (name.startsWith(ENV_PREFIX) && name.endsWith("__ENV") && value) names.push(value);
  }
  return names;
}

function readDropIns(
  fs: ConfigFs,
  { dir, lists }: DropIns,
  shape: JsonSchema,
  tree: PlainObject,
  origins: Origins,
): string[] {
  const files = (fs.list?.(dir) ?? [])
    .filter((name) => name.endsWith(".toml") && !name.startsWith("."))
    .sort()
    .map((name) => join(dir, name));
  const names = lists.map((list) => list.join("."));
  const allowed =
    names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? "");
  for (const file of files) {
    let text: string;
    try {
      text = fs.readFile(file);
    } catch (err) {
      throw new ConfigError([`cannot read ${file}: ${err instanceof Error ? err.message : err}`]);
    }
    const own = parseToml(file, text);
    const adds: { list: readonly string[]; items: unknown[] }[] = [];
    for (const list of lists) {
      const items = takeAt(own, list);
      if (items === undefined) continue;
      if (!Array.isArray(items)) {
        throw new ConfigError([`${file}: ${list.join(".")} must be a list`]);
      }
      adds.push({ list, items });
    }
    const left = leafPaths(own);
    if (left.length > 0) {
      throw new ConfigError([
        `${file}: a drop-in may only add to ${allowed}; ${left.join(", ")} belong${left.length === 1 ? "s" : ""} in the main config file`,
      ]);
    }
    for (const { list, items } of adds) {
      const before = valueAt(tree, list);
      const existing = Array.isArray(before) ? before : [];
      // Sparse up to the existing items, so only the drop-in's own items get its origin.
      const shifted = new Array(existing.length).concat(items);
      recordFile(shape, nest(list, shifted), { source: "file", path: file }, origins);
      setNested(tree, list, [...existing, ...items]);
    }
  }
  return files;
}

function takeAt(tree: PlainObject, path: readonly string[]): unknown {
  let at: unknown = tree;
  for (const key of path.slice(0, -1)) {
    if (!isPlainObject(at)) return undefined;
    at = at[key];
  }
  if (!isPlainObject(at)) return undefined;
  const last = path.at(-1) as string;
  const value = at[last];
  delete at[last];
  return value;
}

function leafPaths(value: unknown, path: string[] = []): string[] {
  if (!isPlainObject(value)) return [path.join(".")];
  return Object.entries(value).flatMap(([key, child]) => leafPaths(child, [...path, key]));
}

function nest(path: readonly string[], value: unknown): PlainObject {
  return path.reduceRight<unknown>((inner, key) => ({ [key]: inner }), value) as PlainObject;
}

function setNested(tree: PlainObject, path: readonly string[], value: unknown): void {
  let at = tree;
  for (const key of path.slice(0, -1)) {
    if (!isPlainObject(at[key])) at[key] = {};
    at = at[key] as PlainObject;
  }
  at[path.at(-1) as string] = value;
}

export function loadConfig<S extends z.ZodType>(
  schema: S,
  options: LoadOptions = {},
): Loaded<z.output<S>> {
  try {
    return load(schema, options);
  } catch (err) {
    if (err instanceof ConfigError) err.file = options.file;
    throw err;
  }
}

function load<S extends z.ZodType>(schema: S, options: LoadOptions): Loaded<z.output<S>> {
  const fs = options.fs ?? nodeFs;
  const env = options.env ?? {};
  const shape = shapeOf(schema);
  const origins = new Origins();
  const issues: string[] = [];
  const warnings: string[] = [];

  let tree: PlainObject = {};
  if (options.base !== undefined) {
    tree = structuredClone(options.base.tree) as PlainObject;
    recordFile(shape, tree, { source: "file", path: options.base.path }, origins);
  }
  if (options.file !== undefined) {
    let text: string;
    try {
      text = fs.readFile(options.file);
    } catch (err) {
      throw new ConfigError([
        `cannot read ${options.file}: ${err instanceof Error ? err.message : err}`,
      ]);
    }
    const own = parseToml(options.file, text);
    for (const key of options.omit ?? []) delete own[key];
    recordFile(shape, own, { source: "file", path: options.file }, origins);
    tree = mergeTables(tree, own);
  }
  const dropIns = options.dropIns ? readDropIns(fs, options.dropIns, shape, tree, origins) : [];
  for (const addition of options.additions ?? []) {
    const before = valueAt(tree, addition.list);
    const existing = Array.isArray(before) ? before : [];
    const known = new Set(
      existing.flatMap((item) =>
        isPlainObject(item) && typeof item.id === "string" ? [item.id] : [],
      ),
    );
    const items = addition.items.filter((item) => {
      const id = isPlainObject(item) && typeof item.id === "string" ? item.id : undefined;
      if (addition.skipKnownIds && id !== undefined && known.has(id)) {
        warnings.push(
          `${addition.origin}: ${addition.list.join(".")} '${id}' is also in a config file, which wins; this one is not used`,
        );
        return false;
      }
      if (id !== undefined) known.add(id);
      return true;
    });
    if (items.length === 0) continue;
    const shifted = new Array(existing.length).concat(items);
    recordFile(
      shape,
      nest(addition.list, shifted),
      { source: "file", path: addition.origin },
      origins,
    );
    setNested(tree, addition.list, [...existing, ...items]);
  }

  const ignore = new Set([...(options.ignoreEnv ?? []), ...referencedEnv(shape, tree, env)]);
  const assignments: Assignment[] = [
    ...envAssignments(env, ignore),
    ...(options.flags ?? []).map((flag) => ({
      name: flag.name,
      source: "flag" as const,
      segments: flag.path.split("."),
      value: flag.value,
    })),
  ];
  for (const assignment of assignments) {
    if (assignment.segments.some((s) => s === "")) {
      issues.push(`${assignment.name}: not a setting (empty key)`);
      continue;
    }
    try {
      applyAssignment(shape, tree, assignment, origins);
    } catch (err) {
      if (!(err instanceof PlacementError)) throw err;
      const foreign =
        assignment.source === "env" &&
        (options.foreign ?? []).some((other) => namesSetting(other, assignment));
      if (foreign) continue;
      issues.push(
        err.unknown
          ? `${assignment.name}: not a setting (${err.message})`
          : `${assignment.name}: ${err.message}`,
      );
    }
  }
  if (issues.length > 0) throw new ConfigError(issues);

  const parsed = schema.safeParse(tree);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push(...describeIssue(issue, shape, tree, origins));
    }
    throw new ConfigError(issues);
  }
  const config = parsed.data;
  const ids = idLookup(config);

  const secrets = secretsIn(config);
  if (options.resolveSecrets ?? true) {
    for (const { path, secret } of secrets) {
      try {
        secret.resolve({ env, readFile: fs.readFile });
      } catch (err) {
        issues.push(
          `${formatPath(path, ids)}: ${err instanceof Error ? err.message : err}${suffix(origins.get(path))}`,
        );
      }
    }
    if (issues.length > 0) throw new ConfigError(issues);
  }

  if ((options.platform ?? process.platform) !== "win32") {
    const byFile = new Map<string, PathSegment[][]>();
    for (const { path, secret } of secrets) {
      const origin = origins.get(path);
      if (secret.ref.kind !== "literal" || origin.source !== "file") continue;
      if (origin.path !== options.file && !dropIns.includes(origin.path)) continue;
      byFile.set(origin.path, [...(byFile.get(origin.path) ?? []), path]);
    }
    for (const [file, paths] of byFile) {
      const mode = fs.mode(file);
      if (mode !== undefined && (mode & 0o077) !== 0) {
        warnings.push(
          `${file} holds literal secrets (${paths
            .map((path) => formatPath(path, ids))
            .join(
              ", ",
            )}) and group or others can read it: use { env = "NAME" } or { file = "/path" } references, or chmod 600 ${file}`,
        );
      }
    }
  }

  return { config, file: options.file, dropIns, origins, warnings, shape };
}

export function originOf<T>(loaded: Loaded<T>, path: readonly PathSegment[]): string {
  return describeOrigin(loaded.origins.get(path));
}
