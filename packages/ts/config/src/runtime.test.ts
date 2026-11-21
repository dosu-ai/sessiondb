import { describe, expect, it } from "vitest";
import { loadServerConfig } from "./configs";
import type { ConfigFs } from "./load";
import { describeOrigin } from "./origins";
import type { RuntimeLayer } from "./runtime";

function memFs(files: Record<string, string>): ConfigFs {
  return {
    readFile(path) {
      const text = files[path];
      if (text === undefined) throw new Error(`ENOENT: ${path}`);
      return text;
    },
    mode: (path) => (files[path] === undefined ? undefined : 0o100600),
    list: (dir) =>
      Object.keys(files)
        .filter((p) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes("/"))
        .map((p) => p.slice(dir.length + 1)),
  };
}

const FILE = "/etc/seshi/seshi.toml";
const DOC = "s3://acme/seshi/config/seshi.toml";

function load(main: string, runtime: RuntimeLayer, extra: Record<string, string> = {}) {
  return loadServerConfig({
    configFlag: FILE,
    fs: memFs({ [FILE]: main, ...extra }),
    runtime,
  });
}

const MAIN = `default_visibility = "owner"
[store]
url = "s3://acme/seshi"
[capture]
exclude = ["acme/payroll"]
[[sources]]
id = "adx-ingest"
type = "otlp"
`;

describe("the bucket's runtime config under the files", () => {
  it("lets the files win a setting, adds to lists, and appends stored sources", () => {
    const loaded = load(MAIN, {
      doc: {
        path: DOC,
        tree: {
          default_visibility: "org",
          filter: { min_chars: 99 },
          capture: { exclude: ["acme/hr"], redact_tool_calls: ["acme/infra"] },
          redaction: { packs: ["/cache/config/packs/org.json"] },
        },
      },
      sources: [
        {
          origin: "s3://acme/seshi/runtime/sources/cursor-a.json",
          source: { id: "cursor-a", type: "cursor-cloud", api_key: "k" },
        },
      ],
    });
    const { config } = loaded;
    expect(config.default_visibility).toBe("owner");
    expect(config.filter.min_chars).toBe(99);
    expect(config.capture.exclude).toEqual(["acme/payroll", "acme/hr"]);
    expect(config.capture.redact_tool_calls).toEqual(["acme/infra"]);
    expect(config.redaction.packs).toEqual(["/cache/config/packs/org.json"]);
    expect(config.sources.map((s) => s.id)).toEqual(["adx-ingest", "cursor-a"]);
    expect(describeOrigin(loaded.origins.get(["filter", "min_chars"]))).toBe(`file ${DOC}`);
    expect(describeOrigin(loaded.origins.get(["default_visibility"]))).toBe(`file ${FILE}`);
    expect(describeOrigin(loaded.origins.get(["capture", "exclude", 1]))).toBe(`file ${DOC}`);
    expect(describeOrigin(loaded.origins.get(["sources", 1, "type"]))).toBe(
      "file s3://acme/seshi/runtime/sources/cursor-a.json",
    );
  });

  it("keeps a file's source over a stored one with its id, and says so", () => {
    const loaded = load(MAIN, {
      sources: [
        {
          origin: "s3://acme/seshi/runtime/sources/adx-ingest.json",
          source: { id: "adx-ingest", type: "otlp", enabled: false },
        },
      ],
    });
    expect(loaded.config.sources).toHaveLength(1);
    expect(loaded.config.sources[0]?.enabled).toBe(true);
    expect(loaded.warnings.join("\n")).toMatch(/'adx-ingest' is also in a config file/);
  });

  it("does not take the process's own sections from the bucket", () => {
    const loaded = load(MAIN, {
      doc: { path: DOC, tree: { search: { enabled: false }, auth: { admins: ["x@acme.dev"] } } },
      sources: [],
    });
    expect(loaded.config.search.enabled).toBe(true);
    expect(loaded.config.auth.admins).toEqual([]);
    expect(loaded.warnings.join("\n")).toMatch(/\[search\] is not read from the bucket/);
  });

  it("puts env and flags above the bucket", () => {
    const loaded = loadServerConfig({
      configFlag: FILE,
      fs: memFs({ [FILE]: MAIN }),
      env: { SESHI_FILTER__MIN_CHARS: "5" },
      runtime: { doc: { path: DOC, tree: { filter: { min_chars: 99 } } }, sources: [] },
    });
    expect(loaded.config.filter.min_chars).toBe(5);
  });
});
