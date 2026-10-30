/** `@dosu-ai/sessiondb`: coding-agent sessions as a durable, redacted, content-addressed store.
 *
 * The write path is `storeSession`: redact a native transcript, store it as a raw part of the
 * session, normalize what was stored to trajectory-v1, decide what is new, and publish the
 * trace into the `sessionstorage` layout (`spec/layout.md`). The read path is `getSession`,
 * `getTrace`, `listSessions` and `readChanges` over the same layout. Both go through a `Store`:
 * a folder (`FsStore`) or a bucket (`S3Store`: AWS S3, Cloudflare R2, anything S3-compatible).
 *
 * The sessiondb server is this package behind HTTP and a token list; nothing here knows about
 * HTTP. */

export { prefixSha256, type ShippedPrefix } from "./ingest/continuation";
export {
  getSession,
  getTrace,
  IngestRejected,
  type IngestResult,
  listSessions,
  type PutRawResult,
  type TombstoneInput,
  tombstone,
} from "./ingest/ingest";
export { LIMITS } from "./ingest/limits";
// The pipeline.
export {
  OffsetMismatch,
  type SessionOptions,
  SessionRejected,
  type SessionUpload,
  type StoreSessionResult,
  storeSession,
} from "./ingest/session";

// Normalization and redaction, for a caller that wants the pieces.
export {
  isSource,
  NORMALIZER,
  NormalizeError,
  type NormalizeOutcome,
  normalizeTranscript,
  SOURCES,
  type Source,
} from "./normalize";
export { redactRaw } from "./redact/raw";
export { redactRecords } from "./redact/records";
export { type RedactionResult, redactSecrets } from "./redact/secrets";
// The layout's objects.
export type {
  ChangeEntry,
  ChangeKind,
  LayoutMarker,
  NormalizedState,
  RawFormat,
  RawPart,
  SessionMetadata,
  SessionStatus,
  SessionTraceRef,
} from "./schemas/store";
export { CHANGE_SCHEMA, LAYOUT_SCHEMA, METADATA_SCHEMA } from "./schemas/store";
export type {
  Continuation,
  EventRole,
  Trace,
  TraceEvent,
  TraceMetadata,
} from "./schemas/trace";
export { TRACE_SCHEMA } from "./schemas/trace";
export type { NormalizedRecord } from "./schemas/trajectory";
export { TrajectoryError, validateRecords } from "./schemas/trajectory";
// Stores and the layout.
export { type ChangesPage, type ReadChangesOptions, readChanges } from "./store/changes";
export { FsStore } from "./store/fs";
export { archiveId, assertOwner, changeStamp, keys, LAYOUT_KEY } from "./store/layout";
export {
  decodeJson,
  ensureLayout,
  gunzipJson,
  gzipJson,
  probe,
  readMetadata,
  sha256,
} from "./store/publish";
export {
  parseS3Url,
  type S3Credentials,
  S3Store,
  type S3StoreOptions,
} from "./store/s3";
export {
  type ListOptions,
  type ListResult,
  type ObjectStat,
  type PutOptions,
  type Store,
  StoreError,
} from "./store/store";
export { type ParseOptions, parseTrajectory } from "./trace/parse";

export { VERSION } from "./version";
