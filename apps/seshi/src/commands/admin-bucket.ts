import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { parseArgs } from "node:util";
import {
  type BaseLayer,
  baseLayerIn,
  ConfigError,
  loadConfig,
  loadServerConfig,
  loadServerlessConfig,
  parseConfigToml,
  SHARED_CONFIG,
  SHARED_PREFIX,
  safeSharedName,
  secretsIn,
  serverConfigSchema,
} from "@seshi/config";
import { readRedactionPacks } from "@seshi/instance";
import { type BucketMode, VERSION } from "@seshi/model";
import { isPreconditionFailed, parseVersion, type Store, setLayout } from "@seshi/store";
import { openAccount } from "../account/account";
import { writePrivateFile } from "../account/secrets";
import { EXIT } from "../cli/exit";
import { Refused } from "../cli/failures";
import { emit, helpOrUsageError } from "../cli/output";
import { openBucketStore, openServerlessStore, refusalOf } from "../serverless/open";
import { isServerless } from "../serverless/settings";
import { listSharedKeys } from "../serverless/shared";
import type { CommandContext } from "./index";
import { configFlags } from "./serve-settings";
import { SERVER_OPTIONS } from "./server-instance";

export const BUCKET_USAGE = [
  "       seshi admin mode server|serverless           which mode the bucket is used in (F11.8)",
  "       seshi admin layout --min-version <v> | --clear-min-version",
  "       seshi admin config pull [<dir>]              the bucket's shared settings (config/)",
  "       seshi admin config push [<dir>] [--dry-run]",
  "       (each takes --config <file> and --set path=value for a server config's [store];",
  "        the CLI config's [serverless] bucket otherwise)",
].join("\n");

/** Where `admin config pull` writes and `push` reads by default. */
export const DEFAULT_CONFIG_DIR = "seshi-config";
/** Beside the pulled files: the ETags they had, so `push` changes only what it read. */
const PULLED = ".seshi-pulled.json";

interface BucketValues {
  config?: string;
  set?: string[];
}

class UsageError extends Error {}

/** The bucket an admin command works on: a server config's `[store]` when one is named,
 * else the CLI config's serverless bucket. */
async function adminStore(
  ctx: CommandContext,
  values: BucketValues,
): Promise<{ store: Store; url: string }> {
  const account = openAccount(ctx);
  if (values.config === undefined && values.set === undefined && isServerless(account.cli)) {
    const { store } = await openServerlessStore({
      cli: account.cli,
      env: ctx.env,
      home: account.home,
      secrets: account.secrets,
    });
    return { store, url: store.url };
  }
  const loaded = loadServerConfig({
    configFlag: values.config,
    env: ctx.env,
    flags: configFlags(values),
  });
  const { store } = await openBucketStore(loaded.config, account.secrets, ctx.env);
  return { store, url: store.url };
}

function parse<T>(args: string[], options: Record<string, { type: "string" | "boolean" }>) {
  try {
    return parseArgs({
      args,
      options: { ...SERVER_OPTIONS, ...options },
      strict: true,
      allowPositionals: true,
    }) as unknown as { values: T; positionals: string[] };
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
}

async function mode(ctx: CommandContext, json: boolean, args: string[]): Promise<number> {
  const { values, positionals } = parse<BucketValues>(args, {});
  const [wanted, ...extra] = positionals;
  if ((wanted !== "server" && wanted !== "serverless") || extra.length > 0) {
    throw new UsageError("admin mode takes server or serverless");
  }
  const { store, url } = await adminStore(ctx, values);
  const marker = await setLayout(
    store,
    { mode: wanted as BucketMode },
    {
      by: `seshi/${VERSION}`,
    },
  ).catch((err) => {
    throw refusalOf(err);
  });
  emit(ctx, json, marker, () => [
    `${url} is in ${wanted} mode.`,
    wanted === "server"
      ? "Next: move each laptop with seshi login --server <url>, then remove their bucket keys."
      : "Next: stop the server, then run seshi init --serverless on each laptop.",
  ]);
  return EXIT.ok;
}

async function layout(ctx: CommandContext, json: boolean, args: string[]): Promise<number> {
  const { values, positionals } = parse<
    BucketValues & { "min-version"?: string; "clear-min-version"?: boolean }
  >(args, { "min-version": { type: "string" }, "clear-min-version": { type: "boolean" } });
  if (positionals.length > 0) throw new UsageError(`unexpected argument '${positionals[0]}'`);
  const set = values["min-version"];
  const clear = values["clear-min-version"] === true;
  if ((set === undefined) === !clear) {
    throw new UsageError("give --min-version <v> or --clear-min-version");
  }
  if (set !== undefined) {
    try {
      parseVersion(set);
    } catch (err) {
      throw new UsageError((err as Error).message);
    }
  }
  const { store, url } = await adminStore(ctx, values);
  const marker = await setLayout(
    store,
    { min_version: clear ? null : (set as string) },
    { by: `seshi/${VERSION}` },
  ).catch((err) => {
    throw refusalOf(err);
  });
  emit(ctx, json, marker, () => [
    marker.min_version
      ? `${url} now needs seshi ${marker.min_version} or newer to write; older ones read with a warning.`
      : `${url} has no minimum version.`,
  ]);
  return EXIT.ok;
}

function filesIn(dir: string): string[] {
  const out: string[] = [];
  const walk = (at: string) => {
    for (const name of readdirSync(at).sort()) {
      if (name.startsWith(".")) continue;
      const path = join(at, name);
      if (statSync(path).isDirectory()) walk(path);
      else out.push(relative(dir, path).split(sep).join("/"));
    }
  };
  walk(dir);
  return out.filter(safeSharedName);
}

function readPulled(dir: string): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, PULLED), "utf8")) as {
      files?: Record<string, string>;
    };
    return parsed.files ?? {};
  } catch {
    return {};
  }
}

/** The checks `seshi serve` runs at start, on a shared config before it is pushed: the
 * config's shape, each pack against its own test strings, and no literal secrets (F11.6). */
async function checkShared(dir: string, url: string): Promise<string[]> {
  const base: BaseLayer | undefined = baseLayerIn(dir, `${url}/${SHARED_PREFIX}${SHARED_CONFIG}`);
  if (!base) return [];
  const loaded = loadServerlessConfig({
    base,
    env: {},
    flags: [{ name: "the bucket", path: "store.url", value: url }],
    resolveSecrets: false,
  });
  // The whole file as a server reads it, the sections laptops ignore included: a secret's
  // value there would still be readable by every key that can read config/.
  const whole = loadConfig(serverConfigSchema, {
    base: {
      path: base.path,
      tree: parseConfigToml(base.path, readFileSync(join(dir, SHARED_CONFIG), "utf8")),
    },
    env: {},
    flags: [{ name: "the bucket", path: "store.url", value: url }],
    resolveSecrets: false,
  });
  const literal = secretsIn(whole.config)
    .filter(({ secret }) => secret.ref.kind === "literal")
    .map(({ path }) => path.join("."));
  if (literal.length > 0) {
    throw new ConfigError(
      literal.map(
        (path) =>
          `${path}: a secret's value in the shared config; use a reference ({ env = "NAME" }) so every laptop supplies its own`,
      ),
    );
  }
  await readRedactionPacks(loaded.config.redaction.packs);
  return loaded.ignored;
}

async function pull(ctx: CommandContext, json: boolean, args: string[]): Promise<number> {
  const { values, positionals } = parse<BucketValues>(args, {});
  if (positionals.length > 1) throw new UsageError("admin config pull takes one folder");
  const dir = positionals[0] ?? DEFAULT_CONFIG_DIR;
  const { store, url } = await adminStore(ctx, values);
  const files: Record<string, string> = {};
  try {
    for (const { name } of await listSharedKeys(store)) {
      const object = await store.get(`${SHARED_PREFIX}${name}`);
      if (!object) continue;
      const file = join(dir, name);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, object.body);
      files[name] = object.etag;
    }
  } catch (err) {
    throw refusalOf(err);
  }
  mkdirSync(dir, { recursive: true });
  writePrivateFile(join(dir, PULLED), `${JSON.stringify({ url, files }, null, 2)}\n`);
  const names = Object.keys(files);
  emit(ctx, json, { url, dir, files: names }, () =>
    names.length === 0
      ? [`${url} has no shared settings yet; write ${join(dir, SHARED_CONFIG)} and push it.`]
      : [
          `Pulled ${names.length} file(s) from ${url}/${SHARED_PREFIX} into ${dir}: ${names.join(", ")}`,
        ],
  );
  return EXIT.ok;
}

async function push(ctx: CommandContext, json: boolean, args: string[]): Promise<number> {
  const { values, positionals } = parse<BucketValues & { "dry-run"?: boolean }>(args, {
    "dry-run": { type: "boolean" },
  });
  if (positionals.length > 1) throw new UsageError("admin config push takes one folder");
  const dir = positionals[0] ?? DEFAULT_CONFIG_DIR;
  if (!existsSync(dir))
    throw new UsageError(`no folder ${dir}: pull first (seshi admin config pull)`);
  const names = filesIn(dir);
  if (!names.includes(SHARED_CONFIG)) {
    throw new UsageError(`${dir} has no ${SHARED_CONFIG}`);
  }
  const { store, url } = await adminStore(ctx, values);
  const ignored = await checkShared(dir, url);
  const pulled = readPulled(dir);
  const plan: { name: string; action: "create" | "update" | "same" }[] = [];
  for (const name of names) {
    const body = readFileSync(join(dir, name));
    const current = await store.get(`${SHARED_PREFIX}${name}`).catch((err) => {
      throw refusalOf(err);
    });
    if (current && Buffer.from(current.body).equals(body)) {
      plan.push({ name, action: "same" });
      continue;
    }
    if (current && pulled[name] !== current.etag) {
      throw new Refused(
        EXIT.conflict,
        "conflict",
        `${SHARED_PREFIX}${name} changed since this folder was pulled: pull again, redo the change, and push`,
      );
    }
    plan.push({ name, action: current ? "update" : "create" });
  }
  const changed = plan.filter((p) => p.action !== "same");
  if (!values["dry-run"]) {
    for (const { name, action } of changed) {
      const body = new Uint8Array(readFileSync(join(dir, name)));
      try {
        const put = await store.put(`${SHARED_PREFIX}${name}`, body, {
          contentType: name.endsWith(".toml") ? "application/toml" : "text/plain",
          ...(action === "update" ? { ifMatch: pulled[name] as string } : { ifNoneMatch: "*" }),
        });
        if (put.etag) pulled[name] = put.etag;
      } catch (err) {
        if (isPreconditionFailed(err)) {
          throw new Refused(
            EXIT.conflict,
            "conflict",
            `${SHARED_PREFIX}${name} changed while pushing: pull again, redo the change, and push`,
          );
        }
        throw refusalOf(err);
      }
    }
    writePrivateFile(join(dir, PULLED), `${JSON.stringify({ url, files: pulled }, null, 2)}\n`);
  }
  emit(ctx, json, { url, dry_run: values["dry-run"] === true, files: plan, ignored }, () => [
    changed.length === 0
      ? `${url}/${SHARED_PREFIX} already holds these files.`
      : `${values["dry-run"] ? "Would push" : "Pushed"} ${changed.map((p) => `${p.name} (${p.action})`).join(", ")} to ${url}/${SHARED_PREFIX}.`,
    ...ignored.map((i) => `note: ${i} is ignored by serverless laptops (it needs a server)`),
    ...(values["dry-run"] || changed.length === 0
      ? []
      : ["Laptops pick it up within 5 minutes; seshi doctor shows the copy each one uses."]),
  ]);
  return EXIT.ok;
}

/** `seshi admin mode|layout|config` (F11.6–F11.8). Undefined when `sub` is not one of them. */
export async function bucketAdmin(
  ctx: CommandContext,
  json: boolean,
  sub: string,
  args: string[],
  usage: string,
): Promise<number | undefined> {
  try {
    if (sub === "mode") return await mode(ctx, json, args);
    if (sub === "layout") return await layout(ctx, json, args);
    if (sub === "config") {
      const [verb, ...rest] = args;
      if (verb === "pull") return await pull(ctx, json, rest);
      if (verb === "push") return await push(ctx, json, rest);
      throw new UsageError("admin config takes pull or push");
    }
    return undefined;
  } catch (err) {
    if (err instanceof UsageError) return helpOrUsageError(ctx, json, err.message, usage);
    throw err;
  }
}
