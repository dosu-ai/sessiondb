/** The change feed: `owners/<owner>/changes/` listed after a cursor. Keys are time-prefixed, so
 * a plain `list` with `startAfter` is the feed; the cursor is the last key processed. Entries
 * are written by clocks on laptops, so a consumer re-reads a lag window behind its cursor and
 * dedupes by key rather than trusting strict order. */

import type { ChangeEntry } from "../schemas/store";
import { changeStamp, keys } from "./layout";
import { decodeJson } from "./publish";
import type { Store } from "./store";

export interface ChangesPage {
  entries: { key: string; entry: ChangeEntry }[];
  /** Pass as `after` to continue. */
  cursor: string | undefined;
  truncated: boolean;
}

export interface ReadChangesOptions {
  /** The last key already processed; omit to start from the beginning. */
  after?: string;
  /** Alternative to `after`: start from this time (ISO 8601). Ignored when `after` is given. */
  since?: string;
  limit?: number;
}

export async function readChanges(
  store: Store,
  owner: string,
  options: ReadChangesOptions = {},
): Promise<ChangesPage> {
  const prefix = keys.changes(owner);
  const startAfter =
    options.after ??
    (options.since !== undefined ? `${prefix}${changeStamp(options.since)}` : undefined);
  const page = await store.list(prefix, { startAfter, limit: options.limit });
  const entries = await Promise.all(
    page.keys.map(async (key) => {
      const bytes = await store.get(key);
      if (bytes === null) return null;
      return { key, entry: decodeJson<ChangeEntry>(bytes) };
    }),
  );
  const present = entries.filter((e): e is { key: string; entry: ChangeEntry } => e !== null);
  return { entries: present, cursor: page.keys.at(-1), truncated: page.truncated };
}
