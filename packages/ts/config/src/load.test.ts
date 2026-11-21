import { describe, expect, it } from "vitest";
import { cliConfigSchema } from "./cli";
import { loadCliConfig, loadServerConfig } from "./configs";
import { isSettingName } from "./layers";
import { ConfigError, type ConfigFs, loadConfig, shapeOf } from "./load";
import { describeOrigin } from "./origins";
import type { Secret } from "./secret";
import { serverConfigSchema } from "./server/index";

/** Files in memory, with their permission bits. */
function memFs(files: Record<string, string | { text: string; mode: number }>): ConfigFs {
  const entry = (path: string) => {
    const file = files[path];
    if (file === undefined) return undefined;
    return typeof file === "string" ? { text: file, mode: 0o100600 } : file;
  };
  return {
    readFile(path) {
      const file = entry(path);
      if (!file) throw new Error(`ENOENT: no such file or directory, open '${path}'`);
      return file.text;
    },
    mode: (path) => entry(path)?.mode,
  };
}

function issues(run: () => unknown): string[] {
  try {
    run();
  } catch (err) {
    if (err instanceof ConfigError) return err.issues;
    throw err;
  }
  throw new Error("expected a ConfigError");
}

const STORE = { SESHI_STORE__URL: "file:///data" };

function server(
  files: Record<string, string | { text: string; mode: number }>,
  options: Parameters<typeof loadServerConfig>[0] = {},
) {
  // As `seshi serve` loads it: the only command that reads ./seshi.toml unasked.
  return loadServerConfig({
    cwd: "/work",
    systemPath: "/etc/seshi/seshi.toml",
    trustCwdConfig: true,
    fs: memFs(files),
    ...options,
  });
}

describe("precedence (F1.1)", () => {
  const file = `[server]\nlisten = ":1"\nroles = ["api"]\n[store]\nurl = "s3://from-file/p"\n[filter]\nmin_chars = 10\n`;

  it("is flags, then env, then the file, then defaults, and each value says which", () => {
    const loaded = server(
      { "/work/seshi.toml": file },
      {
        env: { SESHI_SERVER__LISTEN: ":2", SESHI_STORE__URL: "s3://from-env/p" },
        flags: [{ name: "--listen", path: "server.listen", value: ":3" }],
      },
    );
    expect(loaded.config.server.listen).toBe(":3");
    expect(loaded.config.store.url).toBe("s3://from-env/p");
    expect(loaded.config.filter.min_chars).toBe(10);
    expect(loaded.config.filter.require_user).toBe(true);
    const origin = (path: (string | number)[]) => describeOrigin(loaded.origins.get(path));
    expect(origin(["server", "listen"])).toBe("flag --listen");
    expect(origin(["store", "url"])).toBe("env SESHI_STORE__URL");
    expect(origin(["filter", "min_chars"])).toBe("file /work/seshi.toml");
    expect(origin(["server", "roles"])).toBe("file /work/seshi.toml");
    expect(origin(["filter", "require_user"])).toBe("default");
  });

  it("defaults every section the file leaves out, with today's values", () => {
    const { config } = server({}, { env: STORE });
    expect(config.server).toEqual({
      listen: ":7200",
      roles: ["api", "worker"],
      watch_config: false,
      runtime_config: "file",
      config_poll: 10_000,
    });
    expect(config.secrets).toEqual({ keys: {} });
    expect(config.store).toEqual({ url: "file:///data" });
    expect(config.auth).toEqual({
      tokens: {},
      org_key: { enabled: true },
      admins: [],
      owner_aliases: {},
      session_keys: {},
    });
    expect(config.default_visibility).toBe("org");
    expect(config.filter).toEqual({
      enabled: true,
      min_chars: 2000,
      require_user: true,
      require_reply: true,
    });
    expect(config.limits).toEqual({
      max_records: 50_000,
      max_records_bytes: 32 * 1024 * 1024,
      max_upload_bytes: 256 * 1024 * 1024,
      max_otlp_bytes: 64 * 1024 * 1024,
      max_otlp_inflated_bytes: 256 * 1024 * 1024,
    });
    expect(config.records).toEqual({
      dropped_retention: 30 * 86_400_000,
      failed_retention: 30 * 86_400_000,
      health_retention: 90 * 86_400_000,
    });
    expect(config.redaction).toEqual({ packs: [] });
    expect(config.review).toEqual({ policies: [], required: false });
    expect(config.sources).toEqual([]);
    expect(config.search).toEqual({
      enabled: true,
      backend: "sqlite",
      interval: 15_000,
      events: ["user", "assistant", "tool_call"],
    });
    expect(config.worker).toEqual({ heartbeat_interval: 60_000, assembly_interval: 30_000 });
    expect(config.capture).toEqual({ allow_retract: true, exclude: [], redact_tool_calls: [] });
  });
});

describe("which file (F1.1)", () => {
  const at = (path: string) => ({ [path]: `[store]\nurl = "file://${path}"\n` });

  it("takes --config first, then SESHI_CONFIG, then ./seshi.toml, then /etc/seshi/seshi.toml", () => {
    const files = {
      ...at("/flag.toml"),
      ...at("/env.toml"),
      ...at("/work/seshi.toml"),
      ...at("/etc/seshi/seshi.toml"),
    };
    expect(
      server(files, { configFlag: "/flag.toml", env: { SESHI_CONFIG: "/env.toml" } }).file,
    ).toBe("/flag.toml");
    expect(server(files, { env: { SESHI_CONFIG: "/env.toml" } }).file).toBe("/env.toml");
    expect(server(files).file).toBe("/work/seshi.toml");
    const { "/work/seshi.toml": _, ...noLocal } = files;
    expect(server(noLocal).file).toBe("/etc/seshi/seshi.toml");
    // Any other command never reads ./seshi.toml unasked: the folder may be someone's checkout.
    expect(server(files, { trustCwdConfig: false }).file).toBe("/etc/seshi/seshi.toml");
    expect(
      server(at("/work/seshi.toml"), { trustCwdConfig: false, env: STORE }).file,
    ).toBeUndefined();
  });

  it("resolves a relative --config against the working directory", () => {
    expect(server(at("/work/conf/s.toml"), { configFlag: "conf/s.toml" }).file).toBe(
      "/work/conf/s.toml",
    );
  });

  it("runs on env and defaults with no file", () => {
    const loaded = server({}, { env: STORE });
    expect(loaded.file).toBeUndefined();
    expect(loaded.config.store.url).toBe("file:///data");
  });

  it("refuses a named file that is missing", () => {
    expect(issues(() => server({}, { configFlag: "/nope.toml" }))[0]).toContain(
      "cannot read /nope.toml",
    );
    expect(issues(() => server({}, { env: { SESHI_CONFIG: "/nope.toml" } }))[0]).toContain(
      "cannot read /nope.toml",
    );
  });

  it("does not take SESHI_CONFIG as a setting", () => {
    expect(server(at("/c.toml"), { env: { SESHI_CONFIG: "/c.toml" } }).config.store.url).toBe(
      "file:///c.toml",
    );
  });

  it("says where TOML is broken", () => {
    expect(issues(() => server({ "/work/seshi.toml": "[store\nurl=" }))[0]).toMatch(
      /^\/work\/seshi\.toml: not valid TOML/,
    );
  });
});

describe("env names (F1.2)", () => {
  it("map SESHI_ + the upper-cased path with __ between levels", () => {
    const { config } = server(
      {},
      {
        env: {
          ...STORE,
          SESHI_AUTH__OIDC__ISSUER: "https://idp.example.com",
          SESHI_AUTH__OIDC__CLIENT_ID: "seshi-cli",
          SESHI_AUTH__SESSION_KEYS__K1: "k".repeat(32),
          SESHI_SERVER__PUBLIC_URL: "https://seshi.example.com",
        },
      },
    );
    expect(config.auth.oidc).toEqual({
      issuer: "https://idp.example.com",
      client_id: "seshi-cli",
      owner_claim: "sub",
      groups_claim: "groups",
    });
    expect(config.server.public_url).toBe("https://seshi.example.com");
  });

  it("read numbers, booleans, durations, sizes and comma-separated lists", () => {
    const { config } = server(
      {},
      {
        env: {
          ...STORE,
          SESHI_FILTER__MIN_CHARS: "100",
          SESHI_FILTER__ENABLED: "FALSE",
          SESHI_RECORDS__DROPPED_RETENTION: "7d",
          SESHI_RECORDS__FAILED_RETENTION: "1000",
          SESHI_LIMITS__MAX_UPLOAD_BYTES: "1MiB",
          SESHI_AUTH__ADMINS: "a@acme.com, b@acme.com,",
          SESHI_REDACTION__PACKS: '["/x.json"]',
        },
      },
    );
    expect(config.filter).toMatchObject({ min_chars: 100, enabled: false });
    expect(config.records).toEqual({
      dropped_retention: 7 * 86_400_000,
      failed_retention: 1000,
      health_retention: 90 * 86_400_000,
    });
    expect(config.limits.max_upload_bytes).toBe(1024 * 1024);
    expect(config.auth.admins).toEqual(["a@acme.com", "b@acme.com"]);
    expect(config.redaction.packs).toEqual(["/x.json"]);
  });

  it("treat an empty value as unset", () => {
    const loaded = server(
      { "/work/seshi.toml": `[store]\nurl = "file:///f"\n` },
      { env: { SESHI_STORE__URL: "" } },
    );
    expect(loaded.config.store.url).toBe("file:///f");
  });

  it("add a map key in lower case, or match one the file has", () => {
    const loaded = server(
      {
        "/work/seshi.toml": `[store]\nurl = "file:///f"\n[auth.tokens]\n"alice.smith@acme.com" = "file-token-0123456789"\n`,
      },
      {
        env: {
          SESHI_AUTH__TOKENS__ALICE_SMITH_ACME_COM: "env-token-0123456789",
          SESHI_AUTH__TOKENS__BOB: "bob-token-0123456789",
        },
      },
    );
    const tokens = Object.fromEntries(
      Object.entries(loaded.config.auth.tokens).map(([k, v]) => [k, v.reveal()]),
    );
    expect(tokens).toEqual({
      "alice.smith@acme.com": "env-token-0123456789",
      bob: "bob-token-0123456789",
    });
    expect(describeOrigin(loaded.origins.get(["auth", "tokens", "bob"]))).toBe(
      "env SESHI_AUTH__TOKENS__BOB",
    );
  });

  it("override a field of a named source, which only the file defines", () => {
    const file = `[store]\nurl = "file:///f"\n[[sources]]\nid = "datadog-prod"\ntype = "datadog"\napi_key = "file-key"\napp_key = "app"\n`;
    const loaded = server(
      { "/work/seshi.toml": file },
      {
        env: {
          SESHI_SOURCES__DATADOG_PROD__API_KEY: "env-key",
          SESHI_SOURCES__DATADOG_PROD__LAG: "5m",
        },
      },
    );
    const source = loaded.config.sources[0];
    if (source?.type !== "datadog") throw new Error("expected a datadog source");
    expect(source.api_key.reveal()).toBe("env-key");
    expect(source.lag).toBe(300_000);
    expect(describeOrigin(loaded.origins.get(["sources", 0, "api_key"]))).toBe(
      "env SESHI_SOURCES__DATADOG_PROD__API_KEY",
    );
    expect(
      issues(() =>
        server({ "/work/seshi.toml": file }, { env: { SESHI_SOURCES__NOPE__LAG: "1m" } }),
      ),
    ).toEqual([
      "SESHI_SOURCES__NOPE__LAG: no entry with id matching 'NOPE' under sources in the config file (lists of tables are defined in the file only)",
    ]);
    expect(
      issues(() => server({ "/work/seshi.toml": file }, { env: { SESHI_SOURCES: "x" } }))[0],
    ).toContain("sources is a list of tables, defined in the config file only");
  });

  it("set a secret as a reference", () => {
    const loaded = server(
      {
        "/run/key": "from-file\n",
        "/work/seshi.toml": `[store]\nurl = "file:///f"\n[auth.session_keys]\nk1 = "literal"\n`,
      },
      { env: { SESHI_AUTH__SESSION_KEYS__K1__FILE: "/run/key" } },
    );
    const secret = loaded.config.auth.session_keys.k1 as Secret;
    expect(secret.ref).toEqual({ kind: "file", path: "/run/key" });
    expect(secret.reveal()).toBe("from-file");
  });

  it("skip a SESHI_* variable that a secret reads, from the file or from env", () => {
    const loaded = server(
      {
        "/work/seshi.toml": `[store]\nurl = "file:///f"\n[auth.tokens]\nalice = { env = "SESHI_ALICE_TOKEN" }\n`,
      },
      {
        env: {
          SESHI_ALICE_TOKEN: "alice-token-0123456789",
          SESHI_AUTH__SESSION_KEYS__K1__ENV: "SESHI_JWT_SECRET",
          SESHI_JWT_SECRET: "j".repeat(32),
        },
      },
    );
    expect(loaded.config.auth.tokens.alice?.reveal()).toBe("alice-token-0123456789");
    expect(loaded.config.auth.session_keys.k1?.reveal()).toBe("j".repeat(32));
    // Only at a secret field: `{ env = … }` elsewhere is not a reference.
    expect(
      issues(() =>
        server(
          { "/work/seshi.toml": `[store]\nurl = "file:///f"\n` },
          { env: { SESHI_ALICE_TOKEN: "x" } },
        ),
      ),
    ).toEqual(["SESHI_ALICE_TOKEN: not a setting ('ALICE_TOKEN' is not a setting here)"]);
  });

  it("fail on a name that is not a setting, or that names a table", () => {
    expect(issues(() => server({}, { env: { ...STORE, SESHI_STORE__URLL: "x" } }))).toEqual([
      "SESHI_STORE__URLL: not a setting ('URLL' is not a setting here)",
    ]);
    expect(issues(() => server({}, { env: { ...STORE, SESHI_NOPE: "x" } }))[0]).toContain(
      "SESHI_NOPE: not a setting",
    );
    expect(issues(() => server({}, { env: { ...STORE, SESHI_STORE: "x" } }))[0]).toContain(
      "store is a table; set one of its keys",
    );
    expect(issues(() => server({}, { env: { ...STORE, SESHI_STORE____URL: "x" } }))[0]).toContain(
      "not a setting (empty key)",
    );
  });

  it("skip the CLI's names while the server loads, and the server's while the CLI loads", () => {
    const env = {
      ...STORE,
      SESHI_USER: "me",
      SESHI_THEME: "dark",
      SESHI_SERVER: "https://seshi.example.com",
      SESHI_CAPTURE__ENABLED: "false",
    };
    expect(server({}, { env }).config.capture).toEqual({
      allow_retract: true,
      exclude: [],
      redact_tool_calls: [],
    });
    const cli = loadCliConfig({ env: { ...env, SESHI_SERVER__LISTEN: ":1" }, fs: memFs({}) });
    expect(cli.config).toMatchObject({
      user: "me",
      theme: "dark",
      server: "https://seshi.example.com",
      capture: { enabled: false, paths: [], remotes: [], exclude: [] },
    });
  });

  it("can be checked one by one", () => {
    const shape = shapeOf(serverConfigSchema);
    expect(isSettingName(shape, "SESHI_STORE__URL")).toBe(true);
    expect(isSettingName(shape, "SESHI_AUTH__TOKENS__ANYONE")).toBe(true);
    expect(isSettingName(shape, "SESHI_SOURCES__ANY_ID__API_KEY")).toBe(true);
    expect(isSettingName(shape, "SESHI_STORE__BUCKET")).toBe(false);
    expect(isSettingName(shape, "SESHI_USER")).toBe(false);
    expect(isSettingName(shape, "STORE__URL")).toBe(false);
  });
});

describe("flags", () => {
  it("set any path with --set, list entries by id", () => {
    const file = `[store]\nurl = "file:///f"\n[[sources]]\nid = "in"\ntype = "otlp"\n`;
    const loaded = server(
      { "/work/seshi.toml": file },
      {
        flags: [
          { name: "--set", path: "sources.in.quiet_period", value: "1m" },
          { name: "--set", path: "auth.tokens.alice", value: "alice-token-0123456789" },
        ],
      },
    );
    expect(loaded.config.sources[0]).toMatchObject({ quiet_period: 60_000 });
    expect(loaded.config.auth.tokens.alice?.reveal()).toBe("alice-token-0123456789");
    expect(
      issues(() => server({}, { flags: [{ name: "--set", path: "nope", value: "1" }] })),
    ).toEqual(["--set: not a setting ('nope' is not a setting here)"]);
  });
});

describe("the strict schema (F1.4)", () => {
  it("fails on unknown keys, every one, saying where", () => {
    const found = issues(() =>
      server({ "/work/seshi.toml": `[store]\nurl = "file:///f"\nbucket = "x"\n[nope]\na = 1\n` }),
    );
    expect(found).toEqual([
      "store.bucket: unknown key (in /work/seshi.toml)",
      "nope: unknown key (in /work/seshi.toml)",
    ]);
  });

  it("names a required value and a value of the wrong kind", () => {
    expect(issues(() => server({}))).toEqual(["store.url: required"]);
    const found = issues(() =>
      server(
        {},
        {
          env: {
            ...STORE,
            SESHI_FILTER__MIN_CHARS: "many",
            SESHI_RECORDS__DROPPED_RETENTION: "a month",
            SESHI_LIMITS__MAX_RECORDS_BYTES: "big",
          },
        },
      ),
    );
    expect(found).toContain(
      'records.dropped_retention: expected a duration such as "90s", "10m", "1h", "30d", or milliseconds (from env SESHI_RECORDS__DROPPED_RETENTION)',
    );
    expect(found).toContain(
      'limits.max_records_bytes: expected a size such as "512KiB", "32MiB", "1GiB", or bytes (from env SESHI_LIMITS__MAX_RECORDS_BYTES)',
    );
    expect(found.some((i) => i.startsWith("filter.min_chars:"))).toBe(true);
  });

  it("names a bad secret and a bad source type", () => {
    const found = issues(() =>
      server({
        "/work/seshi.toml": `[store]\nurl = "file:///f"\n[auth.tokens]\nalice = 5\n[[sources]]\nid = "x"\ntype = "kafka"\n`,
      }),
    );
    expect(found).toContain(
      'auth.tokens.alice: expected a string, { env = "NAME" } or { file = "/path" } (in /work/seshi.toml)',
    );
    expect(found).toContain(
      "sources[x].type: must be one of otlp, datadog, s3, cursor-cloud (in /work/seshi.toml)",
    );
  });
});

describe("secrets (F1.3)", () => {
  const file = `[store]\nurl = "file:///f"\n[auth.tokens]\nalice = "alice-token-0123456789"\nbob = { env = "BOB" }\n`;

  it("are resolved at load, and a missing one fails with its setting", () => {
    const loaded = server({ "/work/seshi.toml": file }, { env: { BOB: "bob-token-0123456789" } });
    expect(loaded.config.auth.tokens.bob?.reveal()).toBe("bob-token-0123456789");
    expect(issues(() => server({ "/work/seshi.toml": file }))).toEqual([
      "auth.tokens.bob: environment variable BOB is not set (in /work/seshi.toml)",
    ]);
  });

  it("can be left unresolved", () => {
    const loaded = server({ "/work/seshi.toml": file }, { resolveSecrets: false });
    expect(loaded.config.auth.tokens.bob?.resolved).toBe(false);
  });

  it("warn when the file holds a literal and group or others can read it", () => {
    const readable = server(
      { "/work/seshi.toml": { text: file, mode: 0o100644 } },
      { env: { BOB: "b" }, platform: "linux" },
    );
    expect(readable.warnings).toEqual([
      '/work/seshi.toml holds literal secrets (auth.tokens.alice) and group or others can read it: use { env = "NAME" } or { file = "/path" } references, or chmod 600 /work/seshi.toml',
    ]);
    const owner = server(
      { "/work/seshi.toml": { text: file, mode: 0o100600 } },
      { env: { BOB: "b" }, platform: "linux" },
    );
    expect(owner.warnings).toEqual([]);
    const windows = server(
      { "/work/seshi.toml": { text: file, mode: 0o100666 } },
      { env: { BOB: "b" }, platform: "win32" },
    );
    expect(windows.warnings).toEqual([]);
  });

  it("do not warn for a literal that came from env", () => {
    const loaded = server(
      { "/work/seshi.toml": { text: `[store]\nurl = "file:///f"\n`, mode: 0o100644 } },
      { env: { SESHI_AUTH__TOKENS__ALICE: "alice-token-0123456789" }, platform: "linux" },
    );
    expect(loaded.warnings).toEqual([]);
  });
});

describe("loadConfig", () => {
  it("keeps no state between loads", () => {
    const a = loadConfig(serverConfigSchema, { env: { SESHI_STORE__URL: "file:///a" } });
    const b = loadConfig(serverConfigSchema, { env: { SESHI_STORE__URL: "file:///b" } });
    expect(a.config.store.url).toBe("file:///a");
    expect(b.config.store.url).toBe("file:///b");
    expect(a.config.filter).not.toBe(b.config.filter);
  });

  it("works for any schema, the CLI's included", () => {
    const loaded = loadConfig(cliConfigSchema, {
      env: { SESHI_CAPTURE__ENABLED: "false" },
      foreign: [shapeOf(serverConfigSchema)],
    });
    expect(loaded.config.capture.enabled).toBe(false);
  });

  it("carries the file on its error", () => {
    try {
      server({ "/work/seshi.toml": "x = 1" });
    } catch (err) {
      expect((err as ConfigError).file).toBe("/work/seshi.toml");
      return;
    }
    throw new Error("expected a ConfigError");
  });
});
