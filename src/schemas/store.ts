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

/** How a raw transcript part was captured, which decides how a renormalize job reads it. */
export type RawFormat = "jsonl" | "json";

export interface RawPart {
  part: number;
  format: RawFormat;
  /** Bytes as stored (gzip). */
  size: number;
  sha256: string;
  created_at: string;
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
  created_at: string;
  updated_at: string;
}

export type ChangeKind = "published" | "tombstone" | "renormalized";

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
