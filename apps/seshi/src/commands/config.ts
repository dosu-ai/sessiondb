import { readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  type CheckReport,
  type CliConfig,
  type ConfigEntry,
  ConfigError,
  checkServerConfig,
  cliLabelProblems,
  configEntries,
  describeOrigin,
  displayTree,
  Keyring,
  type Loaded,
  loadCliConfig,
  loadServerConfig,
  type RuntimeLayer,
  type ServerConfig,
} from "@seshi/config";
import { RuntimeConfig, storeOptions } from "@seshi/instance";
import { compileRuleSet, loadPacks, RulePackError } from "@seshi/redact";
import { openStore } from "@seshi/store";
import { EXIT } from "../cli/exit";
import { ServeConfigError } from "../cli/failures";
import type { CommandContext } from "./index";
import { configFlags, serveSettings } from "./serve-settings";
import { cwdConfigHint } from "./server-instance";

const USAGE = `usage: seshi config check [--cli] [--config <file>] [--json] [--set path=value]…
       seshi config show  [--cli] [--config <file>] [--origin] [--json] [--set path=value]…`;

interface Options {
  cli?: boolean;
  config?: string;
  json?: boolean;
  origin?: boolean;
  listen?: string;
  roles?: string;
  set?: string[];
}

function loadCli(ctx: CommandContext, options: Options, resolveSecrets: boolean) {
  if (options.listen !== undefined || options.roles !== undefined) {
    throw new ServeConfigError("--listen and --roles are server settings, not the CLI's");
  }
  return loadCliConfig({
    file: options.config,
    home: ctx.env.HOME || ctx.env.USERPROFILE || homedir(),
    env: ctx.env,
    flags: configFlags({ set: options.set }),
    resolveSecrets,
  });
}

function loadServer(ctx: CommandContext, options: Options, resolveSecrets: boolean) {
  const { listen, roles, set } = options;
  cwdConfigHint(ctx, options.config);
  return loadServerConfig({
    configFlag: options.config,
    env: ctx.env,
    flags: configFlags({ listen, roles, set }),
    resolveSecrets,
  });
}

function load(ctx: CommandContext, options: Options, resolveSecrets: boolean): Loaded<unknown> {
  return options.cli
    ? loadCli(ctx, options, resolveSecrets)
    : loadServer(ctx, options, resolveSecrets);
}

function where(loaded: Loaded<unknown>): string {
  return loaded.file ?? "no config file (env and defaults)";
}

function packProblems(paths: readonly string[]): string[] {
  const files: { path: string; text: string }[] = [];
  const problems: string[] = [];
  for (const path of paths) {
    try {
      files.push({ path, text: readFileSync(path, "utf8") });
    } catch (err) {
      problems.push(`cannot read redaction pack ${path}: ${(err as Error).message}`);
    }
  }
  if (problems.length > 0) return problems;
  try {
    const loaded = loadPacks(files);
    compileRuleSet({
      packs: loaded.map((l) => l.pack),
      sources: Object.fromEntries(loaded.map((l) => [l.pack.id, l.source])),
      runTests: true,
    });
  } catch (err) {
    if (err instanceof RulePackError) return err.problems.map((p) => `${p.where}: ${p.message}`);
    throw err;
  }
  return [];
}

function check(ctx: CommandContext, options: Options): number {
  const errors: string[] = [];
  let file: string | undefined;
  let loaded: Loaded<unknown> | undefined;
  let report: CheckReport = { warnings: [], notices: [] };
  try {
    if (options.cli) {
      const cli = loadCli(ctx, options, true);
      loaded = cli;
      errors.push(...cliLabelProblems((cli.config as CliConfig).labels));
      const old = (cli.config as CliConfig).local;
      if (old) {
        report.notices.push(
          [
            "[local] is the old name of [serverless] (F11.1); it still works. The new table:",
            "  [serverless]",
            `  config = ${JSON.stringify(old.config)}`,
            ...(old.owner !== undefined ? [`  owner = ${JSON.stringify(old.owner)}`] : []),
          ].join("\n"),
        );
      }
    } else {
      const server = loadServer(ctx, options, true);
      loaded = server;
      report = checkServerConfig(server.config);
      serveSettings(server.config);
      errors.push(...packProblems(server.config.redaction.packs));
    }
  } catch (err) {
    if (err instanceof ConfigError) {
      errors.push(...err.issues);
      file = err.file;
    } else if (err instanceof ServeConfigError) errors.push(err.message);
    else throw err;
  }
  const warnings = [...(loaded?.warnings ?? []), ...report.warnings];
  if (options.json) {
    ctx.stdout(
      JSON.stringify(
        {
          ok: errors.length === 0,
          file: loaded?.file ?? file ?? null,
          errors,
          warnings,
          notices: report.notices,
        },
        null,
        2,
      ),
    );
    return errors.length === 0 ? EXIT.ok : EXIT.config;
  }
  for (const error of errors) ctx.stderr(`error: ${error}`);
  for (const warning of warnings) ctx.stdout(`warning: ${warning}`);
  for (const notice of report.notices) ctx.stdout(`note: ${notice}`);
  if (errors.length > 0 || !loaded) return EXIT.config;
  const counted =
    warnings.length === 0 ? "" : ` (${warnings.length} warning${warnings.length === 1 ? "" : "s"})`;
  ctx.stdout(`ok: ${where(loaded)}${counted}`);
  return 0;
}

/** With `server.runtime_config = store`, the config with the bucket's runtime layer under the
 * files (sealed secrets shown as placeholders); the files alone, with a warning, when the
 * bucket cannot be read. */
async function withRuntime(
  ctx: CommandContext,
  options: Options,
  loaded: Loaded<unknown>,
): Promise<Loaded<unknown>> {
  const config = loaded.config as ServerConfig;
  if (options.cli || config.server?.runtime_config !== "store") return loaded;
  const { listen, roles, set } = options;
  const loadWith = (runtime?: RuntimeLayer, resolveSecrets = false) =>
    loadServerConfig({
      configFlag: options.config,
      env: ctx.env,
      flags: configFlags({ listen, roles, set }),
      resolveSecrets,
      ...(runtime ? { runtime } : {}),
    });
  const cacheDir = join(tmpdir(), `seshi-config-show-${process.pid}`);
  let runtime: RuntimeConfig | undefined;
  try {
    const resolved = loadWith(undefined, true).config;
    const { store } = openStore(resolved.store.url, { ...storeOptions(resolved), env: ctx.env });
    runtime = new RuntimeConfig({
      store,
      keyring: new Keyring({}),
      load: (layer) => loadWith(layer),
      cacheDir,
      pollMs: resolved.server.config_poll,
    });
    await runtime.sync();
    return loadWith(runtime.layer(undefined, false));
  } catch (err) {
    ctx.stderr(
      `warning: the bucket's runtime config was not read (server.runtime_config = store): ${
        err instanceof ConfigError
          ? err.issues.join("; ")
          : err instanceof Error
            ? err.message
            : err
      }`,
    );
    return loaded;
  } finally {
    runtime?.close();
  }
}

async function show(ctx: CommandContext, options: Options): Promise<number> {
  let loaded: Loaded<unknown>;
  try {
    loaded = await withRuntime(ctx, options, load(ctx, options, false));
  } catch (err) {
    if (err instanceof ConfigError) {
      for (const issue of err.issues) ctx.stderr(`error: ${issue}`);
      return EXIT.config;
    }
    if (err instanceof ServeConfigError) {
      ctx.stderr(`error: ${err.message}`);
      return EXIT.config;
    }
    throw err;
  }
  const entries: ConfigEntry[] = configEntries(loaded);
  if (options.json) {
    const out = options.origin
      ? {
          file: loaded.file ?? null,
          values: entries.map(({ name, value, origin }) => ({ path: name, value, origin })),
        }
      : displayTree(loaded);
    ctx.stdout(JSON.stringify(out, null, 2));
    return 0;
  }
  if (options.origin) ctx.stdout(`# ${where(loaded)}`);
  for (const entry of entries) {
    const line = `${entry.name} = ${JSON.stringify(entry.value)}`;
    ctx.stdout(options.origin ? `${line}  # ${describeOrigin(entry.origin)}` : line);
  }
  return 0;
}

export async function run(ctx: CommandContext): Promise<number> {
  const [sub, ...rest] = ctx.argv;
  if (sub === undefined || sub === "--help" || sub === "-h") {
    (sub === undefined ? ctx.stderr : ctx.stdout)(USAGE);
    return sub === undefined ? 2 : 0;
  }
  if (sub !== "check" && sub !== "show") {
    ctx.stderr(`seshi config: unknown subcommand '${sub}'\n\n${USAGE}`);
    return 2;
  }
  let options: Options;
  try {
    ({ values: options } = parseArgs({
      args: rest,
      options: {
        cli: { type: "boolean" },
        config: { type: "string" },
        json: { type: "boolean" },
        origin: { type: "boolean" },
        listen: { type: "string" },
        roles: { type: "string" },
        set: { type: "string", multiple: true },
      },
      strict: true,
      allowPositionals: false,
    }));
    if (sub === "check" && options.origin) throw new Error("--origin is for config show");
  } catch (err) {
    ctx.stderr(`seshi config: ${err instanceof Error ? err.message : err}\n\n${USAGE}`);
    return 2;
  }
  try {
    return sub === "check" ? check(ctx, options) : await show(ctx, options);
  } catch (err) {
    if (err instanceof ServeConfigError) {
      ctx.stderr(`error: ${err.message}`);
      return EXIT.config;
    }
    throw err;
  }
}
