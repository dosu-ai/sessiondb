import type { OwnerBasis, Visibility } from "@seshi/model";

export type Scope =
  | "sessions:write"
  | "sessions:read"
  | "sessions:delete"
  | "search"
  | "sources:admin"
  | "tokens:admin";

export type TokenKind = "org" | "admin" | "device" | "service";

/** `GET /v1/auth/config`: which ways in the server takes (X5.7). */
export interface AuthConfig {
  version: string;
  /** The org key is accepted (X5.12). */
  org_key: boolean;
  /** The IdP to sign in through, or null without one. */
  oidc: { issuer: string; client_id: string; audience: string; scopes: string[] } | null;
  session_token_seconds: number;
  /** How recent a session token must be to delete (X5.3). */
  delete_fresh_seconds: number;
}

/** `POST /v1/auth/exchange`'s body. */
export interface ExchangeRequest {
  id_token: string;
  nonce?: string;
  /** The first sign-in from this machine, or a renewal of its device token (X5.2). */
  machine?: { id: string; name?: string };
  /** The device token's default visibility (X5.10). */
  visibility?: Visibility;
}

export interface ExchangeResult {
  session_token: string;
  expires_at: string;
  owner: string;
  role: "member" | "admin";
  scopes: Scope[];
  device_token?: { token: string; id: string; expires_at: string };
}

/** `POST /v1/tokens`' body (X5.9). */
export interface TokenRequest {
  kind: TokenKind;
  /** A person's owner id, for `admin` and `device`. */
  owner?: string;
  /** For `service`: its name, or the configured source it writes for. */
  service?: string;
  scopes?: Scope[];
  visibility?: Visibility;
  /** RFC 3339. */
  expires_at?: string;
  label?: string;
}

/** A token record without its hash. */
export interface TokenInfo {
  schema: "seshi/token/1";
  id: string;
  kind: TokenKind;
  /** The owner id, or `*` for the org key. */
  owner: string;
  scopes: Scope[];
  visibility?: Visibility;
  owner_basis?: OwnerBasis;
  created_at: string;
  expires_at: string | null;
  revoked: boolean;
  revoked_at?: string;
  label?: string;
  created_by?: { kind: string; principal: string; credential_id?: string };
  machine?: { id: string; name?: string };
  claims?: Record<string, unknown>;
}

export interface OwnersPage {
  owners: string[];
  cursor?: string;
  truncated: boolean;
}

/** A source's state (`GET /v1/admin/sources`). */
/** `GET /v1/admin/sources/{id}`: a source's status, and where it is set. */
export interface SourceDetail extends SourceStatus {
  managed: "file" | "store" | "builtin";
  /** A stored source's settings, each sealed secret as a `SecretView`. */
  config?: Record<string, unknown>;
  etag?: string;
  updated_at?: string;
  running?: boolean;
}

export interface SourceStatus {
  id: string;
  type: string;
  enabled: boolean;
  polled: boolean;
  connector?: string;
  interval_ms?: number;
  note?: string;
  checkpoint: { updated_at: string; cursor: Record<string, unknown> } | null;
  dropped: number;
  failed: number;
  /** Outcome counts over the days asked for (X4.8). */
  health: Record<string, number>;
}

export type RecordKind = "failed" | "dropped";

/** A drop or failure record (X6.4): that an envelope arrived and why it was not stored, never
 * its content. */
export interface SourceRecord {
  schema: "seshi/failed/1" | "seshi/dropped/1";
  at: string;
  source: string;
  source_kind?: string;
  owner?: string;
  session_key?: string;
  idempotency_key: string;
  provenance?: Record<string, unknown>;
  /** Failures: the pipeline's error code and message. */
  code?: string;
  message?: string;
  /** Drops: why, under which policy. */
  reason?: string;
  policy?: string;
  policy_hash?: string;
  decision_model?: string;
}

export interface RecordsPage {
  source: string;
  kind: RecordKind;
  records: { key: string; record: SourceRecord }[];
  /** Pass as `after` for the next page. */
  cursor?: string;
  truncated: boolean;
}

/** `GET /v1/admin/jobs` (X7.5). Loosely typed here; `spec/openapi.yaml`'s `JobsStatus` is the
 * whole shape. */
export interface JobsStatus {
  at: string;
  deployment: string;
  instance: { id: string; process: string; roles: string[]; version: string };
  worker: { state: "running" | "stopped" | "never" | "several"; [key: string]: unknown };
  jobs: Array<{ name: string; kind: string; [key: string]: unknown }>;
  sources: SourceStatus[];
  warnings: string[];
}

/** One config reload (`POST /v1/admin/reload`); `spec/openapi.yaml`'s `ReloadReport`. */
export interface ReloadReport {
  trigger: "signal" | "api" | "watch" | "manual";
  started_at: string;
  finished_at: string;
  outcome: "applied" | "unchanged" | "rejected";
  generation: number;
  config_hash: string;
  rule_set: string;
  review_set: string | null;
  errors?: string[];
  changed: string[];
  sources?: { added: string[]; removed: string[]; changed: string[]; unchanged: string[] };
  restart_required: string[];
}

/** `GET /v1/admin/reload`: the running config's generation and hash, and the last reload. */
export interface ConfigStatus {
  generation: number;
  config_hash: string;
  rule_set: string;
  /** A hash of the running review policies (their prompt text included); null for a reviewer
   * seshi did not build. */
  review_set: string | null;
  loaded_at: string;
  reloadable: boolean;
  restart_required: string[];
  last_reload: ReloadReport | null;
  live_sections: string[];
  restart_only_sections: string[];
  /** With `server.runtime_config = store`: the bucket's version and the one running here. */
  runtime?: RuntimeHere;
}

/** The bucket's runtime config version, the one this instance runs, and why they differ. */
export interface RuntimeHere {
  version: string;
  applied: string;
  applied_at: string;
  last_sync: string | null;
  problem?: string;
}

/** What one instance last said about the runtime config it runs. */
export interface RuntimeInstance {
  schema: "seshi/runtime-instance/1";
  instance: string;
  process: string;
  seshi: string;
  version: string;
  applied_at: string;
  at: string;
  problem?: string;
  /** It runs the bucket's current version. */
  current: boolean;
}

/** `GET /v1/admin/config`: the runtime config in the bucket and which instances run it. On a
 * file-only server `runtime_config` is `file` and only `effective` is given. */
export interface RuntimeConfigStatus {
  runtime_config: "file" | "store";
  version?: string;
  here?: RuntimeHere;
  converged?: boolean;
  instances?: RuntimeInstance[];
  doc?: {
    etag?: string;
    settings: Record<string, unknown>;
    files: { name: string; etag: string }[];
  };
  /** Settings the server's files set, which cannot be changed through the API. */
  locked?: string[];
  effective: Record<string, unknown>;
}

/** What may be said of a stored secret; never its value. */
export interface SecretView {
  set: true;
  fingerprint: string;
  key_id: string;
  updated_at: string;
}

/** The condition a runtime config write is made under: the ETag read, or create only. */
export interface WriteCondition {
  ifMatch?: string;
  create?: boolean;
}

/** One stored write's model review (`GET /v1/sessions/{format}/{id}/reviews`, F3.8). Callers
 * who are not admins get `schema`, `n`, `at`, `content_hash` and `decision` only. */
export interface ReviewDecision {
  schema: "seshi/review/1";
  n: number;
  at: string;
  content_hash: string;
  /** `allow`, `redact` (findings applied), or `skipped` (review failed and was skipped). */
  decision: "allow" | "redact" | "skipped";
  policy?: string;
  policy_hash?: string;
  decision_model?: string;
  redactor_model?: string;
  findings?: { record: number; field: string; category: string; action: "redact" | "withhold" }[];
  unmatched?: number;
  parts?: number;
  failure?: { step: "decision" | "redactor"; code: string; attempts: number };
}
