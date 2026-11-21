import { createHash } from "node:crypto";
import { describeSecret, Secret, type ServerConfig, type SourceConfig } from "@seshi/config";

/** The sections a running server cannot change: the listener and roles, the bucket, identity,
 * the request caps the listener was built with, search and the worker's own intervals. A reload
 * whose file changes one of them applies everything else and reports the change as needing a
 * restart; the running value stays until then. */
export const RESTART_ONLY_SECTIONS = [
  "server",
  "store",
  "auth",
  "limits",
  "search",
  "worker",
  "secrets",
] as const satisfies readonly (keyof ServerConfig)[];

/** The sections a reload applies: sources, redaction rule packs (their files are read again),
 * model review, the session filter, visibility, record retention and capture settings. */
export const LIVE_SECTIONS = [
  "sources",
  "redaction",
  "review",
  "filter",
  "default_visibility",
  "records",
  "capture",
] as const satisfies readonly (keyof ServerConfig)[];

export type ReloadTrigger = "signal" | "api" | "watch" | "manual" | "store";

export interface SourceChanges {
  added: string[];
  removed: string[];
  changed: string[];
  unchanged: string[];
}

export interface ReloadReport {
  trigger: ReloadTrigger;
  started_at: string;
  finished_at: string;
  /** `applied`: the running config changed and `generation` went up. `unchanged`: what the
   * files say is what runs. `rejected`: something did not load or check; nothing changed. */
  outcome: "applied" | "unchanged" | "rejected";
  /** The generation running after this reload. */
  generation: number;
  config_hash: string;
  rule_set: string;
  review_set: string | null;
  /** Why it was rejected, one problem a line. */
  errors?: string[];
  /** The live sections that changed (`sources`, `redaction`…). */
  changed: string[];
  sources?: SourceChanges;
  /** Settings the files change that only a restart applies; they keep their running values. */
  restart_required: string[];
}

export interface ConfigStatus {
  /** 1 at start-up, one more for each reload that changed something. */
  generation: number;
  /** A hash of the running config (secrets hashed, never shown). */
  config_hash: string;
  /** The running redaction rule set's hash, as `GET /v1/redaction/rules` serves it. */
  rule_set: string;
  /** A hash of the running review policies' hashes (each covers its prompt text, so an edited
   * `prompt_file` changes it); null for a reviewer seshi did not build from `[review]`. */
  review_set: string | null;
  /** When the running generation started. */
  loaded_at: string;
  /** Whether this server can reload (it was started from a config it can read again). */
  reloadable: boolean;
  /** Settings the files change that wait for a restart, as of the last reload. */
  restart_required: string[];
  last_reload: ReloadReport | null;
  live_sections: readonly string[];
  restart_only_sections: readonly string[];
  /** With `server.runtime_config = store`: the bucket's runtime config version, the one this
   * instance runs, and why they differ when they do. */
  runtime?: {
    version: string;
    applied: string;
    applied_at: string;
    last_sync: string | null;
    problem?: string;
  };
}

/** A config as plain, ordered JSON: secrets become a hash of their value, so two configs
 * compare and hash equal exactly when they would behave the same. */
export function canonical(value: unknown): unknown {
  if (value instanceof Secret) {
    return value.resolved
      ? { secret: sha256(value.reveal()).slice(0, 16) }
      : { secret: describeSecret(value) };
  }
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
        .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** `ConfigStatus.review_set` from a review fingerprint (the JSON of its policies' ids and
 * hashes); null when there is none. */
export function reviewSetHash(fingerprint: string | undefined): string | null {
  return fingerprint === undefined ? null : sha256(fingerprint);
}

export function configHash(config: ServerConfig): string {
  return sha256(JSON.stringify(canonical(config)));
}

export function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/** The leaf paths where two values differ (`server.listen`, `auth.tokens`), at most `max`. */
export function differences(a: unknown, b: unknown, path: string[] = [], max = 50): string[] {
  const found: string[] = [];
  const visit = (x: unknown, y: unknown, at: string[]): void => {
    if (found.length >= max) return;
    const plain = (v: unknown) => v !== null && typeof v === "object" && !Array.isArray(v);
    if (Array.isArray(x) && Array.isArray(y)) {
      for (let i = 0; i < Math.max(x.length, y.length); i++) visit(x[i], y[i], [...at, String(i)]);
      return;
    }
    if (plain(x) && plain(y)) {
      const keys = new Set([...Object.keys(x as object), ...Object.keys(y as object)]);
      for (const key of [...keys].sort()) {
        visit((x as Record<string, unknown>)[key], (y as Record<string, unknown>)[key], [
          ...at,
          key,
        ]);
      }
      return;
    }
    if (JSON.stringify(x) !== JSON.stringify(y)) found.push(at.join("."));
  };
  visit(canonical(a), canonical(b), path);
  return found;
}

/** Sources by id: added, removed, changed (any setting, secrets included), unchanged. */
export function diffSources(
  before: readonly SourceConfig[],
  after: readonly SourceConfig[],
): SourceChanges {
  const old = new Map(before.map((s) => [s.id, s]));
  const next = new Map(after.map((s) => [s.id, s]));
  const changes: SourceChanges = { added: [], removed: [], changed: [], unchanged: [] };
  for (const [id, source] of next) {
    const was = old.get(id);
    if (!was) changes.added.push(id);
    else if (same(was, source)) changes.unchanged.push(id);
    else changes.changed.push(id);
  }
  for (const id of old.keys()) if (!next.has(id)) changes.removed.push(id);
  return changes;
}

/** `next` with the restart-only sections taken from `running`, and the settings that kept
 * their running values. */
export function effectiveConfig(
  running: ServerConfig,
  next: ServerConfig,
): { config: ServerConfig; restartRequired: string[] } {
  const config = { ...next } as Record<string, unknown>;
  const restartRequired: string[] = [];
  for (const section of RESTART_ONLY_SECTIONS) {
    restartRequired.push(...differences(running[section], next[section], [section]));
    config[section] = running[section];
  }
  return { config: config as ServerConfig, restartRequired: restartRequired.sort() };
}
