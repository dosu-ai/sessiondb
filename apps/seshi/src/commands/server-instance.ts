import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfigError,
  findServerConfig,
  Keyring,
  type Loaded,
  loadServerConfig,
  type RuntimeLayer,
  SealingError,
  type ServerConfig,
} from "@seshi/config";
import {
  buildInstance,
  type Instance,
  InstanceError,
  type Logger,
  type Role,
  RuntimeConfig,
  storeOptions,
} from "@seshi/instance";
import { openStore } from "@seshi/store";
import { EXIT } from "../cli/exit";
import { ServeConfigError } from "../cli/failures";
import { fail } from "../cli/output";
import { buildFormats } from "../integrations";
import type { CommandContext } from "./index";
import { configFlags, type ServeSettings, serveSettings } from "./serve-settings";

export const SERVER_OPTIONS = {
  config: { type: "string" },
  set: { type: "string", multiple: true },
} as const;

export interface ServerArgs {
  config?: string;
  set?: string[];
  listen?: string;
  roles?: string;
}

export interface OpenServerOptions {
  roles?: readonly Role[];
  probe?: readonly string[];
  log?: Logger;
  claimUnmarkedBucket?: boolean;
  trustCwdConfig?: boolean;
}

export function cwdConfigHint(
  ctx: CommandContext,
  configFlag: string | undefined,
  cwd: string = process.cwd(),
): void {
  const { skipped } = findServerConfig({ flag: configFlag, env: ctx.env, cwd, exists: existsSync });
  if (skipped !== undefined) ctx.stderr(SKIPPED_CONFIG_HINT);
}

export const SKIPPED_CONFIG_HINT =
  "seshi: hint: ./seshi.toml here was not read (only seshi serve reads it unasked); pass --config ./seshi.toml to use it";

export interface OpenedServer {
  instance: Instance;
  loaded: Loaded<ServerConfig>;
  settings: ServeSettings;
}

export async function openServer(
  ctx: CommandContext,
  args: ServerArgs,
  options: OpenServerOptions = {},
): Promise<OpenedServer> {
  if (options.trustCwdConfig !== true) cwdConfigHint(ctx, args.config);
  const load = (runtime?: RuntimeLayer) =>
    loadServerConfig({
      configFlag: args.config,
      env: ctx.env,
      flags: configFlags(args),
      ...(options.trustCwdConfig === true ? { trustCwdConfig: true } : {}),
      ...(runtime ? { runtime } : {}),
    });
  let loaded = load();
  const opened = await openRuntime(loaded.config, load, ctx.env, options.log);
  if (opened) loaded = opened.loaded;
  for (const warning of loaded.warnings) ctx.stderr(`seshi: warning: ${warning}`);
  const settings = serveSettings(loaded.config);
  const integrations = await ctx.integrations();
  const runtime = opened?.runtime;
  const instance = await buildInstance(loaded.config, {
    formats: buildFormats(integrations),
    integrations,
    env: ctx.env,
    ...(options.roles ? { roles: options.roles } : {}),
    ...(options.probe ? { probe: options.probe } : {}),
    ...(options.log ? { log: options.log } : {}),
    ...(options.claimUnmarkedBucket === false ? { initialize: false } : {}),
    ...(opened ? { store: opened.store, runtime: opened.runtime } : {}),
    // A reload reads the same file, drop-ins, env and flags again (SIGHUP, POST
    // /v1/admin/reload), and the bucket's runtime config with them. A server started from
    // defaults alone has nothing to read again.
    ...(runtime
      ? {
          loadConfig: async () => {
            await runtime.sync();
            return runtime.compose().config;
          },
        }
      : loaded.file !== undefined
        ? { loadConfig: () => load().config }
        : {}),
  });
  return { instance, loaded, settings };
}

/** With `server.runtime_config = store`: open the bucket, read its runtime config, and load
 * the config again with it under the files. The server does not start without it: what it
 * would run otherwise (the files alone) may be missing the org's rules. */
async function openRuntime(
  fileOnly: ServerConfig,
  load: (runtime?: RuntimeLayer) => Loaded<ServerConfig>,
  env: Record<string, string | undefined>,
  log: Logger | undefined,
): Promise<
  | {
      runtime: RuntimeConfig;
      loaded: Loaded<ServerConfig>;
      store: ReturnType<typeof openStore>;
    }
  | undefined
> {
  if (fileOnly.server.runtime_config !== "store") return undefined;
  let keyring: Keyring;
  try {
    keyring = Keyring.fromConfig(fileOnly.secrets);
  } catch (err) {
    if (err instanceof SealingError) throw new ServeConfigError(err.message);
    throw err;
  }
  let store: ReturnType<typeof openStore>;
  try {
    store = openStore(fileOnly.store.url, { ...storeOptions(fileOnly), env });
  } catch (err) {
    throw new InstanceError(err instanceof Error ? err.message : String(err), { cause: err });
  }
  const runtime = new RuntimeConfig({
    store: store.store,
    keyring,
    load,
    cacheDir: join(tmpdir(), `seshi-runtime-${process.pid}-${Date.now().toString(36)}`),
    pollMs: fileOnly.server.config_poll,
    ...(log ? { log } : {}),
  });
  try {
    await runtime.sync();
  } catch (err) {
    runtime.close();
    throw new InstanceError(
      `cannot read the runtime config in ${fileOnly.store.url} (server.runtime_config = store): ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err },
    );
  }
  return { runtime, loaded: runtime.compose(), store };
}

export function serverFailure(
  ctx: CommandContext,
  json: boolean,
  err: unknown,
): number | undefined {
  if (err instanceof ConfigError) {
    if (json) return fail(ctx, true, EXIT.config, "config", err.issues.join("\n"));
    for (const issue of err.issues) ctx.stderr(`seshi: ${issue}`);
    return EXIT.config;
  }
  if (err instanceof ServeConfigError || err instanceof InstanceError) {
    return fail(ctx, json, EXIT.config, "config", err.message);
  }
  return undefined;
}
