import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ConfigFs, Keyring, loadServerConfig, type RuntimeLayer } from "@seshi/config";
import { openStore } from "@seshi/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RuntimeChangeError, RuntimeConfig } from "./runtime";

const K1 = "k1-0123456789abcdef0123456789abcdef";
const K2 = "k2-0123456789abcdef0123456789abcdef";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seshi-runtime-unit-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function runtime(keyring: Keyring, main = "", env: Record<string, string> = {}) {
  const file = join(dir, "seshi.toml");
  const fs: ConfigFs = {
    readFile: (path) => {
      if (path !== file) throw new Error(`ENOENT ${path}`);
      return `[store]\nurl = "file://${join(dir, "bucket")}"\n${main}`;
    },
    mode: (path) => (path === file ? 0o100600 : undefined),
    list: () => [],
  };
  const { store } = openStore(`file://${join(dir, "bucket")}`);
  return new RuntimeConfig({
    store,
    keyring,
    load: (layer: RuntimeLayer | undefined) =>
      loadServerConfig({ configFlag: file, fs, env, ...(layer ? { runtime: layer } : {}) }),
    cacheDir: join(dir, "cache"),
    pollMs: 1_000,
  });
}

const ok = async () => [];

describe("RuntimeConfig", () => {
  it("reseals with a new key, and leaves out a source whose key is gone", async () => {
    const one = runtime(new Keyring({ k1: K1 }));
    await one.putSource("cursor-a", { type: "cursor-cloud", api_key: "secret-a" }, {}, ok);
    await one.sync();
    expect(one.compose().config.sources.map((s) => s.id)).toEqual(["cursor-a"]);

    const both = runtime(new Keyring({ k1: K1, k2: K2 }, "k2"));
    expect(await both.reseal()).toEqual({ resealed: ["cursor-a"], changed: [], current: [] });
    expect(await both.reseal()).toEqual({ resealed: [], changed: [], current: ["cursor-a"] });
    const stored = readFileSync(join(dir, "bucket", "runtime", "sources", "cursor-a.json"), "utf8");
    expect(stored).toContain('"v1.k2.');
    expect(stored).not.toContain("secret-a");

    const old = runtime(new Keyring({ k1: K1 }));
    await old.sync();
    const loaded = old.compose();
    expect(loaded.config.sources).toEqual([]);
    expect(loaded.warnings.join("\n")).toMatch(/cursor-a.json: left out: .*key 'k2'/);
  });

  it("refuses a file's source, a file secret, and a deletion a review policy needs", async () => {
    const rt = runtime(new Keyring({ k1: K1 }), '[[sources]]\nid = "adx-ingest"\ntype = "otlp"\n');
    await expect(rt.putSource("adx-ingest", { type: "otlp" }, {}, ok)).rejects.toMatchObject({
      code: "file_owned",
    });
    await expect(
      rt.putSource("dd", { type: "datadog", api_key: { file: "/k" }, app_key: "x" }, {}, ok),
    ).rejects.toBeInstanceOf(RuntimeChangeError);
    await rt.putSource("dd", { type: "datadog", api_key: "a", app_key: "b" }, {}, ok);
    await rt.patchDoc(
      {
        set: {
          "review.policies": [
            {
              id: "p",
              sources: ["dd"],
              decision: {
                provider: "openai-compatible",
                model: "m",
                base_url: "http://127.0.0.1:9",
              },
            },
          ],
        },
      },
      {},
      ok,
    );
    await expect(rt.deleteSource("dd", {})).rejects.toMatchObject({ code: "in_use" });
  });

  it("takes a stored source's secrets only as values, never the server's env", async () => {
    const rt = runtime(new Keyring({ k1: K1 }));
    // An admin token must not get the server to send its own env (the sealing keys among it)
    // to an endpoint the caller picks.
    const leak = {
      type: "datadog",
      api_url: "http://127.0.0.1:9",
      api_key: { env: "SEAL_K1" },
      app_key: "b",
    };
    await expect(rt.putSource("dd", leak, {}, ok)).rejects.toMatchObject({
      code: "invalid",
      problems: [expect.stringMatching(/^api_key: .*\{ env \}/)],
    });
    // One written to the bucket some other way is left out, not run.
    mkdirSync(join(dir, "bucket", "runtime", "sources"), { recursive: true });
    writeFileSync(
      join(dir, "bucket", "runtime", "sources", "dd.json"),
      JSON.stringify({
        schema: "seshi/runtime-source/1",
        source: leak,
        secrets: {},
        updated_at: new Date(0).toISOString(),
      }),
    );
    await rt.sync();
    const loaded = rt.compose();
    expect(loaded.config.sources).toEqual([]);
    expect(loaded.warnings.join("\n")).toMatch(/dd.json: left out: api_key: not sealed/);
    // That one left out blocks no other write, and it can still be deleted.
    await rt.putSource("cursor-b", { type: "cursor-cloud", api_key: "secret-b" }, {}, ok);
    await rt.deleteSource("dd", {});
    expect(rt.compose().config.sources.map((s) => s.id)).toEqual(["cursor-b"]);
  });

  it("refuses to delete a file the doc needs, however it spells it", async () => {
    const rt = runtime(new Keyring({ k1: K1 }));
    await rt.putFile(
      "packs/org.json",
      new TextEncoder().encode('{"patterns": ["X-[0-9]{3}"]}'),
      {},
      ok,
    );
    await rt.patchDoc({ set: { "redaction.packs": ["./packs/org.json"] } }, {}, ok);
    const check = async (config: { redaction: { packs: readonly string[] } }) => {
      for (const pack of config.redaction.packs) {
        if (!(await Bun.file(pack).exists())) return [`cannot read redaction pack ${pack}`];
      }
      return [];
    };
    await expect(rt.deleteFile("packs/org.json", {}, check)).rejects.toMatchObject({
      code: "in_use",
    });
    await expect(rt.deleteFile("packs/none.json", {}, check)).rejects.toMatchObject({
      code: "no_such_file",
    });
  });

  it("locks a list the server's env sets whole", () => {
    const rt = runtime(new Keyring({ k1: K1 }), "", { SESHI_CAPTURE__EXCLUDE: '["acme/payroll"]' });
    expect(rt.locked()).toContain("capture.exclude");
    expect(runtime(new Keyring({ k1: K1 }), '[capture]\nexclude = ["a/b"]\n').locked()).toEqual([]);
  });
});
