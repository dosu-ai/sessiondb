/** The two mutable objects in the store and the one append-only one. See `docs/layout.md`.
 *
 * `metadata.json` is the live pointer for one session: what raw parts it has, which trace is its
 * head, which traces it has had, and whether it has been redacted. The raw comes first: a session
 * exists from the moment its transcript is stored, and gets a head when the transcript
 * normalizes to something worth a trace. `changes/<key>.json` is one entry per publish or
 * tombstone, what a reader tails. */

export const METADATA_SCHEMA = "sessionstorage/metadata/1" as const;
export const CHANGE_SCHEMA = "sessionstorage/change/1" as const;
export const LAYOUT_SCHEMA = "sessionstorage/layout/1" as const;

export type SessionStatus = "stored" | "redacted";

/** How a raw transcript part is encoded: one JSON value per line, or one JSON document. */
export type RawFormat = "jsonl" | "json";

export interface RawPart {
  part: number;
  format: RawFormat;
  /** Bytes as stored (gzip). */
  size: number;
  sha256: string;
  created_at: string;
  /** Where the part sits in the log it was cut from: the byte offset of its first byte, and
   * how many of the log's bytes it covers (before redaction, which can shorten it). Part 0 of a
   * whole upload starts at 0. */
  offset: number;
  length: number;
}

/** How far a session's log has been normalized: the state the next chunk continues from. */
export interface NormalizedState {
  /** Bytes of the log normalized so far, up to its last complete line: where the next chunk
   * starts. */
  bytes: number;
  /** How many records the whole session normalizes to, those bytes in. */
  records: number;
  /** `prefixSha256` of those records. */
  prefix_sha256: string;
  /** The hash mid-stream after those records (`PrefixHash.export()`), so the next chunk's
   * records extend it. */
  hash_state: string;
}

export interface SessionTraceRef {
  content_hash: string;
  created_at: string;
  /** Record count of the stored trace. */
  records: number;
  continuation?: { from_record: number; prefix_sha256: string };
}

export interface SessionMetadata {
  schema: typeof METADATA_SCHEMA;
  owner: string;
  archive_id: string;
  session_id: string;
  agent: string;
  /** What the trace's meta record says it came from (`datadog-trajectory:claude-code`); absent
   * until a trace is stored. */
  source?: string;
  project?: string;
  branch?: string;
  parent_session_id?: string;
  status: SessionStatus;
  /** The current trace; absent before one is stored (raw only) and once redacted. */
  head?: string;
  traces: SessionTraceRef[];
  raw: RawPart[];
  raw_format?: RawFormat;
  /** Where a chunked upload stands; absent until the session's first chunk is normalized. */
  normalized?: NormalizedState;
  created_at: string;
  updated_at: string;
}

export type ChangeKind = "published" | "tombstone";

export interface ChangeEntry {
  schema: typeof CHANGE_SCHEMA;
  kind: ChangeKind;
  at: string;
  owner: string;
  archive_id: string;
  session_id: string;
  /** The trace the entry is about; for a tombstone of a whole session, its head at the time. */
  content_hash: string | null;
  continuation?: { from_record: number; prefix_sha256: string };
}

/** `<prefix>/sessionstorage.json`: written once when a prefix is first used. */
export interface LayoutMarker {
  schema: typeof LAYOUT_SCHEMA;
  created_at: string;
  created_by: string;
}
