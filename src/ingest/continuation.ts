/** Resumed sessions: a session that grew after it was stored stores only what is new. The
 * client sends back how many normalized records were stored last time and a hash of them (the
 * `records_total` and `prefix_sha256` of the last answer); when the session's records still
 * start with exactly that prefix, only the meta record plus the tail is written, marked with
 * where the tail starts. Anything else (the harness rewrote history, the normalizer changed) is
 * written in full and dedupes by content. */

import { createHash } from "node:crypto";
import type { NormalizedRecord } from "../schemas/trajectory";

/** What earlier runs already shipped of a session. */
export interface ShippedPrefix {
  /** How many normalized records have shipped, from the start. */
  records: number;
  /** prefixSha256 of those records. */
  prefix_sha256: string;
}

/** The ingest metadata that marks a tail-only upload. */
interface Continuation {
  from_record: number;
  prefix_sha256: string;
}

/** JSON with object keys sorted at every level, so equal records always hash equally. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

/** sha256 (hex) of the canonical JSON of records[0:count]. */
export function prefixSha256(records: readonly NormalizedRecord[], count: number): string {
  return createHash("sha256")
    .update(canonicalJson(records.slice(0, count)))
    .digest("hex");
}

export interface ShipPlan {
  /** The records to upload. */
  records: NormalizedRecord[];
  /** Set when `records` is the meta record plus a tail. */
  continuation?: Continuation;
  /** The records past what already shipped (all of them for a full ship), meta excluded: what
   * worthiness is judged on. */
  fresh: NormalizedRecord[];
}

/** The prefix a fork or clone copied from the session it was made from: its meta record and the
 * leading records the parent's normalized records hold too (past the parent's own meta record).
 * That history is the parent's to ship; undefined when nothing is shared or the parent could not
 * be read. */
export function copiedPrefix(
  records: readonly NormalizedRecord[],
  parentRecords: readonly NormalizedRecord[] | null,
): ShippedPrefix | undefined {
  if (!parentRecords) return undefined;
  const skipMeta = (list: readonly NormalizedRecord[]) => (list[0]?.role === "meta" ? 1 : 0);
  const start = skipMeta(records);
  const parentStart = skipMeta(parentRecords);
  let shared = 0;
  while (
    start + shared < records.length &&
    parentStart + shared < parentRecords.length &&
    canonicalJson(records[start + shared]) === canonicalJson(parentRecords[parentStart + shared])
  ) {
    shared += 1;
  }
  if (shared === 0) return undefined;
  return { records: start + shared, prefix_sha256: prefixSha256(records, start + shared) };
}

/** Ship the tail when the session still starts with what shipped before; otherwise all of it. */
export function planShipment(
  records: NormalizedRecord[],
  shipped: ShippedPrefix | undefined,
): ShipPlan {
  const continues =
    shipped !== undefined &&
    shipped.records > 0 &&
    shipped.records <= records.length &&
    prefixSha256(records, shipped.records) === shipped.prefix_sha256;
  if (!continues) return { records, fresh: records };
  const tail = records.slice(shipped.records);
  const meta = records[0]?.role === "meta" ? [records[0]] : [];
  return {
    records: [...meta, ...tail],
    continuation: { from_record: shipped.records, prefix_sha256: shipped.prefix_sha256 },
    fresh: tail,
  };
}
