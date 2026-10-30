/** `@dosu-ai/sessiondb`: coding-agent sessions as a durable, redacted, content-addressed store.
 *
 * `connect()` gives a `SessionDB`: `ingest` a native transcript (redacted, normalized to
 * trajectory-v1, published into the `sessionstorage` layout, `spec/layout.md`), and
 * `getSession`, `getTrace`, `listSessions`, `changes` to read the layout back. Two backends
 * behind the one interface: a `Store` written directly (a folder, or a bucket on S3, R2 or
 * anything S3-compatible: serverless), or a sessiondb server that runs this same package
 * against the bucket it holds.
 *
 * Below the client, the pipeline (`storeSession` and the read functions over a `Store`), the
 * normalizer and the redactor are exported for a caller that wants the pieces. */

// The client: one API over a store (serverless) or a server.
export {
  type ConnectOptions,
  connect,
  type Fetch,
  type HttpClientOptions,
  HttpSessionDB,
  type Identity,
  type ListSessionsOptions,
  ServerError,
  type SessionDB,
  type SessionsPage,
  type StoreClientOptions,
  StoreSessionDB,
  type Upload,
} from "./client";
// The pipeline, for a caller that wants it without the client.
export { prefixSha256, type ShippedPrefix } from "./ingest/continuation";
export { IngestRejected, OffsetMismatch, SessionRejected } from "./ingest/errors";
export {
  getSession,
  getTrace,
  type IngestResult,
  listSessions,
  type PutRawResult,
  type TombstoneInput,
  tombstone,
} from "./ingest/ingest";
export { LIMITS } from "./ingest/limits";
export {
  type SessionOptions,
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
export { isStoreUrl, type OpenStoreOptions, openStore, type StorageView } from "./store/open";
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
