/** The runtime config in the bucket (`server.runtime_config = store`, docs/config.md): two
 * `seshi serve` processes on one bucket, one changed through the admin API, the other
 * applying it within `server.config_poll`. */

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const MAIN = join(import.meta.dirname, "..", "main.ts");
const SEAL = "seal-0123456789abcdef0123456789abcdef";
const CURSOR_KEY = "key_cursor_0123456789";

let dir: string;
let file: string;
const servers: ReturnType<typeof Bun.spawn>[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seshi-runtime-"));
  file = join(dir, "seshi.toml");
});
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.kill();
    await server.exited;
  }
  rmSync(dir, { recursive: true, force: true });
});

function writeConfig(runtime: "store" | "file"): void {
  writeFileSync(
    file,
    `default_visibility = "owner"
[server]
listen = "127.0.0.1:0"
runtime_config = "${runtime}"
config_poll = "200ms"
[store]
url = "file://${join(dir, "bucket")}"
[search]
enabled = false
[secrets]
keys = { k1 = { env = "SEAL_KEY" } }
[capture]
exclude = ["acme/payroll"]
`,
    { mode: 0o600 },
  );
}

const env = () => ({ PATH: process.env.PATH ?? "", HOME: dir, SEAL_KEY: SEAL });

async function adminToken(): Promise<string> {
  const proc = Bun.spawn(
    ["bun", MAIN, "admin", "init", "--json", "--owner", "ops", "--config", file],
    { cwd: dir, env: env(), stdout: "pipe", stderr: "pipe" },
  );
  const out = await new Response(proc.stdout).text();
  expect(await proc.exited, await new Response(proc.stderr).text()).toBe(0);
  return JSON.parse(out).admin.token as string;
}

async function serve(...flags: string[]): Promise<string> {
  const proc = Bun.spawn(["bun", MAIN, "serve", "--config", file, ...flags], {
    cwd: dir,
    env: env(),
    stdout: "pipe",
    stderr: "pipe",
  });
  servers.push(proc);
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  let out = "";
  while (!/127\.0\.0\.1:(\d+)/.test(out)) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`server stopped: ${out}${await new Response(proc.stderr).text()}`);
    out += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  return `http://127.0.0.1:${(/127\.0\.0\.1:(\d+)/.exec(out) as RegExpExecArray)[1]}`;
}

function call(token: string) {
  return async (base: string, method: string, path: string, body?: unknown, headers = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return {
      status: res.status,
      etag: res.headers.get("etag"),
      body: text ? JSON.parse(text) : {},
    };
  };
}

async function eventually<T>(read: () => Promise<T>, ok: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 8_000;
  for (;;) {
    const value = await read();
    if (ok(value) || Date.now() > deadline) return value;
    await Bun.sleep(100);
  }
}

describe("the runtime config in the bucket", () => {
  it("is written on one instance, applied on the other, and sealed at rest", async () => {
    writeConfig("store");
    const token = await adminToken();
    const api = call(token);
    const a = await serve();
    const b = await serve("--roles", "api");

    // A member's Cursor key, stored through A: sealed, and never shown again.
    const put = await api(a, "PUT", "/v1/admin/sources/cursor-ann", {
      type: "cursor-cloud",
      enabled: false,
      api_key: CURSOR_KEY,
      labels: { "dosu.member": "ann" },
    });
    expect(put.status, JSON.stringify(put.body)).toBe(201);
    expect(put.body.source.api_key).toMatchObject({ set: true, key_id: "k1" });
    expect(JSON.stringify(put.body)).not.toContain(CURSOR_KEY);
    const stored = readFileSync(
      join(dir, "bucket", "runtime", "sources", "cursor-ann.json"),
      "utf8",
    );
    expect(stored).not.toContain(CURSOR_KEY);
    expect(stored).toContain('"sealed"');

    // B runs it within a poll.
    const seen = await eventually(
      () => api(b, "GET", "/v1/admin/sources/cursor-ann"),
      (r) => r.status === 200 && r.body.running === true,
    );
    expect(seen.body).toMatchObject({ managed: "store", running: true });

    // Created only once; a second create is refused.
    const again = await api(
      a,
      "PUT",
      "/v1/admin/sources/cursor-ann",
      { type: "otlp" },
      {
        "if-none-match": "*",
      },
    );
    expect(again.status).toBe(412);

    // Changed with its secret left out: the sealed key stays.
    const update = await api(
      b,
      "PUT",
      "/v1/admin/sources/cursor-ann",
      { type: "cursor-cloud", enabled: true, labels: { "dosu.member": "ann" } },
      { "if-match": seen.etag as string },
    );
    expect(update.status, JSON.stringify(update.body)).toBe(200);
    expect(update.body.source.api_key.fingerprint).toBe(put.body.source.api_key.fingerprint);

    // The org's lists, changed through B with the ETag read; A serves them to laptops.
    const config = await api(b, "GET", "/v1/admin/config");
    expect(config.body).toMatchObject({ runtime_config: "store", locked: ["default_visibility"] });
    expect(config.etag).toBeNull();
    const patch = await api(
      b,
      "PATCH",
      "/v1/admin/config",
      { set: { "capture.exclude": ["acme/hr"], "filter.min_chars": 7 } },
      { "if-none-match": "*" },
    );
    expect(patch.status, JSON.stringify(patch.body)).toBe(200);
    const rules = await eventually(
      () => api(a, "GET", "/v1/capture/rules"),
      (r) => (r.body.exclude ?? []).includes("acme/hr"),
    );
    expect(rules.body.exclude).toEqual(["acme/payroll", "acme/hr"]);

    // `seshi config show --origin` names the bucket as where those came from.
    const show = Bun.spawn(["bun", MAIN, "config", "show", "--origin", "--config", file], {
      cwd: dir,
      env: env(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const shown = await new Response(show.stdout).text();
    expect(await show.exited, await new Response(show.stderr).text()).toBe(0);
    expect(shown).toMatch(/filter\.min_chars = 7 {2}# file file:\/\/.*\/config\/seshi\.toml/);
    expect(shown).toMatch(/default_visibility = "owner" {2}# file .*seshi\.toml/);
    expect(shown).toMatch(/runtime\/sources\/cursor-ann\.json/);
    expect(shown).not.toContain(CURSOR_KEY);

    // A stale ETag, a locked setting, a section that is not the bucket's, a bad pattern.
    const next = await api(
      b,
      "PATCH",
      "/v1/admin/config",
      { set: { "filter.min_chars": 8 } },
      {
        "if-match": patch.etag as string,
      },
    );
    expect(next.status, JSON.stringify(next.body)).toBe(200);
    const stale = await api(
      b,
      "PATCH",
      "/v1/admin/config",
      { set: { "filter.min_chars": 9 } },
      {
        "if-match": patch.etag as string,
      },
    );
    expect(stale.status).toBe(412);
    const locked = await api(b, "PATCH", "/v1/admin/config", {
      set: { default_visibility: "org" },
    });
    expect(locked.status).toBe(409);
    expect(locked.body.error.code).toBe("locked");
    const foreign = await api(b, "PATCH", "/v1/admin/config", { set: { "search.enabled": false } });
    expect(foreign.status).toBe(422);
    const bad = await api(a, "PATCH", "/v1/admin/config", {
      set: { "capture.exclude": ["acme/has space"] },
    });
    expect(bad.status).toBe(422);

    // A rule pack, named by the doc; refused while named.
    const pack = await fetch(`${a}/v1/admin/config/files/packs/org.json`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ patterns: ["ACME-[0-9]{6}"], sensitive_files: [] }),
    });
    expect(pack.status, await pack.clone().text()).toBe(200);
    const named = await api(a, "PATCH", "/v1/admin/config", {
      set: { "redaction.packs": ["packs/org.json"] },
    });
    expect(named.status, JSON.stringify(named.body)).toBe(200);
    const inUse = await api(a, "DELETE", "/v1/admin/config/files/packs/org.json");
    expect(inUse.status).toBe(409);

    // A source that would read seshi's own bucket is refused before anything is written.
    const own = await api(a, "PUT", "/v1/admin/sources/loop", {
      type: "s3",
      url: `file://${join(dir, "bucket")}`,
    });
    expect(own.status).toBe(422);
    expect(readdirSync(join(dir, "bucket", "runtime", "sources"))).toEqual(["cursor-ann.json"]);

    // Both instances report the version; then the source goes.
    const status = await api(a, "GET", "/v1/admin/config?wait=5s");
    expect(status.body.converged).toBe(true);
    expect(status.body.instances).toHaveLength(2);
    const gone = await api(a, "DELETE", "/v1/admin/sources/cursor-ann");
    expect(gone.status).toBe(200);
    const after = await eventually(
      () => api(b, "GET", "/v1/admin/sources/cursor-ann"),
      (r) => r.status === 404,
    );
    expect(after.status).toBe(404);
  }, 60_000);

  it("is refused on a server whose config is file-only", async () => {
    writeConfig("file");
    const api = call(await adminToken());
    const a = await serve();
    const put = await api(a, "PUT", "/v1/admin/sources/x", { type: "otlp" });
    expect(put.status).toBe(409);
    expect(put.body.error.code).toBe("runtime_config_off");
    expect((await api(a, "GET", "/v1/admin/config")).body.runtime_config).toBe("file");
  }, 30_000);
});
