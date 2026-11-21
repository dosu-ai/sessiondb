import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { usernameOwner } from "@seshi/auth";
import { cliConfigSchema, SHARED_CONFIG, SHARED_PREFIX } from "@seshi/config";
import { VERSION } from "@seshi/model";
import {
  accessDeniedIn,
  ensureLayout,
  isPreconditionFailed,
  LayoutError,
  readLayout,
  type Store,
  setLayout,
} from "@seshi/store";
import { openAccount } from "../account/account";
import { writeServerlessConfig } from "../account/cli-file";
import { EXIT } from "../cli/exit";
import { failWith, Refused } from "../cli/failures";
import { emit, helpOrUsageError, takeJson } from "../cli/output";
import { type BucketKey, bucketKeyFromEnv, saveBucketKey } from "../serverless/keys";
import { openServerlessStore, refusalOf, runStorageTest, storageRefusal } from "../serverless/open";
import { expandHome, homeFor } from "../serverless/settings";
import type { CommandContext } from "./index";

const USAGE = [
  "usage: seshi init --serverless --url <s3://|r2://|az://|gs://|file://…> [--owner <id>]",
  "                  [--key-from-env] [--admin] [--region <r>] [--endpoint <url>]",
  "                  [--account-id <id>] [--account-name <name>] [--json]",
  "",
  "Set this machine up to write a shared bucket directly, with no server (F11). To use a seshi",
  "server instead: seshi login --server <url>.",
].join("\n");

/** What `--admin` writes when the bucket has no shared settings yet (F11.6). */
export const STARTER_CONFIG = `# Shared settings for every laptop that writes this bucket (seshi serverless mode).
# Any seshi.toml key may go here; [store], [[sources]], [otlp], [auth], [server] and [worker]
# are ignored by laptops. Secrets only as references ({ env = "NAME" }), never as values.
# Change with: seshi admin config pull, edit, seshi admin config push.

default_visibility = "org"

[search]
enabled = true

[review]
# true: a laptop without a review key keeps sessions until one is set.
required = false
`;

interface Values {
  serverless?: boolean;
  url?: string;
  owner?: string;
  "key-from-env"?: boolean;
  admin?: boolean;
  region?: string;
  endpoint?: string;
  "account-id"?: string;
  "account-name"?: string;
}

const encoder = new TextEncoder();

/** Where a bucket's store finds credentials when no key is stored for it. */
function keyFallback(url: string): string {
  if (url.startsWith("az://")) {
    return "the AZURE_STORAGE_* variables in the environment are used, else workload identity";
  }
  if (url.startsWith("gs://")) {
    return "Application Default Credentials are used (GOOGLE_APPLICATION_CREDENTIALS, gcloud's application-default login, else the metadata server), or none with STORAGE_EMULATOR_HOST";
  }
  return "the AWS_* / S3_* / R2_* variables in the environment are used";
}

async function askKey(ctx: CommandContext, url: string): Promise<BucketKey | undefined> {
  if (url.startsWith("file://")) return undefined;
  if (!ctx.terminal || !ctx.tty?.stdin) return undefined;
  const terminal = await ctx.terminal();
  if (url.startsWith("gs://")) {
    const path = (
      await terminal.ask("Service account key file (empty: use Application Default Credentials): ")
    ).trim();
    if (!path) return undefined;
    try {
      return { service_account_key: readFileSync(expandHome(path, homeFor(ctx.env)), "utf8") };
    } catch {
      throw new Refused(EXIT.usage, "usage", `cannot read the service account key file ${path}`);
    }
  }
  if (url.startsWith("az://")) {
    const given = (
      await terminal.ask("Storage account key or SAS token (empty: use the environment): ", {
        hidden: true,
      })
    ).trim();
    if (!given) return undefined;
    // A SAS token is a query string with a signature; an account key is base64.
    return /(^|[?&])sig=/.test(given) ? { sas_token: given } : { account_key: given };
  }
  const id = (await terminal.ask("Bucket access key id (empty: use the environment): ")).trim();
  if (!id) return undefined;
  const secret = (await terminal.ask("Secret access key: ", { hidden: true })).trim();
  if (!secret) throw new Refused(EXIT.usage, "usage", "no secret access key given");
  return { access_key_id: id, secret_access_key: secret };
}

async function starterConfig(store: Store): Promise<boolean> {
  const listed = await store.list(SHARED_PREFIX, { limit: 1 });
  if (listed.keys.length > 0) return false;
  try {
    await store.put(`${SHARED_PREFIX}${SHARED_CONFIG}`, encoder.encode(STARTER_CONFIG), {
      contentType: "application/toml",
      ifNoneMatch: "*",
    });
    return true;
  } catch (err) {
    if (isPreconditionFailed(err)) return false;
    throw err;
  }
}

export async function run(ctx: CommandContext): Promise<number> {
  const { json, rest } = takeJson(ctx.argv);
  let values: Values;
  try {
    ({ values } = parseArgs({
      args: rest,
      options: {
        serverless: { type: "boolean" },
        url: { type: "string" },
        owner: { type: "string" },
        "key-from-env": { type: "boolean" },
        admin: { type: "boolean" },
        region: { type: "string" },
        endpoint: { type: "string" },
        "account-id": { type: "string" },
        "account-name": { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    return helpOrUsageError(ctx, json, (err as Error).message, USAGE);
  }
  if (!values.serverless) {
    return helpOrUsageError(
      ctx,
      json,
      "init sets up serverless mode: seshi init --serverless --url <bucket> (for a server: seshi login --server <url>)",
      USAGE,
    );
  }
  if (values.url === undefined) return helpOrUsageError(ctx, json, "--url is required", USAGE);
  const url = values.url.replace(/\/+$/, "");
  if (!/^(s3|r2|az|gs|file):\/\//.test(url)) {
    return helpOrUsageError(ctx, json, "--url is s3://, r2://, az://, gs:// or file://", USAGE);
  }
  try {
    const account = openAccount(ctx);
    const named = values.owner ?? account.cli.user ?? ctx.env.USER ?? ctx.env.USERNAME;
    const owner = named !== undefined ? usernameOwner(named) : undefined;
    if (owner === undefined) {
      return helpOrUsageError(ctx, json, "name the owner: --owner <id>", USAGE);
    }
    const serverless = {
      url,
      owner,
      ...(values.region ? { region: values.region } : {}),
      ...(values.endpoint ? { endpoint: values.endpoint } : {}),
      ...(values["account-id"] ? { account_id: values["account-id"] } : {}),
      ...(values["account-name"] ? { account_name: values["account-name"] } : {}),
    };
    const cli = cliConfigSchema.parse({ serverless });

    let key: BucketKey | undefined;
    if (values["key-from-env"]) {
      try {
        key = bucketKeyFromEnv(ctx.env, url, values["account-name"]);
      } catch {
        // Only reading the gs:// key file GOOGLE_APPLICATION_CREDENTIALS names can fail here.
        return helpOrUsageError(
          ctx,
          json,
          `--key-from-env: cannot read the key file GOOGLE_APPLICATION_CREDENTIALS names (${ctx.env.GOOGLE_APPLICATION_CREDENTIALS})`,
          USAGE,
        );
      }
    } else {
      key = await askKey(ctx, url);
    }
    if (values["key-from-env"] && !key) {
      return helpOrUsageError(
        ctx,
        json,
        url.startsWith("az://")
          ? "--key-from-env: no AZURE_STORAGE_KEY, AZURE_STORAGE_SAS_TOKEN or AZURE_STORAGE_CONNECTION_STRING key in the environment"
          : url.startsWith("gs://")
            ? "--key-from-env: no GOOGLE_APPLICATION_CREDENTIALS in the environment (without a key, gs:// uses Application Default Credentials: leave out --key-from-env)"
            : "--key-from-env: no AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (or S3_*, R2_*) in the environment",
        USAGE,
      );
    }
    if (key) await saveBucketKey(account.secrets, url, key);

    const { store, paths } = await openServerlessStore({
      cli,
      env: ctx.env,
      home: account.home,
      secrets: account.secrets,
    });
    const storage = await runStorageTest(store, owner, paths).catch((err) => {
      throw refusalOf(err, owner);
    });
    if (!storage.conditionalWrites) throw storageRefusal(url, storage);

    const by = `seshi/${VERSION}`;
    let marker = await readLayout(store).catch((err) => {
      throw refusalOf(err, owner);
    });
    let created = false;
    if (marker === null) {
      marker = await ensureLayout(store, { createdBy: by, mode: "serverless" }).catch((err) => {
        throw refusalOf(err, owner);
      });
      created = true;
    } else if (marker.mode === undefined && values.admin) {
      marker = await setLayout(store, { mode: "serverless" }, { by }).catch((err) => {
        throw refusalOf(err, owner);
      });
    }
    const pushed = values.admin
      ? await starterConfig(store).catch((err) => {
          throw refusalOf(err, owner);
        })
      : false;

    const sharedSearch = await sharedSearchEnabled(store);
    const readOwn = await readsOnlyItsFolder(store);
    const written = writeServerlessConfig(
      account.cliFile,
      serverless,
      { enabled: sharedSearch ?? true, scope: readOwn ? "mine" : account.cli.search.scope },
      ctx.env,
    );

    const warnings: string[] = [];
    if (marker.mode === "server") {
      warnings.push(
        `${url} is in server mode: laptops should upload through its server. To switch it: seshi admin mode serverless`,
      );
    }
    if (readOwn) {
      warnings.push(
        'this key reads only its own folder: search is set to scope = "mine" (your sessions)',
      );
    }
    if (!storage.conditionalDelete) {
      warnings.push(`${storage.missing}: the daemon will not sweep this bucket`);
    }
    if (written.droppedServer) {
      warnings.push(
        `the CLI config named the server ${written.droppedServer}; this machine now writes the bucket instead`,
      );
    }
    if (!key && !url.startsWith("file://")) {
      warnings.push(`no bucket key stored: ${keyFallback(url)}`);
    }
    const document = {
      url,
      owner,
      marker: { created, schema: marker.schema, mode: marker.mode ?? null },
      key_stored_in: key ? account.secrets.kind : null,
      storage_test: storage,
      shared_config_written: pushed,
      cli_config: account.cliFile,
      warnings,
    };
    emit(ctx, json, document, () => [
      `This machine now writes ${url} directly, as ${owner}.`,
      `  marker        ${created ? "created" : "found"} (${marker.schema}, mode ${marker.mode ?? "not set"})`,
      `  storage test  conditional uploads ok; conditional deletes ${storage.conditionalDelete ? "ok" : "not supported"}`,
      `  bucket key    ${key ? `in the ${account.secrets.kind}` : url.startsWith("file://") ? "none (a folder)" : "from the environment"}`,
      ...(values.admin
        ? [`  shared config ${pushed ? `wrote ${SHARED_PREFIX}${SHARED_CONFIG}` : "already there"}`]
        : []),
      `  CLI config    ${account.cliFile}`,
      ...warnings.map((w) => `warning: ${w}`),
      "",
      "Next: seshi capture install, then check everything with: seshi doctor",
    ]);
    return EXIT.ok;
  } catch (err) {
    if (err instanceof LayoutError)
      return failWith(ctx, json, new Refused(EXIT.config, "config", err.message));
    return failWith(ctx, json, err);
  }
}

/** Whether the key is refused a listing of every owner's folder: a key limited to its own
 * folder (F11.5), whose search can only cover its own sessions. */
async function readsOnlyItsFolder(store: Store): Promise<boolean> {
  try {
    await store.list("owners/", { limit: 1 });
    return false;
  } catch (err) {
    if (accessDeniedIn(err)) return true;
    throw err;
  }
}

async function sharedSearchEnabled(store: Store): Promise<boolean | undefined> {
  try {
    const object = await store.get(`${SHARED_PREFIX}${SHARED_CONFIG}`);
    if (!object) return undefined;
    const tree = Bun.TOML.parse(new TextDecoder().decode(object.body)) as {
      search?: { enabled?: unknown };
    };
    return typeof tree.search?.enabled === "boolean" ? tree.search.enabled : undefined;
  } catch {
    return undefined;
  }
}
