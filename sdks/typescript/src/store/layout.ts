/** The key layout: the contract between every writer and every reader. See `spec/layout.md`.
 *
 * ```
 * sessionstorage.json                                     layout marker
 * owners/<owner>/.probe                              a writer's write check
 * owners/<owner>/sessions/<archive_id>/metadata.json
 * owners/<owner>/sessions/<archive_id>/trace.<content_hash>.json.gz
 * owners/<owner>/sessions/<archive_id>/raw.<n>.<jsonl|json>.gz
 * owners/<owner>/changes/<rfc3339>-<content_hash|tombstone>.json
 * ```
 */

import { createHash } from "node:crypto";
import type { RawFormat } from "../schemas/store";
import { StoreError } from "./store";

const OWNER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** An owner name is one path segment: letters, digits, `.`, `_`, `-`. */
export function assertOwner(owner: string): string {
  if (!OWNER.test(owner)) throw new StoreError(`invalid owner: ${JSON.stringify(owner)}`);
  return owner;
}

/** `sha256(owner + "\n" + agent + "\n" + session_id)`: deterministic, so every upload for one
 * session lands in one directory; derived, so no native id or path appears in a key. */
export function archiveId(owner: string, agent: string, sessionId: string): string {
  return createHash("sha256").update(`${owner}\n${agent}\n${sessionId}`, "utf8").digest("hex");
}

export const LAYOUT_KEY = "sessionstorage.json";

export const keys = {
  owner: (owner: string) => `owners/${assertOwner(owner)}`,
  probe: (owner: string) => `${keys.owner(owner)}/.probe`,
  session: (owner: string, archive: string) => `${keys.owner(owner)}/sessions/${archive}`,
  sessions: (owner: string) => `${keys.owner(owner)}/sessions/`,
  metadata: (owner: string, archive: string) => `${keys.session(owner, archive)}/metadata.json`,
  trace: (owner: string, archive: string, hash: string) =>
    `${keys.session(owner, archive)}/trace.${hash}.json.gz`,
  raw: (owner: string, archive: string, part: number, format: RawFormat) =>
    `${keys.session(owner, archive)}/raw.${part}.${format}.gz`,
  changes: (owner: string) => `${keys.owner(owner)}/changes/`,
  change: (owner: string, at: string, hash: string | null) =>
    `${keys.changes(owner)}${changeStamp(at)}-${hash ?? "tombstone"}.json`,
} as const;

/** The change-key timestamp: RFC 3339 UTC to the millisecond with `:` dropped, so keys sort by
 * time and are valid on every filesystem. `2026-10-21T21:04:05.123Z` → `20261021T210405.123Z`. */
export function changeStamp(at: string): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) throw new StoreError(`invalid timestamp: ${at}`);
  return d.toISOString().replaceAll("-", "").replaceAll(":", "");
}
