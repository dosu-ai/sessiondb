import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { Auth, AuthSettingsError, authSettings, ownershipAuthorizer } from "@seshi/auth";
import {
  ConfigError,
  filterFor,
  type RevealedBucketCredentials,
  type ROLES,
  revealBucketCredentials,
  type ServerConfig,
  type SourceConfig,
  serverConfigProblems,
  visibilityFor,
} from "@seshi/config";
import type { FormatRegistry } from "@seshi/formats";
import { type Connector, connectorsOf, type Integration } from "@seshi/kit";
import {
  type Claims,
  excludingEntry,
  type LayoutMarker,
  localWriter,
  type OwnerBasis,
  type RepoExcludes,
  repoExcludes,
  type StorageView,
  VERSION,
  type Visibility,
  type Writer,
} from "@seshi/model";
import {
  type FilterSetting,
  type HealthCounters,
  type Limits,
  Pipeline,
  type Reviewer,
  type SpanAssembler,
  SpanStore,
  StoreHealthCounters,
  StoreSeshi,
  type VisibilitySetting,
} from "@seshi/pipeline";
import {
  compileRuleSet,
  loadPacks,
  type RedactionRules,
  RulePackError,
  type RuleSet,
} from "@seshi/redact";
import { ReviewSetupError, reviewerFromConfig } from "@seshi/review";
import { SearchService } from "@seshi/search";
import { builtinConnectors, Sources } from "@seshi/sources";
import {
  assertOwner,
  ensureLayout,
  LayoutError,
  openStore,
  probe,
  readLayout,
  type Store,
} from "@seshi/store";
import {
  assembleOnce,
  BUILTIN_JOBS,
  type JobFactory,
  type JobHost,
  POLLER_PREFIX,
  pollerJob,
} from "./builtin-jobs";
import { Coalesced } from "./coalesced";
import { JobRunner } from "./jobs";
import { type Logger, quietLogger } from "./log";
import {
  type ConfigStatus,
  configHash,
  diffSources,
  effectiveConfig,
  LIVE_SECTIONS,
  RESTART_ONLY_SECTIONS,
  type ReloadReport,
  type ReloadTrigger,
  reviewSetHash,
  same,
} from "./reload";
import type { RuntimeConfig } from "./runtime";
import { type InstanceStatus, instanceStatus } from "./status";

export type Role = (typeof ROLES)[number];

export class InstanceError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "InstanceError";
  }
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export interface InstanceParts {
  config: ServerConfig;
  store: Store;
  storage: StorageView;
  formats: FormatRegistry;
  deployment: string;
  /** The connectors this binary has: the integrations' (`connectorsOf`). The built-in S3
   * poller (F6) is added unless one of these polls `s3` already. */
  connectors?: readonly Connector[];
  /** Where the built-in S3 poller reads bucket keys from when a source sets none (`AWS_*`,
   * `S3_*`, `R2_*`); `process.env` by default. */
  env?: Readonly<Record<string, string | undefined>>;
  /** The redaction rule set: the built-in pack and the operator's packs (F2.1).
   * `buildInstance` reads `redaction.packs` into it; the built-in pack alone when omitted. */
  redaction?: RedactionRules;
  /** Model review (F3); `buildInstance` builds it from `[review]` (none when there are no
   * policies). `new Instance` takes it as given. */
  reviewer?: Reviewer;
  /** Where span batches go (X4.2, 09); the span store in the bucket (`SpanStore`) when
   * omitted. The `assembler` job publishes what it holds. */
  assembler?: SpanAssembler;
  /** Identity and access; built from `[auth]` when omitted. */
  auth?: Auth;
  /** Source health; this instance's own shard in the bucket when omitted. */
  health?: HealthCounters;
  /** Where drop and failure records go; the bucket when omitted. A serverless laptop keeps
   * them in its own state folder (F11.10). */
  records?: Store;
  /** The pipeline writes the layout marker when the bucket has none (true). Serverless
   * laptops never do (F11.11). */
  createLayout?: boolean;
  /** The session filter; `[filter]` with each source's overrides when omitted. */
  filter?: FilterSetting;
  /** Size caps; `[limits]` when omitted. */
  limits?: Readonly<Limits>;
  /** A new session's visibility fallback; each source's, then `default_visibility`, when
   * omitted. */
  visibility?: VisibilitySetting;
  /** What this instance runs; `server.roles` when omitted. */
  roles?: readonly Role[];
  /** The stable instance id: health shards and the heartbeat's `host`. `server.instance_id`,
   * else the host name. */
  id?: string;
  jobs?: readonly JobFactory[];
  /** Session search (F10); built from `[search]` when omitted, none when null. */
  search?: SearchService | null;
  now?: () => Date;
  fetch?: typeof fetch;
  log?: Logger;
  client?: string;
  /** Reads the config again for `reload()`: the same file, drop-ins, env and flags the server
   * started with. Without it the instance reloads only a config handed to it. */
  loadConfig?: () => ServerConfig | Promise<ServerConfig>;
  /** The bucket's runtime config (`server.runtime_config = store`): synced every
   * `server.config_poll`, written by the admin API. */
  runtime?: RuntimeConfig;
}

/** The job that reads the bucket's runtime config on every instance. */
export const RUNTIME_JOB = "runtime-config";

export function defaultInstanceId(host: string = hostname()): string {
  const id = host
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return id === "" ? "seshi" : id;
}

export interface SessionIdentity {
  owner: string;
  writer: Writer;
  owner_basis: OwnerBasis;
  claims?: Claims;
  visibility?: Visibility;
}

export class Instance {
  readonly store: Store;
  readonly storage: StorageView;
  readonly formats: FormatRegistry;
  readonly deployment: string;
  readonly auth: Auth;
  readonly pipeline: Pipeline;
  readonly health: HealthCounters;
  readonly sources: Sources;
  readonly jobs: JobRunner;
  readonly assembler: SpanAssembler;
  /** Session search over a local index (F10.3); undefined when `search.enabled` is false. */
  readonly search: SearchService | undefined;
  readonly roles: readonly Role[];
  readonly id: string;
  readonly process: string;
  readonly client: string;
  readonly limits: Readonly<Limits>;
  readonly log: Logger;
  readonly startedAt: Date;
  readonly now: () => Date;
  private closed = false;
  private running: ServerConfig;
  private rules: RuleSet;
  private readonly ownAuth: boolean;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly loadConfig: InstanceParts["loadConfig"];
  private generation = 1;
  private loadedAt: Date;
  private hash: string;
  private restartRequired: string[] = [];
  /** What the running review judges with (`reviewFingerprint`); undefined for a reviewer
   * handed in that seshi did not build from `[review]`. */
  private reviewPrint: string | undefined;
  private lastReload: ReloadReport | null = null;
  private reloading: Promise<unknown> = Promise.resolve();
  /** The bucket's runtime config, when this server keeps one there. */
  readonly runtime: RuntimeConfig | undefined;
  private readonly refreshing = new Coalesced<void>();
  private lastFreshen = 0;

  /** The running config: the start-up one, or the last reload's (its restart-only sections are
   * always the start-up ones). */
  get config(): ServerConfig {
    return this.running;
  }

  /** The running redaction rule set. */
  get redaction(): RuleSet {
    return this.rules;
  }

  /** The org's exclude list as the running config has it (`[capture] exclude`, every file's
   * entries; a reload changes it at once), as written, blanks and comments left out: what
   * `GET /v1/capture/rules` serves laptops. */
  get captureExclude(): string[] {
    return written(this.config.capture.exclude);
  }

  /** The org's tool-call redaction list (`[capture] redact_tool_calls`), the same way. */
  get captureRedactToolCalls(): string[] {
    return written(this.config.capture.redact_tool_calls);
  }

  private readonly redactions = byIdentity(repoExcludes);

  /** The repository entries of the tool-call redaction list, read once per config: a session
   * whose `repo` one names is stored with its tool calls redacted. */
  get repoToolCallRedactions(): RepoExcludes {
    return this.redactions(this.config.capture.redact_tool_calls);
  }

  private readonly excludes = byIdentity(repoExcludes);

  /** The repository entries of that list, read once per config: what the server's own sources
   * match against (folder entries are a laptop's). */
  get repoExcludes(): RepoExcludes {
    return this.excludes(this.config.capture.exclude);
  }

  constructor(parts: InstanceParts) {
    const { config } = parts;
    this.running = config;
    this.loadConfig = parts.loadConfig;
    this.runtime = parts.runtime;
    this.fetchImpl = parts.fetch;
    this.store = parts.store;
    this.storage = parts.storage;
    this.formats = parts.formats;
    this.deployment = parts.deployment;
    this.now = parts.now ?? (() => new Date());
    this.startedAt = this.now();
    this.loadedAt = this.startedAt;
    this.hash = configHash(config);
    this.log = parts.log ?? quietLogger;
    this.client = parts.client ?? `seshi/${VERSION}`;
    this.roles = [...(parts.roles ?? config.server.roles)];
    this.id = parts.id ?? config.server.instance_id ?? defaultInstanceId();
    this.process = `${this.id}-${randomBytes(4).toString("hex")}`;
    this.limits = parts.limits ?? config.limits;
    this.rules = parts.redaction ?? compileRuleSet();
    this.reviewPrint = reviewFingerprint(parts.reviewer);

    this.ownAuth = parts.auth === undefined;
    if (parts.auth) {
      this.auth = parts.auth;
    } else {
      let settings: ReturnType<typeof authSettings>;
      try {
        settings = authSettings(config);
      } catch (err) {
        if (err instanceof AuthSettingsError) throw new InstanceError(err.message);
        throw err;
      }
      this.auth = new Auth(settings, {
        store: this.store,
        deployment: this.deployment,
        sources: config.sources.map((s) => s.id),
        now: this.now,
        ...(parts.fetch ? { fetch: parts.fetch } : {}),
      });
    }

    this.health =
      parts.health ??
      new StoreHealthCounters(this.store, {
        instance: this.id,
        now: this.now,
        onError: (err) => this.log.warn(`source health not recorded: ${message(err)}`),
      });

    this.assembler = parts.assembler ?? new SpanStore({ store: this.store, now: this.now });

    this.pipeline = new Pipeline({
      store: this.store,
      formats: this.formats,
      client: this.client,
      now: this.now,
      redaction: this.rules,
      filter: parts.filter ?? ((sourceId) => filterFor(this.config, sourceId)),
      limits: this.limits,
      reviewer: parts.reviewer,
      assembler: this.assembler,
      health: this.health,
      authorizer: ownershipAuthorizer(),
      visibility: parts.visibility ?? ((sourceId) => visibilityFor(this.config, sourceId)),
      excludedRepo: (repo) => excludingEntry(this.repoExcludes, [repo]),
      toolCallsRedactedFor: (repo) => excludingEntry(this.repoToolCallRedactions, [repo]),
      sourceLabels: (sourceId) => this.config.sources.find((s) => s.id === sourceId)?.labels,
      ...(parts.records ? { records: parts.records } : {}),
      ...(parts.createLayout !== undefined ? { createLayout: parts.createLayout } : {}),
    });

    const given = parts.connectors ?? [];
    const builtin = builtinConnectors({
      formats: this.formats,
      maxBytes: this.limits.max_upload_bytes,
      ...(parts.env ? { env: parts.env } : {}),
    }).filter((c) => !given.some((g) => g.kind === c.kind));
    this.sources = new Sources({
      store: this.store,
      pipeline: this.pipeline,
      sources: config.sources,
      connectors: [...given, ...builtin] as Connector[],
      ...(parts.fetch ? { fetch: parts.fetch } : {}),
      log: this.log,
      now: this.now,
      excludes: () => this.repoExcludes,
      toolCallRedactions: () => this.repoToolCallRedactions,
    });

    this.search =
      parts.search === null
        ? undefined
        : (parts.search ??
          (config.search.enabled
            ? new SearchService({
                store: this.store,
                deployment: this.deployment,
                settings: {
                  ...(config.search.path ? { path: config.search.path } : {}),
                  events: config.search.events,
                },
                aliases: this.auth.aliases,
                now: this.now,
                log: this.log,
                feed: true,
              })
            : undefined));

    this.jobs = new JobRunner({
      worker: this.roles.includes("worker"),
      now: this.now,
      log: this.log,
    });
    const instance = this;
    const host: JobHost = {
      store: this.store,
      sources: this.sources,
      jobs: this.jobs,
      ...(this.search ? { search: this.search } : {}),
      get config() {
        return instance.config;
      },
      roles: this.roles,
      process: this.process,
      id: this.id,
      version: VERSION,
      startedAt: this.startedAt,
      pipeline: this.pipeline,
      formats: this.formats,
      now: this.now,
    };
    for (const factory of [...BUILTIN_JOBS, ...(parts.jobs ?? [])]) {
      for (const job of factory(host)) this.jobs.register(job);
    }
    if (this.runtime) {
      const runtime = this.runtime;
      runtime.markApplied();
      this.jobs.register({
        name: RUNTIME_JOB,
        kind: RUNTIME_JOB,
        placement: "every",
        intervalMs: runtime.pollMs,
        run: async () => {
          await this.refreshConfig();
          await runtime.heartbeat(this.id, this.process);
          return { outcome: "ok" };
        },
      });
    }
  }

  /** Read the bucket's runtime config and apply it when it changed. One at a time; a caller
   * that arrives while one runs waits for it. A version that does not load or check is not
   * applied: the running config stays, and the problem is reported (`configStatus`, the
   * instance's heartbeat). */
  refreshConfig(): Promise<void> {
    if (!this.runtime) return Promise.resolve();
    return this.refreshing.run(() => this.refreshNow());
  }

  private async refreshNow(): Promise<void> {
    const runtime = this.runtime as RuntimeConfig;
    const changed = await runtime.sync();
    // Nothing new, and what runs is the bucket's (or was refused, and is not tried again until
    // the bucket changes). A reload from elsewhere (SIGHUP) may have read a new version without
    // recording it: apply it here, which records it.
    if (!changed && (runtime.applied.version === runtime.version || runtime.applied.problem)) {
      return;
    }
    let next: ServerConfig;
    try {
      const loaded = runtime.compose();
      for (const warning of loaded.warnings) this.log.warn(`runtime config: ${warning}`);
      next = loaded.config;
    } catch (err) {
      const why = err instanceof ConfigError ? err.issues.join("; ") : message(err);
      this.log.error(`runtime config ${runtime.version} not applied: ${why}`);
      runtime.markApplied(why);
      return;
    }
    const report = await this.reload("store", next);
    if (report.outcome === "rejected") runtime.markApplied((report.errors ?? []).join("; "));
    else runtime.markApplied();
  }

  /** Before a request: when the bucket was last read more than two polls ago (an instance
   * whose CPU was held between requests), read it first, waiting at most `waitMs`. */
  async freshen(waitMs = 2_000): Promise<void> {
    const runtime = this.runtime;
    if (!runtime) return;
    const now = this.now().getTime();
    const last = runtime.lastSync?.getTime() ?? 0;
    if (now - last <= 2 * runtime.pollMs) return;
    // A bucket that is failing or hanging is not waited on by every request: one wait per
    // poll interval, and the rest go on with the config running.
    if (now - this.lastFreshen < runtime.pollMs) return;
    this.lastFreshen = now;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.refreshConfig().catch((err) =>
        this.log.warn(`runtime config: cannot read the bucket: ${message(err)}`),
      ),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, waitMs);
      }),
    ]);
    clearTimeout(timer);
  }

  /** The problems a config would be refused for, without applying it: what a reload checks
   * (cross-section rules, rule packs, review policies), with this instance's restart-only
   * sections. The admin API checks each runtime change with it before writing. */
  async check(next: ServerConfig): Promise<string[]> {
    const { config } = effectiveConfig(this.running, next);
    const problems = serverConfigProblems(config);
    if (problems.length > 0) return problems;
    try {
      await readRedactionPacks(config.redaction.packs);
      await buildReviewer(config, {
        ...(this.fetchImpl ? { fetch: this.fetchImpl } : {}),
        log: this.log,
      });
    } catch (err) {
      return [message(err)];
    }
    return [];
  }

  /** The config's generation and hash, and how the last reload went. */
  configStatus(): ConfigStatus {
    return {
      generation: this.generation,
      config_hash: this.hash,
      rule_set: this.rules.hash,
      review_set: reviewSetHash(this.reviewPrint),
      loaded_at: this.loadedAt.toISOString(),
      reloadable: this.loadConfig !== undefined,
      restart_required: [...this.restartRequired],
      last_reload: this.lastReload ? structuredClone(this.lastReload) : null,
      live_sections: LIVE_SECTIONS,
      restart_only_sections: RESTART_ONLY_SECTIONS,
      ...(this.runtime
        ? {
            runtime: {
              version: this.runtime.version,
              applied: this.runtime.applied.version,
              applied_at: this.runtime.applied.at.toISOString(),
              last_sync: this.runtime.lastSync?.toISOString() ?? null,
              ...(this.runtime.applied.problem ? { problem: this.runtime.applied.problem } : {}),
            },
          }
        : {}),
    };
  }

  /** Apply a changed config without a restart: `next`, or the config read again through
   * `loadConfig`. All or nothing: the config is loaded and checked and the rule packs and review
   * policies (their prompt files read again) are built before anything changes; on any error the
   * running config stays and the report says why. Then sources are compared by id: an added
   * one starts polling, a removed one stops (its run is aborted and waited for), a changed one
   * restarts, an unchanged one keeps running. Checkpoints are never touched. New writes use the
   * new rules and review; a write already going finishes with the ones it started with. Settings in
   * `RESTART_ONLY_SECTIONS` keep their running values and are listed in `restart_required`.
   * Reloads run one at a time, in the order asked. */
  reload(trigger: ReloadTrigger = "manual", next?: ServerConfig): Promise<ReloadReport> {
    const run = this.reloading.then(() => this.reloadNow(trigger, next));
    this.reloading = run.catch(() => undefined);
    return run;
  }

  private async reloadNow(trigger: ReloadTrigger, given?: ServerConfig): Promise<ReloadReport> {
    const started = this.now();
    const report = (
      outcome: ReloadReport["outcome"],
      extra: Partial<ReloadReport> = {},
    ): ReloadReport => {
      const done: ReloadReport = {
        trigger,
        started_at: started.toISOString(),
        finished_at: this.now().toISOString(),
        outcome,
        generation: this.generation,
        config_hash: this.hash,
        rule_set: this.rules.hash,
        review_set: reviewSetHash(this.reviewPrint),
        changed: [],
        restart_required: [],
        ...extra,
      };
      this.lastReload = done;
      return done;
    };
    const reject = (errors: string[]): ReloadReport => {
      const done = report("rejected", { errors, restart_required: [...this.restartRequired] });
      for (const error of errors) this.log.error(`config reload (${trigger}) rejected: ${error}`);
      return done;
    };
    if (this.closed) return reject(["this instance is closed"]);

    let next: ServerConfig;
    try {
      if (given) next = given;
      else if (this.loadConfig) next = await this.loadConfig();
      else return reject(["this server was not started from a config file it can read again"]);
    } catch (err) {
      return reject(err instanceof ConfigError ? err.issues : [message(err)]);
    }
    const { config, restartRequired } = effectiveConfig(this.running, next);
    const problems = serverConfigProblems(config);
    if (problems.length > 0) return reject(problems);

    let rules: RuleSet;
    try {
      rules = await readRedactionPacks(config.redaction.packs);
    } catch (err) {
      return reject([message(err)]);
    }
    // Built every time, so a prompt file edited without a change to [review] is seen: each
    // policy's hash covers its prompt text. Building reads the prompt files and makes the
    // provider objects; it calls no model.
    let reviewer: Reviewer | undefined;
    try {
      reviewer = await buildReviewer(config, {
        ...(this.fetchImpl ? { fetch: this.fetchImpl } : {}),
        log: this.log,
      });
    } catch (err) {
      return reject([message(err)]);
    }
    const reviewPrint = reviewFingerprint(reviewer);
    const reviewChanged =
      !same(this.running.review, config.review) ||
      (this.reviewPrint !== undefined && this.reviewPrint !== reviewPrint);
    if (this.closed) return reject(["this instance is closed"]);

    const changed = LIVE_SECTIONS.filter((section) =>
      section === "redaction"
        ? rules.hash !== this.rules.hash
        : section === "review"
          ? reviewChanged
          : !same(this.running[section], config[section]),
    );
    const sources = diffSources(this.running.sources, config.sources);
    this.restartRequired = restartRequired;
    for (const path of restartRequired) {
      this.log.warn(`config reload (${trigger}): ${path} changed; it applies on restart`);
    }
    if (changed.length === 0) {
      this.running = config;
      return report("unchanged", { sources, restart_required: restartRequired });
    }

    // Stop what goes away or restarts, before the new config is in place.
    await Promise.all(
      [...sources.removed, ...sources.changed].map((id) =>
        this.jobs.unregister(`${POLLER_PREFIX}${id}`),
      ),
    );
    const ruleSetBefore = this.rules.hash;
    this.running = config;
    this.sources.update(config.sources);
    if (this.ownAuth) this.auth.setSources(config.sources.map((s) => s.id));
    if (rules.hash !== ruleSetBefore) {
      this.rules = rules;
      this.pipeline.setRedaction(rules);
    }
    if (reviewChanged) {
      this.pipeline.setReviewer(reviewer);
      this.reviewPrint = reviewPrint;
    }
    for (const id of [...sources.added, ...sources.changed]) {
      const info = this.sources.get(id);
      const name = `${POLLER_PREFIX}${id}`;
      if (info.polled && !this.jobs.get(name)) {
        this.jobs.register(
          pollerJob({ sources: this.sources, store: this.store, now: this.now }, info),
        );
      }
    }
    this.generation += 1;
    this.loadedAt = this.now();
    this.hash = configHash(config);
    const done = report("applied", { changed, sources, restart_required: restartRequired });
    const parts = [
      ...(sources.added.length > 0 ? [`sources added ${sources.added.join(", ")}`] : []),
      ...(sources.removed.length > 0 ? [`removed ${sources.removed.join(", ")}`] : []),
      ...(sources.changed.length > 0 ? [`restarted ${sources.changed.join(", ")}`] : []),
      ...(rules.hash !== ruleSetBefore
        ? [`rule set ${ruleSetBefore.slice(0, 12)} -> ${rules.hash.slice(0, 12)}`]
        : []),
      ...changed.filter((c) => c !== "sources" && c !== "redaction"),
    ];
    this.log.info(
      `config reloaded (${trigger}): generation ${this.generation}${parts.length > 0 ? `; ${parts.join("; ")}` : ""}`,
    );
    return done;
  }

  get api(): boolean {
    return this.roles.includes("api");
  }

  get worker(): boolean {
    return this.roles.includes("worker");
  }

  start(): void {
    if (this.closed) throw new Error("this instance is closed");
    this.jobs.start();
  }

  /** Stop the jobs and write what source health counted, each bounded by `timeoutMs`. The
   * instance is not used after this. */
  async close(timeoutMs = 5_000): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.jobs.stop(timeoutMs);
    if (this.runtime) {
      await this.runtime.forget(this.process);
      this.runtime.close();
    }
    this.search?.close();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.health.flush(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
    clearTimeout(timer);
  }

  status(): Promise<InstanceStatus> {
    return instanceStatus(this);
  }

  sessions(identity: SessionIdentity): StoreSeshi {
    return new StoreSeshi({
      store: this.store,
      storage: this.storage,
      owner: identity.owner,
      formats: this.formats,
      client: this.client,
      now: this.now,
      pipeline: this.pipeline,
      writer: identity.writer,
      owner_basis: identity.owner_basis,
      ...(identity.claims ? { claims: identity.claims } : {}),
      ...(identity.visibility ? { visibility: identity.visibility } : {}),
    });
  }

  /** The session API as `owner` itself, through the upload route. `basis` is how the owner
   * was established: `claimed` in serverless mode, where nothing seshi controls checked the
   * name (F11.4). */
  localSessions(owner: string, basis: OwnerBasis = "verified"): StoreSeshi {
    assertOwner(owner);
    return this.sessions({ owner, writer: localWriter(owner), owner_basis: basis });
  }

  source(id: string): SourceConfig | undefined {
    return this.config.sources.find((s) => s.id === id);
  }

  async prune(): Promise<PruneRun> {
    const record = await this.jobs.runNow("retention");
    const summary = record.last_summary ?? {};
    return {
      dropped: summary.dropped ?? 0,
      failed: summary.failed ?? 0,
      health: summary.health ?? 0,
      ...(record.last_outcome === "error" && record.last_error
        ? { error: record.last_error.message }
        : {}),
    };
  }

  /** Run the span assembler now, whatever this instance's roles: `seshi sync assemble`, the
   * one-shot a deployment with no worker runs from cron (X7.1), as the `assembler` job does
   * on the worker. Passes run until nothing more is waiting, a pass hits an error (its
   * session keeps its marker), a pass gets nowhere, or `maxPasses` (100) ran. Counts are
   * summed over the passes; `waiting` is the last pass's. */
  async assemble(options: { signal?: AbortSignal; maxPasses?: number } = {}): Promise<AssembleRun> {
    const maxPasses = options.maxPasses ?? 100;
    const run: AssembleRun = {
      passes: 0,
      published: 0,
      waiting: 0,
      failed: 0,
      retouched: 0,
      errors: 0,
      dropped: 0,
      outcomes: {},
      more: false,
    };
    for (;;) {
      const { report, error } = await assembleOnce(this, options.signal);
      run.passes += 1;
      run.published += report.published;
      run.waiting = report.waiting;
      run.failed += report.failed;
      run.retouched += report.retouched;
      run.errors += report.errors;
      run.dropped += report.dropped;
      for (const [status, n] of Object.entries(report.outcomes)) {
        run.outcomes[status] = (run.outcomes[status] ?? 0) + n;
      }
      run.more = report.more;
      if (error !== undefined) run.error ??= error;
      const progress = report.published + report.failed + report.dropped + report.retouched;
      if (
        !report.more ||
        error !== undefined ||
        progress === 0 ||
        options.signal?.aborted ||
        run.passes >= maxPasses
      ) {
        return run;
      }
    }
  }
}

export interface PruneRun {
  dropped: number;
  failed: number;
  health: number;
  error?: string;
}

export interface AssembleRun {
  passes: number;
  published: number;
  waiting: number;
  failed: number;
  retouched: number;
  errors: number;
  dropped: number;
  outcomes: Record<string, number>;
  more: boolean;
  error?: string;
}

export interface BuildOptions
  extends Omit<InstanceParts, "config" | "store" | "storage" | "deployment" | "connectors"> {
  store?: { store: Store; storage: StorageView };
  /** Env the bucket client falls back to for credentials (`AWS_*`, `S3_*`, `R2_*`) when
   * `[store]` sets none; `process.env` by default. */
  env?: Record<string, string | undefined>;
  integrations?: readonly Integration[];
  connectors?: readonly Connector[];
  /** Owners whose folders are written and read back once, so a bucket key that cannot write
   * fails now and not on the first session; the static tokens' owners by default. */
  probe?: readonly string[];
  newDeploymentId?: () => string;
  /** Write the layout marker when the bucket has none (true by default). Read-only commands
   * pass false: they refuse a bucket no seshi server has used rather than claim it, so a
   * mistyped `store.url` is not turned into a new deployment by a status check. */
  initialize?: boolean;
  /** Record `store.org` in a marker that names none (true). A serverless laptop never writes
   * the marker (F11.11): it checks the org, and leaves an unnamed one alone. */
  claimOrg?: boolean;
}

export function storeOptions(config: ServerConfig): {
  region?: string;
  endpoint?: string;
  accountId?: string;
  accountName?: string;
  credentials?: RevealedBucketCredentials;
} {
  const { store } = config;
  return {
    ...(store.region ? { region: store.region } : {}),
    ...(store.endpoint ? { endpoint: store.endpoint } : {}),
    ...(store.account_id ? { accountId: store.account_id } : {}),
    ...(store.account_name ? { accountName: store.account_name } : {}),
    ...(store.credentials ? { credentials: revealBucketCredentials(store.credentials) } : {}),
  };
}

export async function readRedactionPacks(paths: readonly string[]): Promise<RuleSet> {
  const files: { path: string; text: string }[] = [];
  for (const path of paths) {
    try {
      files.push({ path, text: await Bun.file(path).text() });
    } catch (err) {
      throw new InstanceError(`cannot read redaction pack ${path}: ${message(err)}`);
    }
  }
  try {
    const loaded = loadPacks(files);
    return compileRuleSet({
      packs: loaded.map((l) => l.pack),
      sources: Object.fromEntries(loaded.map((l) => [l.pack.id, l.source])),
      runTests: true,
    });
  } catch (err) {
    if (err instanceof RulePackError) throw new InstanceError(err.message, { cause: err });
    throw err;
  }
}

/** The hashes of a reviewer's policies (each covers its prompt text, steps and categories):
 * `[]` for no review, undefined for a reviewer that does not say what it judges with. */
function reviewFingerprint(reviewer: Reviewer | undefined): string | undefined {
  if (reviewer === undefined) return "[]";
  const policies = (reviewer as { policies?: unknown }).policies;
  if (!Array.isArray(policies)) return undefined;
  return JSON.stringify(policies.map((p: { id?: unknown; hash?: unknown }) => [p.id, p.hash]));
}

async function buildReviewer(
  config: ServerConfig,
  options: Pick<BuildOptions, "fetch" | "log">,
): Promise<Reviewer | undefined> {
  try {
    return await reviewerFromConfig(config, {
      ...(options.fetch ? { fetch: options.fetch } : {}),
      log: options.log ?? quietLogger,
    });
  } catch (err) {
    if (err instanceof ReviewSetupError) throw new InstanceError(err.message, { cause: err });
    throw err;
  }
}

/** Build an Instance from a loaded config: open the bucket, read the redaction packs, check
 * the layout marker (X1.4: the bucket must be this deployment's and org's), and probe the
 * static tokens' owners. Every failure is an `InstanceError` saying what to fix. */
export async function buildInstance(
  config: ServerConfig,
  options: BuildOptions,
): Promise<Instance> {
  const url = config.store.url;
  let opened: { store: Store; storage: StorageView };
  if (options.store) {
    opened = options.store;
  } else {
    try {
      opened = openStore(url, {
        ...storeOptions(config),
        ...(options.env ? { env: options.env } : {}),
      });
    } catch (err) {
      throw new InstanceError(message(err), { cause: err });
    }
  }
  const redaction = options.redaction ?? (await readRedactionPacks(config.redaction.packs));
  const reviewer = options.reviewer ?? (await buildReviewer(config, options));
  const client = options.client ?? `seshi/${VERSION}`;

  if (options.initialize === false) {
    let existing: LayoutMarker | null;
    try {
      existing = await readLayout(opened.store);
    } catch (err) {
      throw new InstanceError(`cannot read ${url}: ${message(err)}`, { cause: err });
    }
    if (existing === null) {
      throw new InstanceError(
        `no seshi deployment at ${url}: check store.url, or start seshi serve (or seshi admin init) against it first`,
      );
    }
  }

  let marker: LayoutMarker;
  try {
    marker = await ensureLayout(opened.store, {
      createdBy: client,
      deploymentId: config.store.deployment_id,
      org: config.store.org,
      ...(options.initialize === false ? { create: false } : {}),
      ...(options.claimOrg === false ? { claimOrg: false } : {}),
      ...(options.now ? { now: options.now } : {}),
      ...(options.newDeploymentId ? { newDeploymentId: options.newDeploymentId } : {}),
    });
  } catch (err) {
    if (err instanceof LayoutError) {
      throw new InstanceError(`cannot use ${url}: ${message(err)}`, { cause: err });
    }
    throw new InstanceError(`cannot write to ${url}: ${message(err)}`, { cause: err });
  }

  const {
    store: _store,
    integrations,
    connectors,
    probe: probed,
    newDeploymentId: _newDeploymentId,
    initialize: _initialize,
    claimOrg: _claimOrg,
    ...rest
  } = options;
  let instanceConnectors: Connector[];
  try {
    instanceConnectors = [...connectorsOf(integrations ?? []), ...(connectors ?? [])];
  } catch (err) {
    throw new InstanceError(message(err), { cause: err });
  }
  const instance = new Instance({
    ...rest,
    config,
    store: opened.store,
    storage: opened.storage,
    deployment: marker.deployment_id,
    connectors: instanceConnectors,
    redaction,
    ...(reviewer ? { reviewer } : {}),
    client,
  });

  for (const owner of probed ?? Object.keys(config.auth.tokens)) {
    try {
      await probe(opened.store, owner);
    } catch (err) {
      throw new InstanceError(`cannot write to ${url}: ${message(err)}`, { cause: err });
    }
  }
  return instance;
}

/** A list's entries as written, blanks and `#` comments left out. */
function written(entries: readonly string[]): string[] {
  return entries.map((entry) => entry.trim()).filter((e) => e !== "" && !e.startsWith("#"));
}

/** `read` remembering its last answer for as long as it is asked about the same list (one config
 * generation: a reload's list is a new array). */
function byIdentity<T>(read: (entries: readonly string[]) => T): (entries: readonly string[]) => T {
  let last: { from: readonly string[]; value: T } | undefined;
  return (entries) => {
    if (last?.from !== entries) last = { from: entries, value: read(entries) };
    return last.value;
  };
}
