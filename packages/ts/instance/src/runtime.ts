import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type BaseLayer,
  baseLayerIn,
  baseLayerOf,
  ConfigError,
  getField,
  isSealed,
  type Keyring,
  type Loaded,
  parseConfigToml,
  RUNTIME_INSTANCES_PREFIX,
  RUNTIME_LISTS,
  RUNTIME_SECTIONS,
  RUNTIME_SOURCES_PREFIX,
  type RuntimeLayer,
  type SecretView,
  type ServerConfig,
  SHARED_CONFIG,
  SHARED_PREFIX,
  safeSharedName,
  sealContext,
  secretFields,
  setField,
  stringifyToml,
} from "@seshi/config";
import { VERSION } from "@seshi/model";
import { isPreconditionFailed, listNamed, type Store } from "@seshi/store";
import { Coalesced } from "./coalesced";
import type { Logger } from "./log";

/** How a source the admin API wrote is kept: `runtime/sources/<id>.json`. Its secrets are
 * sealed (`{ sealed = … }`) or name the server's env (`{ env = … }`); never plain. */
export interface StoredSource {
  schema: typeof STORED_SOURCE_SCHEMA;
  source: Record<string, unknown>;
  /** Each sealed secret's key id, fingerprint and when it was set, by field. */
  secrets: Record<string, { key_id: string; fingerprint: string; updated_at: string }>;
  updated_at: string;
  updated_by?: string;
}

export const STORED_SOURCE_SCHEMA = "seshi/runtime-source/1";
export const RUNTIME_INSTANCE_SCHEMA = "seshi/runtime-instance/1";

/** What one instance last said about the runtime config it runs. */
export interface RuntimeInstanceRecord {
  schema: typeof RUNTIME_INSTANCE_SCHEMA;
  instance: string;
  process: string;
  seshi: string;
  /** The runtime config version it runs. */
  version: string;
  applied_at: string;
  /** When it last wrote this. */
  at: string;
  /** Why the bucket's current version is not what it runs, when it is not. */
  problem?: string;
}

/** A change refused before anything was written: what is wrong with it, one problem a line. */
export class RuntimeChangeError extends Error {
  constructor(
    readonly code:
      | "invalid"
      | "locked"
      | "file_owned"
      | "unknown_source"
      | "no_such_file"
      | "in_use",
    readonly problems: string[],
  ) {
    super(problems.join("; "));
    this.name = "RuntimeChangeError";
  }
}

/** The condition a write is made under: the ETag read (`ifMatch`), or `ifNoneMatch: "*"` to
 * create only. Neither: whatever is there. */
export interface WriteCondition {
  ifMatch?: string;
  ifNoneMatch?: "*";
}

interface Snapshot {
  version: string;
  /** Each object's ETag, by key. */
  etags: Record<string, string>;
  /** A local copy of `config/`, which pack and prompt paths point into. */
  dir: string | undefined;
  doc: BaseLayer | undefined;
  /** `config/seshi.toml` as stored, parsed (its paths as written). */
  docTree: Record<string, unknown> | undefined;
  /** Why `config/seshi.toml` cannot be used, when it cannot. */
  docProblems: string[] | undefined;
  sources: Map<string, { etag: string; stored: StoredSource }>;
}

const EMPTY_VERSION = "none";

export interface RuntimeConfigOptions {
  store: Store;
  keyring: Keyring;
  /** The server's files, drop-ins, env and flags, with `layer` under them. */
  load: (layer: RuntimeLayer | undefined) => Loaded<ServerConfig>;
  /** Where local copies of `config/` go; this process's own. */
  cacheDir: string;
  pollMs: number;
  now?: () => Date;
  log?: Logger;
}

/** The bucket's runtime config (`server.runtime_config = store`, docs/config.md): read and
 * merged under the files, and written by the admin API, one checked conditional write at a
 * time. Every instance syncs it (`sync`), and the one that took a write applies it at once. */
export class RuntimeConfig {
  readonly store: Store;
  readonly keyring: Keyring;
  readonly pollMs: number;
  private readonly loadLayers: RuntimeConfigOptions["load"];
  private readonly cacheDir: string;
  private readonly now: () => Date;
  private readonly log: Logger | undefined;
  private snapshot: Snapshot = emptySnapshot();
  private copies = 0;
  private candidates = 0;
  /** The local copies of `config/` still kept: the current one and the one before it (a
   * write in flight may still read its packs). */
  private dirs: string[] = [];
  private readonly syncing = new Coalesced<boolean>();
  /** When the bucket was last read without an error. */
  lastSync: Date | undefined;
  /** The version running here, and why the bucket's is not, when it is not. */
  applied: { version: string; at: Date; problem?: string } = {
    version: EMPTY_VERSION,
    at: new Date(0),
  };
  private warnings: string[] = [];

  constructor(options: RuntimeConfigOptions) {
    this.store = options.store;
    this.keyring = options.keyring;
    this.pollMs = options.pollMs;
    this.loadLayers = options.load;
    this.cacheDir = options.cacheDir;
    this.now = options.now ?? (() => new Date());
    this.log = options.log;
  }

  /** The bucket's current version (a hash of its objects' ETags). */
  get version(): string {
    return this.snapshot.version;
  }

  /** Read the bucket's runtime objects; true when anything changed since the last read. One
   * listing of `config/` and one of `runtime/sources/`, then only what changed is read. */
  sync(): Promise<boolean> {
    return this.syncing.run(() => this.syncNow());
  }

  private async syncNow(): Promise<boolean> {
    const listed: Record<string, string> = {};
    for (const [prefix, keep] of [
      [SHARED_PREFIX, safeSharedName],
      [RUNTIME_SOURCES_PREFIX, (name: string) => /^[a-z0-9-]+\.json$/.test(name)],
    ] as const) {
      for (const { name, etag } of await listNamed(this.store, prefix, keep)) {
        const key = `${prefix}${name}`;
        listed[key] = etag ?? (await this.store.stat(key))?.etag ?? "";
      }
    }
    this.lastSync = this.now();
    const before = this.snapshot;
    if (sameEtags(before.etags, listed)) return false;

    const configKeys = Object.keys(listed).filter((k) => k.startsWith(SHARED_PREFIX));
    const configChanged =
      before.dir === undefined && configKeys.length > 0
        ? true
        : !sameEtags(pick(before.etags, SHARED_PREFIX), pick(listed, SHARED_PREFIX));
    let dir = before.dir;
    let doc = before.doc;
    let docTree = before.docTree;
    let docProblems = before.docProblems;
    if (configChanged) {
      dir = join(this.cacheDir, `config-${++this.copies}`);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      for (const key of configKeys) {
        const object = await this.store.get(key);
        if (object === null) continue;
        const file = join(dir, key.slice(SHARED_PREFIX.length));
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
        writeFileSync(file, object.body, { mode: 0o600 });
        listed[key] = object.etag || (listed[key] ?? "");
      }
      const origin = `${this.store.url}/${SHARED_PREFIX}${SHARED_CONFIG}`;
      docProblems = undefined;
      try {
        doc = baseLayerIn(dir, origin);
        docTree = doc
          ? parseConfigToml(origin, await Bun.file(join(dir, SHARED_CONFIG)).text())
          : undefined;
      } catch (err) {
        // Kept as a problem: a config with it is refused when applied, and the last good one
        // keeps running.
        doc = undefined;
        docTree = undefined;
        docProblems = err instanceof ConfigError ? err.issues : [message(err)];
      }
      this.dirs.push(dir);
      while (this.dirs.length > 2) {
        rmSync(this.dirs.shift() as string, { recursive: true, force: true });
      }
    }

    const sources = new Map<string, { etag: string; stored: StoredSource }>();
    for (const [key, etag] of Object.entries(listed)) {
      if (!key.startsWith(RUNTIME_SOURCES_PREFIX)) continue;
      const id = key.slice(RUNTIME_SOURCES_PREFIX.length, -".json".length);
      const known = before.sources.get(id);
      if (known && known.etag === etag) {
        sources.set(id, known);
        continue;
      }
      const object = await this.store.get(key);
      if (object === null) continue;
      try {
        sources.set(id, { etag: object.etag || etag, stored: parseStoredSource(object.body) });
      } catch (err) {
        this.log?.warn(`runtime config: ${key} is not a stored source: ${message(err)}`);
      }
    }
    this.snapshot = {
      version: versionOf(listed),
      etags: listed,
      dir,
      doc,
      docTree,
      docProblems,
      sources,
    };
    return true;
  }

  /** The runtime layer: the doc, and the stored sources with their secrets unsealed. A source
   * that cannot be unsealed is left out with a warning, so one bad key stops one source. */
  layer(snapshot: Snapshot = this.snapshot, unseal = true): RuntimeLayer {
    const warnings: string[] = [];
    const sources: RuntimeLayer["sources"][number][] = [];
    for (const [id, { stored }] of [...snapshot.sources].sort(([a], [b]) => a.localeCompare(b))) {
      try {
        sources.push({
          origin: this.sourceOrigin(id),
          source: unseal ? this.unseal(id, stored) : masked(id, stored),
        });
      } catch (err) {
        warnings.push(`${this.sourceOrigin(id)}: left out: ${message(err)}`);
      }
    }
    this.warnings = warnings;
    if (snapshot.docProblems) throw new ConfigError(snapshot.docProblems);
    return { ...(snapshot.doc ? { doc: snapshot.doc } : {}), sources };
  }

  /** The server's config with the bucket's runtime layer under its files. */
  compose(snapshot: Snapshot = this.snapshot): Loaded<ServerConfig> {
    const loaded = this.loadLayers(this.layer(snapshot));
    loaded.warnings.push(...this.warnings);
    return loaded;
  }

  /** The files, env and flags alone: what they set is locked against the admin API. */
  fileLayers(): Loaded<ServerConfig> {
    return this.loadLayers(undefined);
  }

  /** Record what this instance now runs (`version`), or why it does not run the bucket's. */
  markApplied(problem?: string): void {
    this.applied = problem
      ? { ...this.applied, problem }
      : { version: this.snapshot.version, at: this.now() };
  }

  private sourceOrigin(id: string): string {
    return `${this.store.url}/${RUNTIME_SOURCES_PREFIX}${id}.json`;
  }

  private unseal(id: string, stored: StoredSource): Record<string, unknown> {
    const source = structuredClone(stored.source);
    for (const field of secretFields(source)) {
      const value = getField(source, field);
      if (!isSealed(value)) throw new Error(`${field}: not sealed; ${NOT_A_VALUE}`);
      setField(source, field, this.keyring.unseal(value, sealContext(id, field)));
    }
    return { ...source, id };
  }

  // Reading ---------------------------------------------------------------------------------

  /** A stored source as the API shows it: its settings with each secret as a `SecretView`, and
   * its ETag. Undefined when the bucket holds none by that id. */
  storedSource(
    id: string,
  ): { etag: string; source: Record<string, unknown>; updated_at: string } | undefined {
    const entry = this.snapshot.sources.get(id);
    if (!entry) return undefined;
    return {
      etag: entry.etag,
      source: viewOf(entry.stored),
      updated_at: entry.stored.updated_at,
    };
  }

  storedSourceIds(): string[] {
    return [...this.snapshot.sources.keys()].sort();
  }

  /** `config/seshi.toml` as stored (its paths as written) and its ETag; the packs and other
   * files under `config/`, by name. */
  doc(): {
    etag: string | undefined;
    settings: Record<string, unknown>;
    files: { name: string; etag: string }[];
  } {
    const docKey = `${SHARED_PREFIX}${SHARED_CONFIG}`;
    return {
      etag: this.snapshot.etags[docKey],
      settings: structuredClone(this.snapshot.docTree ?? {}),
      files: Object.entries(this.snapshot.etags)
        .filter(([key]) => key.startsWith(SHARED_PREFIX) && key !== docKey)
        .map(([key, etag]) => ({ name: key.slice(SHARED_PREFIX.length), etag }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  /** The settings the files, env or flags set, which the API may not change: dotted paths
   * under the runtime sections, lists left out (a list adds to the files'). */
  locked(fileLayers: Loaded<ServerConfig> = this.fileLayers()): string[] {
    const lists = new Set(RUNTIME_LISTS.map((l) => l.join(".")));
    const out = new Set<string>();
    for (const { path, origin } of fileLayers.origins.entries()) {
      if (origin.source === "default") continue;
      const head = path[0];
      if (typeof head !== "string" || !(RUNTIME_SECTIONS as readonly string[]).includes(head)) {
        continue;
      }
      const dotted = path.filter((p): p is string => typeof p === "string").join(".");
      const list = [...lists].find((l) => dotted === l || dotted.startsWith(`${l}.`));
      if (list !== undefined) {
        // A list from a file adds to the bucket's; one from env or flags replaces it whole.
        if (origin.source === "env" || origin.source === "flag") out.add(list);
        continue;
      }
      if (typeof path[1] === "number" || path.length > 3) {
        // A list of tables (review.policies) is locked as a whole.
        out.add(path.slice(0, 2).join("."));
      } else {
        out.add(dotted);
      }
    }
    return [...out].sort();
  }

  // Writing ---------------------------------------------------------------------------------
  // Each write is checked first: the candidate is merged under the files exactly as a sync
  // would merge it, and `check` (the reload's own checks: schema, cross-section rules, rule
  // packs, review) must pass. Only then is it written, with the caller's condition.

  /** Store source `id` from `input` (its settings, as in `[[sources]]`; `id` may be left out).
   * Plain secrets are sealed; a secret left out keeps its sealed value when the source keeps
   * its type. */
  async putSource(
    id: string,
    input: Record<string, unknown>,
    condition: WriteCondition,
    check: (config: ServerConfig) => Promise<string[]>,
    by?: string,
  ): Promise<{ etag: string; created: boolean }> {
    if (input.id !== undefined && input.id !== id) {
      throw new RuntimeChangeError("invalid", [`id: '${String(input.id)}' is not '${id}'`]);
    }
    const fileLayers = this.fileLayers();
    if (fileLayers.config.sources.some((s) => s.id === id)) {
      throw new RuntimeChangeError("file_owned", [
        `source '${id}' is set in a config file (${originOfSource(fileLayers, id)}); change it there`,
      ]);
    }
    await this.sync();
    const existing = this.snapshot.sources.get(id);
    const stored = this.seal(id, input, existing?.stored, by);
    const candidate = this.withSource(id, { etag: "candidate", stored });
    await this.checkCandidate(candidate, check);
    const key = `${RUNTIME_SOURCES_PREFIX}${id}.json`;
    const body = new TextEncoder().encode(`${JSON.stringify(stored, null, 2)}\n`);
    const put = await this.store.put(key, body, {
      contentType: "application/json",
      ...condition,
    });
    return { etag: put.etag ?? "", created: existing === undefined };
  }

  /** Remove stored source `id`. Its sessions, checkpoint and records stay. */
  async deleteSource(id: string, condition: WriteCondition): Promise<void> {
    const fileLayers = this.fileLayers();
    if (fileLayers.config.sources.some((s) => s.id === id)) {
      throw new RuntimeChangeError("file_owned", [
        `source '${id}' is set in a config file (${originOfSource(fileLayers, id)}); remove it there`,
      ]);
    }
    await this.sync();
    if (!this.snapshot.sources.has(id)) {
      throw new RuntimeChangeError("unknown_source", [`no stored source '${id}'`]);
    }
    const policies = this.compose().config.review.policies.filter((p) => p.sources.includes(id));
    if (policies.length > 0) {
      throw new RuntimeChangeError("in_use", [
        `review policies ${policies.map((p) => p.id).join(", ")} name source '${id}'; change them first`,
      ]);
    }
    await this.store.delete(`${RUNTIME_SOURCES_PREFIX}${id}.json`, {
      ...(condition.ifMatch ? { ifMatch: condition.ifMatch } : {}),
    });
  }

  /** Change settings in `config/seshi.toml`: `set` and `unset` name dotted paths under the
   * runtime sections (`capture.exclude`, `default_visibility`). A setting the files set is
   * locked; a list adds to the files' entries, so it is never locked. */
  async patchDoc(
    change: { set?: Record<string, unknown>; unset?: string[] },
    condition: WriteCondition,
    check: (config: ServerConfig) => Promise<string[]>,
  ): Promise<{ etag: string }> {
    const paths = [...Object.keys(change.set ?? {}), ...(change.unset ?? [])];
    const problems: string[] = [];
    for (const path of paths) {
      const head = path.split(".")[0] ?? "";
      if (!(RUNTIME_SECTIONS as readonly string[]).includes(head) || path.split(".").includes("")) {
        problems.push(
          `${path}: not a runtime setting (under ${RUNTIME_SECTIONS.join(", ")}); the rest stays in seshi.toml`,
        );
      }
    }
    if (problems.length > 0) throw new RuntimeChangeError("invalid", problems);
    const locked = this.locked();
    const held = paths.filter((p) =>
      locked.some((l) => p === l || p.startsWith(`${l}.`) || l.startsWith(`${p}.`)),
    );
    if (held.length > 0) {
      throw new RuntimeChangeError(
        "locked",
        held.map((p) => `${p}: set in this server's config files, which win; change it there`),
      );
    }
    const docKey = `${SHARED_PREFIX}${SHARED_CONFIG}`;
    const given = condition.ifMatch !== undefined || condition.ifNoneMatch !== undefined;
    for (let attempt = 0; ; attempt++) {
      await this.sync();
      // Written against the doc read, so a change made meanwhile is never overwritten: with
      // the caller's condition, a 412 is theirs; without one, read again and redo it.
      const read = this.snapshot.etags[docKey];
      const own: WriteCondition = given
        ? condition
        : read !== undefined
          ? { ifMatch: read }
          : { ifNoneMatch: "*" };
      try {
        return await this.patchOnce(change, own, check);
      } catch (err) {
        if (given || !isPreconditionFailed(err) || attempt >= 4) throw err;
      }
    }
  }

  private async patchOnce(
    change: { set?: Record<string, unknown>; unset?: string[] },
    condition: WriteCondition,
    check: (config: ServerConfig) => Promise<string[]>,
  ): Promise<{ etag: string }> {
    const tree = structuredClone(this.snapshot.docTree ?? {});
    for (const [path, value] of Object.entries(change.set ?? {})) setField(tree, path, value);
    for (const path of change.unset ?? []) unsetField(tree, path);
    const text = stringifyToml(tree);
    const origin = `${this.store.url}/${SHARED_PREFIX}${SHARED_CONFIG}`;
    let doc: BaseLayer;
    try {
      doc = baseLayerOf(this.snapshot.dir ?? this.cacheDir, origin, parseConfigToml(origin, text));
    } catch (err) {
      throw new RuntimeChangeError(
        "invalid",
        err instanceof ConfigError ? err.issues : [message(err)],
      );
    }
    const literal = literalSecrets(tree);
    if (literal.length > 0) {
      throw new RuntimeChangeError(
        "invalid",
        literal.map((p) => `${p}: a secret's value in config/seshi.toml; use { env = "NAME" }`),
      );
    }
    await this.checkCandidate(
      { ...this.snapshot, doc, docTree: tree, docProblems: undefined },
      check,
    );
    const put = await this.store.put(
      `${SHARED_PREFIX}${SHARED_CONFIG}`,
      new TextEncoder().encode(
        `# The runtime config (docs/config.md, "Runtime config"), written by seshi's admin API.\n${text}`,
      ),
      { contentType: "application/toml", ...condition },
    );
    return { etag: put.etag ?? "" };
  }

  /** Write a file under `config/` (a rule pack, a review prompt), checked when the doc names
   * it. */
  async putFile(
    name: string,
    body: Uint8Array,
    condition: WriteCondition,
    check: (config: ServerConfig) => Promise<string[]>,
  ): Promise<{ etag: string }> {
    if (!safeSharedName(name) || name === SHARED_CONFIG) {
      throw new RuntimeChangeError("invalid", [
        `${name}: a file name under config/ (letters, digits, . _ -, folders with /), not ${SHARED_CONFIG}`,
      ]);
    }
    await this.sync();
    await this.withCandidateFiles({ put: { name, body } }, check, "invalid");
    const put = await this.store.put(`${SHARED_PREFIX}${name}`, body, condition);
    return { etag: put.etag ?? "" };
  }

  /** Remove a file under `config/`; refused while the doc needs it (checked as a reload would
   * check the config without it). */
  async deleteFile(
    name: string,
    condition: WriteCondition,
    check: (config: ServerConfig) => Promise<string[]>,
  ): Promise<void> {
    if (!safeSharedName(name) || name === SHARED_CONFIG) {
      throw new RuntimeChangeError("invalid", [`${name}: not a file the API removes`]);
    }
    await this.sync();
    if (this.snapshot.etags[`${SHARED_PREFIX}${name}`] === undefined) {
      throw new RuntimeChangeError("no_such_file", [`no file config/${name}`]);
    }
    await this.withCandidateFiles({ remove: name }, check, "in_use");
    await this.store.delete(`${SHARED_PREFIX}${name}`, {
      ...(condition.ifMatch ? { ifMatch: condition.ifMatch } : {}),
    });
  }

  /** Check the config as it would be with a file under `config/` written or removed: a copy of
   * the current folder with the change, the doc's paths pointing into it. Refused with `code`. */
  private async withCandidateFiles(
    change: { put?: { name: string; body: Uint8Array }; remove?: string },
    check: (config: ServerConfig) => Promise<string[]>,
    code: "invalid" | "in_use",
  ): Promise<void> {
    const dir = join(this.cacheDir, `candidate-${++this.candidates}`);
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      for (const [key] of Object.entries(this.snapshot.etags)) {
        if (!key.startsWith(SHARED_PREFIX) || this.snapshot.dir === undefined) continue;
        const rel = key.slice(SHARED_PREFIX.length);
        if (rel === change.remove) continue;
        const from = Bun.file(join(this.snapshot.dir, rel));
        if (await from.exists()) {
          mkdirSync(dirname(join(dir, rel)), { recursive: true, mode: 0o700 });
          writeFileSync(join(dir, rel), new Uint8Array(await from.arrayBuffer()), { mode: 0o600 });
        }
      }
      if (change.put) {
        mkdirSync(dirname(join(dir, change.put.name)), { recursive: true, mode: 0o700 });
        writeFileSync(join(dir, change.put.name), change.put.body, { mode: 0o600 });
      }
      const origin = `${this.store.url}/${SHARED_PREFIX}${SHARED_CONFIG}`;
      const doc = this.snapshot.docTree
        ? baseLayerOf(dir, origin, structuredClone(this.snapshot.docTree))
        : undefined;
      try {
        await this.checkCandidate({ ...this.snapshot, dir, doc }, check);
      } catch (err) {
        if (err instanceof RuntimeChangeError && code === "in_use") {
          throw new RuntimeChangeError("in_use", [
            `config/${SHARED_CONFIG} needs config/${change.remove}; take it out there first`,
            ...err.problems,
          ]);
        }
        throw err;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** Seal every stored source's secrets again with the current key. Returns the ids
   * rewritten; each is a conditional write, so one changed meanwhile is skipped and named in
   * `changed`. */
  async reseal(): Promise<{ resealed: string[]; changed: string[]; current: string[] }> {
    await this.sync();
    const resealed: string[] = [];
    const changed: string[] = [];
    const current: string[] = [];
    for (const [id, { etag, stored }] of this.snapshot.sources) {
      const fields = Object.entries(stored.secrets);
      if (fields.every(([, meta]) => meta.key_id === this.keyring.current)) {
        current.push(id);
        continue;
      }
      const plain = this.unseal(id, stored);
      const next = this.seal(id, plain, undefined, stored.updated_by, stored);
      try {
        await this.store.put(
          `${RUNTIME_SOURCES_PREFIX}${id}.json`,
          new TextEncoder().encode(`${JSON.stringify(next, null, 2)}\n`),
          { contentType: "application/json", ifMatch: etag },
        );
        resealed.push(id);
      } catch (err) {
        if (!isPreconditionFailed(err)) throw err;
        changed.push(id);
      }
    }
    return { resealed, changed, current };
  }

  /** The "left out" warnings `snapshot`'s sources give, or none when its doc does not load. */
  private leftOut(snapshot: Snapshot): string[] {
    try {
      this.layer(snapshot);
    } catch {
      return [];
    }
    return this.warnings.filter((w) => w.includes("left out"));
  }

  private withSource(id: string, entry: { etag: string; stored: StoredSource }): Snapshot {
    const sources = new Map(this.snapshot.sources);
    sources.set(id, entry);
    return { ...this.snapshot, sources };
  }

  /** Refuses `candidate` when it does not load, when it leaves out a source the bucket runs
   * now (a source already left out, say one sealed with a key since removed, blocks no other
   * write), or when `check` finds problems in it. */
  private async checkCandidate(
    candidate: Snapshot,
    check: (config: ServerConfig) => Promise<string[]>,
  ): Promise<void> {
    const kept = this.warnings;
    let loaded: Loaded<ServerConfig>;
    let left: string[];
    try {
      const before = new Set(this.leftOut(this.snapshot));
      try {
        loaded = this.compose(candidate);
      } catch (err) {
        throw new RuntimeChangeError(
          "invalid",
          err instanceof ConfigError ? err.issues : [message(err)],
        );
      }
      left = this.warnings.filter((w) => w.includes("left out") && !before.has(w));
    } finally {
      this.warnings = kept;
    }
    if (left.length > 0) throw new RuntimeChangeError("invalid", left);
    const problems = await check(loaded.config);
    if (problems.length > 0) throw new RuntimeChangeError("invalid", problems);
  }

  /** `input`'s secrets sealed for source `id`: a plain value is sealed with the current key, and
   * a secret left out keeps `previous`'s sealed value when the type is the same. `{ env }` and
   * `{ file }` are refused: they would let an admin token make the server send its own
   * environment or files (the sealing keys among them) to an endpoint the caller picks. */
  private seal(
    id: string,
    input: Record<string, unknown>,
    previous: StoredSource | undefined,
    by: string | undefined,
    keepTimesFrom?: StoredSource,
  ): StoredSource {
    const source = structuredClone(input);
    delete source.id;
    const secrets: StoredSource["secrets"] = {};
    const now = this.now().toISOString();
    const problems: string[] = [];
    for (const field of secretFields(source)) {
      const value = getField(source, field);
      if (typeof value === "string") {
        if (value === "") {
          problems.push(`${field}: empty`);
          continue;
        }
        const sealed = this.keyring.seal(value, sealContext(id, field));
        const kid = this.keyring.keyOf(sealed);
        setField(source, field, sealed);
        secrets[field] = {
          key_id: kid,
          fingerprint: this.keyring.fingerprint(value, kid),
          updated_at: keepTimesFrom?.secrets[field]?.updated_at ?? now,
        };
      } else if (isSealed(value)) {
        problems.push(`${field}: send the secret's value; a sealed value is seshi's own`);
      } else if (value !== undefined) {
        problems.push(`${field}: ${NOT_A_VALUE}`);
      }
    }
    if (previous && previous.source.type === source.type) {
      for (const [field, meta] of Object.entries(previous.secrets)) {
        if (getField(source, field) !== undefined) continue;
        setField(source, field, getField(previous.source, field));
        secrets[field] = meta;
      }
    }
    if (problems.length > 0) throw new RuntimeChangeError("invalid", problems);
    return {
      schema: STORED_SOURCE_SCHEMA,
      source,
      secrets,
      updated_at: now,
      ...(by ? { updated_by: by } : {}),
    };
  }

  // Instances -------------------------------------------------------------------------------

  /** Write this process's record: the version it runs and any problem. */
  async heartbeat(instance: string, process: string): Promise<void> {
    const record: RuntimeInstanceRecord = {
      schema: RUNTIME_INSTANCE_SCHEMA,
      instance,
      process,
      seshi: VERSION,
      version: this.applied.version,
      applied_at: this.applied.at.toISOString(),
      at: this.now().toISOString(),
      ...(this.applied.problem ? { problem: this.applied.problem } : {}),
    };
    await this.store.put(
      `${RUNTIME_INSTANCES_PREFIX}${process}.json`,
      new TextEncoder().encode(`${JSON.stringify(record)}\n`),
      { contentType: "application/json" },
    );
  }

  async forget(process: string): Promise<void> {
    await this.store.delete(`${RUNTIME_INSTANCES_PREFIX}${process}.json`).catch(() => undefined);
  }

  /** The instances heard from within `freshMs`, each with whether it runs the bucket's
   * current version. Records older than a day are removed. */
  async instances(freshMs: number): Promise<(RuntimeInstanceRecord & { current: boolean })[]> {
    const now = this.now().getTime();
    const out: (RuntimeInstanceRecord & { current: boolean })[] = [];
    for (const { name } of await listNamed(this.store, RUNTIME_INSTANCES_PREFIX)) {
      const key = `${RUNTIME_INSTANCES_PREFIX}${name}`;
      const object = await this.store.get(key);
      if (!object) continue;
      let record: RuntimeInstanceRecord;
      try {
        record = JSON.parse(new TextDecoder().decode(object.body)) as RuntimeInstanceRecord;
      } catch {
        continue;
      }
      const age = now - Date.parse(record.at);
      if (age > 24 * 60 * 60 * 1000) {
        await this.store.delete(key, { ifMatch: object.etag }).catch(() => undefined);
        continue;
      }
      if (age <= freshMs) out.push({ ...record, current: record.version === this.version });
    }
    return out.sort((a, b) => a.process.localeCompare(b.process));
  }

  close(): void {
    rmSync(this.cacheDir, { recursive: true, force: true });
  }
}

function emptySnapshot(): Snapshot {
  return {
    version: EMPTY_VERSION,
    etags: {},
    dir: undefined,
    doc: undefined,
    docTree: undefined,
    docProblems: undefined,
    sources: new Map(),
  };
}

function sameEtags(a: Record<string, string>, b: Record<string, string>): boolean {
  const ak = Object.keys(a).sort();
  const bk = Object.keys(b).sort();
  return ak.length === bk.length && ak.every((k, i) => k === bk[i] && a[k] === b[k]);
}

function pick(etags: Record<string, string>, prefix: string): Record<string, string> {
  return Object.fromEntries(Object.entries(etags).filter(([k]) => k.startsWith(prefix)));
}

function versionOf(etags: Record<string, string>): string {
  const keys = Object.keys(etags).sort();
  if (keys.length === 0) return EMPTY_VERSION;
  const hash = createHash("sha256");
  for (const key of keys) hash.update(`${key}\0${etags[key]}\n`);
  return hash.digest("hex").slice(0, 16);
}

function parseStoredSource(body: Uint8Array): StoredSource {
  const parsed = JSON.parse(new TextDecoder().decode(body)) as Partial<StoredSource>;
  if (parsed.schema !== STORED_SOURCE_SCHEMA || typeof parsed.source !== "object") {
    throw new Error(`not ${STORED_SOURCE_SCHEMA}`);
  }
  return {
    schema: STORED_SOURCE_SCHEMA,
    source: parsed.source as Record<string, unknown>,
    secrets: parsed.secrets ?? {},
    updated_at: parsed.updated_at ?? "",
    ...(parsed.updated_by ? { updated_by: parsed.updated_by } : {}),
  };
}

/** A stored source's settings with each sealed secret as what may be said of it. */
function viewOf(stored: StoredSource): Record<string, unknown> {
  const source = structuredClone(stored.source);
  for (const field of secretFields(source)) {
    const value = getField(source, field);
    if (!isSealed(value)) continue;
    const meta = stored.secrets[field];
    const view: SecretView = {
      set: true,
      fingerprint: meta?.fingerprint ?? "",
      key_id: meta?.key_id ?? "",
      updated_at: meta?.updated_at ?? stored.updated_at,
    };
    setField(source, field, view);
  }
  return source;
}

/** A stored source with each sealed secret as a placeholder: for showing the config where
 * the sealing keys are not at hand (`seshi config show`). */
/** Why a stored source's secret must be a value: `{ env }` and `{ file }` would read the
 * server's own environment and files, which an admin token must not reach. */
const NOT_A_VALUE =
  "a source stored in the bucket takes each secret as its value (seshi seals it); { env } and { file } name the server's own environment and files, so they belong in seshi.toml";

function masked(id: string, stored: StoredSource): Record<string, unknown> {
  const source = structuredClone(stored.source);
  for (const field of secretFields(source)) {
    if (isSealed(getField(source, field))) setField(source, field, "[sealed]");
  }
  return { ...source, id };
}

function unsetField(tree: Record<string, unknown>, dotted: string): void {
  const keys = dotted.split(".");
  const parents: Record<string, unknown>[] = [tree];
  let at: unknown = tree;
  for (const key of keys.slice(0, -1)) {
    if (at === null || typeof at !== "object" || Array.isArray(at)) return;
    at = (at as Record<string, unknown>)[key];
    if (at === null || typeof at !== "object" || Array.isArray(at)) return;
    parents.push(at as Record<string, unknown>);
  }
  delete (parents.at(-1) as Record<string, unknown>)[keys.at(-1) as string];
  // Drop the tables the removal emptied.
  for (let i = parents.length - 1; i > 0; i--) {
    if (Object.keys(parents[i] as object).length > 0) break;
    delete (parents[i - 1] as Record<string, unknown>)[keys[i - 1] as string];
  }
}

/** Where a secret's value is written into a doc rather than named (`{ env = … }`): review
 * keys, the only secrets a runtime section holds. */
function literalSecrets(tree: Record<string, unknown>): string[] {
  const found: string[] = [];
  const policies = (tree.review as { policies?: unknown } | undefined)?.policies;
  if (Array.isArray(policies)) {
    policies.forEach((policy, i) => {
      for (const step of ["decision", "redactor"]) {
        const key = (policy as Record<string, Record<string, unknown>>)?.[step]?.api_key;
        if (typeof key === "string") found.push(`review.policies.${i}.${step}.api_key`);
      }
    });
  }
  return found;
}

function originOfSource(loaded: Loaded<ServerConfig>, id: string): string {
  const index = loaded.config.sources.findIndex((s) => s.id === id);
  const origin = loaded.origins.get(["sources", index, "type"]);
  return origin.source === "file" ? origin.path : origin.source;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
