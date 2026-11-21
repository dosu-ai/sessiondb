import type { BaseLayer, ListAddition } from "./load";
import { RUNTIME_SECTIONS } from "./server/index";
import { isPlainObject } from "./shape";

/** Where a server keeps the sources the admin API writes (`server.runtime_config = store`),
 * one object each: outside `config/`, which serverless laptops copy and may read. */
export const RUNTIME_SOURCES_PREFIX = "runtime/sources/";
/** Each instance's last word on the runtime config it runs (`seshi/runtime-instance/1`). */
export const RUNTIME_INSTANCES_PREFIX = "runtime/instances/";

/** The lists the runtime config adds to rather than sets: a file's entries stay, as with
 * drop-ins. */
export const RUNTIME_LISTS: readonly (readonly string[])[] = [
  ["redaction", "packs"],
  ["capture", "exclude"],
  ["capture", "redact_tool_calls"],
];

/** The bucket's runtime config as a server reads it: `config/seshi.toml` (its pack and prompt
 * paths pointing into a local copy) and the stored sources, their secrets unsealed. */
export interface RuntimeLayer {
  doc?: BaseLayer;
  sources: readonly { origin: string; source: Record<string, unknown> }[];
}

/** The loader options that put `layer` under the files: the doc's settings as the lowest
 * layer, its lists and the sources appended after the drop-ins. Sections of the doc a server
 * does not take from the bucket are left out and named in `ignored`. */
export function runtimeLoadOptions(layer: RuntimeLayer): {
  base?: BaseLayer;
  additions: ListAddition[];
  ignored: string[];
} {
  const additions: ListAddition[] = [];
  const ignored: string[] = [];
  let base: BaseLayer | undefined;
  if (layer.doc) {
    const tree = structuredClone(layer.doc.tree);
    for (const key of Object.keys(tree)) {
      if (!(RUNTIME_SECTIONS as readonly string[]).includes(key)) {
        ignored.push(
          `${layer.doc.path}: [${key}] is not read from the bucket on a server; set it in seshi.toml`,
        );
        delete tree[key];
      }
    }
    for (const list of RUNTIME_LISTS) {
      const items = takeList(tree, list);
      if (items !== undefined) additions.push({ origin: layer.doc.path, list, items });
    }
    base = { path: layer.doc.path, tree };
  }
  for (const { origin, source } of layer.sources) {
    additions.push({ origin, list: ["sources"], items: [source], skipKnownIds: true });
  }
  return { ...(base ? { base } : {}), additions, ignored };
}

function takeList(tree: Record<string, unknown>, path: readonly string[]): unknown[] | undefined {
  let at: unknown = tree;
  for (const key of path.slice(0, -1)) {
    if (!isPlainObject(at)) return undefined;
    at = at[key];
  }
  if (!isPlainObject(at)) return undefined;
  const last = path.at(-1) as string;
  const value = at[last];
  if (value === undefined) return undefined;
  delete at[last];
  // A doc that sets a list to something else keeps it in the base, where the schema says why.
  if (!Array.isArray(value)) {
    at[last] = value;
    return undefined;
  }
  return value;
}
