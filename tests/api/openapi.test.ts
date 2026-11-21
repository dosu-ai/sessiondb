/** The server against `spec/openapi.yaml`. Every request this test sends is validated against
 * the operation's request schema and every response against the schema the document gives
 * for that status; at the end, every documented status of every operation must have been
 * seen. A route that drifts from the document fails here, and so does a response the
 * document describes that the server never gives. */

import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type App, createApp as appOver } from "@seshi/api";
import { Auth, CREDENTIAL_SCOPES } from "@seshi/auth";
import { FakeIdp } from "@seshi/auth/testing";
import {
  Keyring,
  loadConfig,
  type RuntimeLayer,
  runtimeLoadOptions,
  serverConfigSchema,
} from "@seshi/config";
import { RuntimeConfig } from "@seshi/instance";
import { storeSession } from "@seshi/pipeline";
import { compileRuleSet, validatePack } from "@seshi/redact";
import {
  archiveId,
  FsStore,
  type Store,
  StoreError,
  writeDropped,
  writeFailed,
} from "@seshi/store";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { buildFormats } from "seshi/integrations";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { serverConfig, testApp, testInstance } from "../tooling/instance";
import { transcript } from "../tooling/testdata";

// --- the document -------------------------------------------------------------------------

const SPEC_PATH = join(import.meta.dirname, "../../spec/openapi.yaml");
const SCHEMAS = join(import.meta.dirname, "../../spec/schemas");

const FORMATS = buildFormats();
/** The server over an Instance with this binary's formats, as `seshi serve` builds it. */
const createApp = testApp;

// biome-ignore lint/suspicious/noExplicitAny: a parsed document, walked by path
const spec: any = Bun.YAML.parse(readFileSync(SPEC_PATH, "utf8"));

/** The stored objects' JSON Schemas (`spec/schemas/`), which the document references as
 * `./schemas/<name>.schema.json`: each is registered under its `$id`, the file name. */
function linkSchemas(node: unknown): void {
  if (Array.isArray(node)) node.forEach(linkSchemas);
  else if (node && typeof node === "object") {
    const object = node as Record<string, unknown>;
    if (typeof object.$ref === "string" && object.$ref.startsWith("./schemas/")) {
      object.$ref = object.$ref.slice("./schemas/".length);
    }
    Object.values(object).forEach(linkSchemas);
  }
}

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
for (const file of readdirSync(SCHEMAS).filter((f) => f.endsWith(".schema.json"))) {
  ajv.addSchema(JSON.parse(readFileSync(join(SCHEMAS, file), "utf8")));
}
linkSchemas(spec);
ajv.addSchema(spec, "spec");

/** A JSON pointer into the document, escaped. */
function pointer(...segments: (string | number)[]): string {
  return segments.map((s) => String(s).replace(/~/g, "~0").replace(/\//g, "~1")).join("/");
}

/** Follow a `$ref` within the document. */
function deref<T>(node: T): T {
  const ref = (node as { $ref?: string } | null)?.$ref;
  if (!ref) return node;
  if (!ref.startsWith("#/")) throw new Error(`external ref ${ref}`);
  // biome-ignore lint/suspicious/noExplicitAny: walking the parsed document
  let at: any = spec;
  for (const seg of ref.slice(2).split("/")) at = at[seg.replace(/~1/g, "/").replace(/~0/g, "~")];
  if (at === undefined) throw new Error(`dangling ref ${ref}`);
  return at;
}

const validators = new Map<string, ValidateFunction>();
function validator(...path: (string | number)[]): ValidateFunction {
  const key = pointer(...path);
  let v = validators.get(key);
  if (!v) {
    v = ajv.compile({ $ref: `spec#/${key}` });
    validators.set(key, v);
  }
  return v;
}

interface Operation {
  template: string;
  method: string;
  operationId: string;
  responses: Record<string, unknown>;
}

const operations: Operation[] = [];
for (const [template, item] of Object.entries<Record<string, unknown>>(spec.paths)) {
  for (const [method, op] of Object.entries(item)) {
    if (method === "parameters") continue;
    const { operationId, responses } = op as {
      operationId: string;
      responses: Record<string, unknown>;
    };
    operations.push({ template, method: method.toUpperCase(), operationId, responses });
  }
}

function operationFor(method: string, path: string): Operation {
  for (const op of operations) {
    if (op.method !== method) continue;
    const pattern = new RegExp(`^${op.template.replace(/\{[^}]+\}/g, "[^/]+")}$`);
    if (pattern.test(path)) return op;
  }
  throw new Error(`no operation for ${method} ${path}`);
}

/** Which (operation, status) pairs the document describes, and which this test has seen. */
const documented = new Set(
  operations.flatMap((op) => Object.keys(op.responses).map((s) => `${op.operationId} ${s}`)),
);
const seen = new Set<string>();

// --- the server ---------------------------------------------------------------------------

const TOKEN = "sdb_test-token-0123456789abcdef";
const SMALL = transcript("claude-basic.claude-code.jsonl");
const CLAUDE = `${SMALL.trim()}\n${JSON.stringify({
  type: "assistant",
  uuid: "a3",
  timestamp: "2026-09-01T00:00:08.000Z",
  sessionId: "sess1",
  message: {
    role: "assistant",
    model: "claude-x",
    content: [{ type: "text", text: `The auth flow: ${"details ".repeat(400)}` }],
  },
})}\n`;
const PROGRESS = `${JSON.stringify({ type: "progress", uuid: "p1" })}\n`;

let dir: string;
let store: FsStore;
let app: App;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seshi-openapi-"));
  store = new FsStore(join(dir, "bucket"));
  app = createApp({
    store,
    storage: { url: store.url },
    tokens: [{ token: TOKEN, owner: "acme" }],
  });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Send a request through `app` and hold both it and the response to the document. */
async function call(
  method: string,
  path: string,
  options: {
    token?: string | null;
    user?: string;
    body?: unknown;
    raw?: string;
    encoding?: string;
    contentType?: string;
    app?: App;
    headers?: Record<string, string>;
  } = {},
): Promise<{ status: number; body: unknown; headers: Headers }> {
  const url = new URL(`http://seshi.test${path}`);
  const op = operationFor(method, url.pathname);
  const headers: Record<string, string> = { ...options.headers };
  if (options.encoding) headers["content-encoding"] = options.encoding;
  if (options.token !== null) headers.authorization = `Bearer ${options.token ?? TOKEN}`;
  if (options.user !== undefined) headers["x-seshi-user"] = options.user;
  let body: string | undefined;
  if (options.raw !== undefined) {
    body = options.raw;
    headers["content-type"] = options.contentType ?? "application/json";
  } else if (options.body !== undefined) {
    const requestSchema = validator(
      "paths",
      op.template,
      op.method.toLowerCase(),
      "requestBody",
      "content",
      "application/json",
      "schema",
    );
    expect(requestSchema(options.body), JSON.stringify(requestSchema.errors)).toBe(true);
    body = JSON.stringify(options.body);
    headers["content-type"] = "application/json";
  }
  const response = await (options.app ?? app).fetch(new Request(url, { method, headers, body }));
  const status = response.status;
  const text = await response.text();
  const parsed: unknown = text ? JSON.parse(text) : undefined;

  const documentedResponse = op.responses[String(status)] as
    | { $ref?: string; content?: Record<string, unknown> }
    | undefined;
  expect(documentedResponse, `${op.operationId} does not document ${status}`).toBeDefined();
  const content = deref(documentedResponse as { content?: Record<string, unknown> }).content;
  if (content) {
    expect(response.headers.get("content-type")).toContain("application/json");
    const responseRef = (documentedResponse as { $ref?: string }).$ref;
    const schema = responseRef
      ? validator(
          ...responseRef
            .slice(2)
            .split("/")
            .map((s) => s.replace(/~1/g, "/")),
          "content",
          "application/json",
          "schema",
        )
      : validator(
          "paths",
          op.template,
          op.method.toLowerCase(),
          "responses",
          String(status),
          "content",
          "application/json",
          "schema",
        );
    expect(
      schema(parsed),
      `${op.operationId} ${status}: ${JSON.stringify(schema.errors)}\n${text}`,
    ).toBe(true);
  }
  seen.add(`${op.operationId} ${status}`);
  return { status, body: parsed, headers: response.headers };
}

describe("the document itself", () => {
  it("compiles every schema", () => {
    for (const name of Object.keys(spec.components.schemas))
      validator("components", "schemas", name);
  });

  it("names every route the server has, and no other", () => {
    const routes = operations.map((op) => `${op.method} ${op.template}`).sort();
    expect(routes).toEqual(
      [
        "GET /healthz",
        "GET /v1/auth/config",
        "POST /v1/auth/exchange",
        "GET /v1/me",
        "GET /v1/owners",
        "PATCH /v1/sessions/{format}/{session_id}",
        "POST /v1/tokens",
        "GET /v1/tokens",
        "POST /v1/tokens/revoke",
        "DELETE /v1/tokens/{id}",
        "POST /v1/sessions",
        "GET /v1/sessions",
        "GET /v1/sessions/stale",
        "GET /v1/sessions/{format}/{session_id}",
        "DELETE /v1/sessions/{format}/{session_id}",
        "GET /v1/sessions/{format}/{session_id}/trace",
        "GET /v1/sessions/{format}/{session_id}/export",
        "GET /v1/changes",
        "GET /v1/changes/all",
        "GET /v1/admin/jobs",
        "GET /v1/redaction/rules",
        "GET /v1/capture/rules",
        "GET /v1/sessions/{format}/{session_id}/reviews",
        "GET /v1/owners/{owner}/sessions/{archive_id}",
        "GET /v1/owners/{owner}/sessions/{archive_id}/trace",
        "GET /v1/owners/{owner}/sessions/{archive_id}/export",
        "GET /v1/owners/{owner}/sessions/{archive_id}/reviews",
        "POST /otlp/v1/traces",
        "GET /v1/search",
        "GET /v1/admin/sources",
        "GET /v1/admin/sources/{id}",
        "GET /v1/admin/sources/{id}/{kind}",
        "GET /v1/admin/reload",
        "POST /v1/admin/reload",
        "GET /v1/admin/config",
        "PATCH /v1/admin/config",
        "PUT /v1/admin/config/files/{name}",
        "DELETE /v1/admin/config/files/{name}",
        "POST /v1/admin/secrets/reseal",
        "PUT /v1/admin/sources/{id}",
        "DELETE /v1/admin/sources/{id}",
      ].sort(),
    );
  });
});

describe("the server honours it", () => {
  it("the redaction rules, for redacting before upload (F2.4)", async () => {
    const rules = compileRuleSet({
      packs: [
        validatePack(
          { id: "acme", disable: ["entropy"], rules: [{ id: "acme-key", pattern: "ACME-\\d+" }] },
          { source: "acme.toml" },
        ),
      ],
    });
    const withRules = createApp({
      store,
      storage: { url: store.url },
      tokens: [{ token: TOKEN, owner: "acme" }],
      redaction: rules,
    });
    expect((await call("GET", "/v1/redaction/rules", { app: withRules, token: null })).status).toBe(
      401,
    );
    const got = await call("GET", "/v1/redaction/rules", { app: withRules });
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({ rule_set: rules.hash, builtin: rules.builtinVersion });
    expect((got.body as { packs: { id: string }[] }).packs.map((p) => p.id)).toEqual(["acme"]);
    expect(got.headers.get("etag")).toBe(`"${rules.hash}"`);
    const cached = await call("GET", "/v1/redaction/rules", {
      app: withRules,
      headers: { "if-none-match": `"other", "${rules.hash}"` },
    });
    expect(cached.status).toBe(304);
    // An old ETag gets the packs again.
    const stale = await call("GET", "/v1/redaction/rules", {
      app: withRules,
      headers: { "if-none-match": '"stale"' },
    });
    expect(stale.status).toBe(200);
    // With no packs: the built-in pack's hash, and no packs to send.
    const plain = await call("GET", "/v1/redaction/rules");
    expect(plain.body).toMatchObject({ rule_set: compileRuleSet().hash, packs: [] });
  });

  it("the org's capture rules, which laptops apply before upload", async () => {
    const withList = (toml: string) =>
      createApp({
        store,
        storage: { url: store.url },
        tokens: [{ token: TOKEN, owner: "acme" }],
        config: toml,
      });
    const listed = withList(
      '[capture]\nexclude = ["acme/payroll", "", "# reviewed", "~/clients/**"]\n',
    );
    expect((await call("GET", "/v1/capture/rules", { app: listed, token: null })).status).toBe(401);
    const got = await call("GET", "/v1/capture/rules", { app: listed });
    expect(got.status).toBe(200);
    expect(got.body).toEqual({
      schema: "seshi/capture-rules/1",
      exclude: ["acme/payroll", "~/clients/**"],
      redact_tool_calls: [],
    });
    const etag = got.headers.get("etag") as string;
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
    const cached = await call("GET", "/v1/capture/rules", {
      app: listed,
      headers: { "if-none-match": etag },
    });
    expect(cached.status).toBe(304);
    // A changed list gets a new ETag, and the list again.
    const changed = await call("GET", "/v1/capture/rules", {
      app: withList('[capture]\nexclude = ["acme/payroll"]\n'),
      headers: { "if-none-match": etag },
    });
    expect(changed.status).toBe(200);
    expect(changed.headers.get("etag")).not.toBe(etag);
    // No list: an empty one.
    const plain = await call("GET", "/v1/capture/rules");
    expect(plain.body).toEqual({
      schema: "seshi/capture-rules/1",
      exclude: [],
      redact_tool_calls: [],
    });
  });

  it("refuses an upload whose repo the org's exclude list names (403 excluded)", async () => {
    const listed = createApp({
      store,
      storage: { url: store.url },
      tokens: [{ token: TOKEN, owner: "acme" }],
      config: '[capture]\nexclude = ["acme/payroll"]\n',
    });
    const body = {
      format: "claude-code",
      session_id: "excluded-1",
      transcript: CLAUDE,
      repo: "github.com/acme/payroll",
    };
    const refused = await call("POST", "/v1/sessions", { app: listed, body });
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ error: { code: "excluded" } });
    expect(JSON.stringify(refused.body)).not.toContain("acme/payroll");
    const elsewhere = await call("POST", "/v1/sessions", {
      app: listed,
      body: { ...body, repo: "github.com/acme/web" },
    });
    expect(elsewhere.status).toBe(201);
  });

  it("health and identity", async () => {
    expect((await call("GET", "/healthz", { token: null })).status).toBe(200);
    expect((await call("GET", "/v1/me")).status).toBe(200);
    expect((await call("GET", "/v1/me", { token: null })).status).toBe(401);
  });

  it("a session's life", async () => {
    const stored = await call("POST", "/v1/sessions", {
      body: {
        format: "claude-code",
        session_id: "sess1",
        transcript: CLAUDE,
        project: "github.com/acme/widget",
        branch: "main",
      },
    });
    expect(stored.status).toBe(201);
    const { bytes_total, content_hash, records_total, prefix_sha256 } = stored.body as {
      bytes_total: number;
      content_hash: string;
      records_total: number;
      prefix_sha256: string;
    };

    // A resend; the log again with nothing new in it; a chunk with nothing in it; a wrong
    // offset.
    const again = await call("POST", "/v1/sessions", {
      body: { format: "claude-code", session_id: "sess1", transcript: CLAUDE },
    });
    expect(again).toEqual(stored);
    const unchanged = await call("POST", "/v1/sessions", {
      body: {
        format: "claude-code",
        session_id: "sess1",
        transcript: CLAUDE,
        shipped: { records: records_total, prefix_sha256 },
        idempotency_key: "resent-whole",
      },
    });
    expect(unchanged.status).toBe(200);
    expect(unchanged.body).toMatchObject({ status: "unchanged" });
    const chunk = await call("POST", "/v1/sessions", {
      body: {
        format: "claude-code",
        session_id: "sess1",
        transcript: PROGRESS,
        offset: bytes_total,
      },
    });
    expect(chunk.body).toMatchObject({ status: "unchanged" });
    const wrong = await call("POST", "/v1/sessions", {
      body: { format: "claude-code", session_id: "sess1", transcript: PROGRESS, offset: 5 },
    });
    expect(wrong.status).toBe(409);
    expect(wrong.body).toMatchObject({ error: { expected: bytes_total + PROGRESS.length } });

    // A whole upload that does not extend the session; its replace, by its writer only.
    const rewritten = CLAUDE.replace("The auth flow:", "Another answer:");
    const conflict = await call("POST", "/v1/sessions", {
      body: { format: "claude-code", session_id: "sess1", transcript: rewritten },
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({ error: { code: "conflict" } });
    await storeSession(
      {
        owner: "acme",
        format: "claude-code",
        session_id: "theirs",
        transcript: CLAUDE,
        encoding: "jsonl",
      },
      {
        store,
        formats: FORMATS,
        context: { writer: { kind: "service", principal: "svc-import", source_id: "upload" } },
      },
    );
    const forbidden = await call("POST", "/v1/sessions", {
      body: { format: "claude-code", session_id: "theirs", transcript: rewritten, replace: true },
    });
    expect(forbidden.status).toBe(403);
    // A rebuild is a replace (X4.9): the same writer only, and never a chunk.
    const rebuildOthers = await call("POST", "/v1/sessions", {
      body: { format: "claude-code", session_id: "theirs", transcript: CLAUDE, rebuild: true },
    });
    expect(rebuildOthers.status).toBe(403);
    const rebuildChunk = await call("POST", "/v1/sessions", {
      body: {
        format: "claude-code",
        session_id: "sess1",
        transcript: PROGRESS,
        offset: bytes_total,
        rebuild: true,
      },
    });
    expect(rebuildChunk.status).toBe(422);
    expect(rebuildChunk.body).toMatchObject({ error: { code: "bad_chunk" } });

    // Reads.
    expect((await call("GET", "/v1/sessions")).status).toBe(200);
    expect((await call("GET", "/v1/sessions?limit=5")).status).toBe(200);
    expect((await call("GET", "/v1/sessions?limit=0")).status).toBe(400);
    expect((await call("GET", "/v1/sessions/stale")).status).toBe(200);
    expect((await call("GET", "/v1/sessions/stale?limit=0")).status).toBe(400);
    expect((await call("GET", "/v1/sessions/stale", { token: null })).status).toBe(401);
    expect((await call("GET", "/v1/sessions/claude-code/sess1")).status).toBe(200);
    expect((await call("GET", "/v1/sessions/claude-code/sess1/trace")).status).toBe(200);
    expect(
      (await call("GET", `/v1/sessions/claude-code/sess1/trace?hash=${content_hash}`)).status,
    ).toBe(200);
    const exported = await app.fetch(
      new Request("http://seshi.test/v1/sessions/claude-code/sess1/export?render=letta", {
        headers: { authorization: `Bearer ${TOKEN}` },
      }),
    );
    expect(exported.headers.get("content-disposition")).toBe(
      `attachment; filename="claude-code-sess1-${content_hash.slice(0, 12)}.letta.json"`,
    );
    expect((await call("GET", "/v1/sessions/claude-code/sess1/export?render=atif")).status).toBe(
      200,
    );
    expect((await call("GET", "/v1/sessions/claude-code/sess1/export?render=nope")).status).toBe(
      400,
    );
    expect(
      (await call("GET", "/v1/sessions/claude-code/sess1/export", { token: null })).status,
    ).toBe(401);
    expect((await call("GET", "/v1/sessions/claude-code/sess1/reviews")).status).toBe(200);
    expect(
      (await call("GET", "/v1/sessions/claude-code/sess1/reviews", { token: null })).status,
    ).toBe(401);
    // The same session by its owner and archive id, as change entries and search results name it.
    const byArchive = `/v1/owners/acme/sessions/${archiveId("acme", "claude-code", "sess1")}`;
    const missing = `/v1/owners/acme/sessions/${"0".repeat(64)}`;
    expect((await call("GET", byArchive)).body).toMatchObject({ format: "claude-code" });
    expect((await call("GET", `${byArchive}/trace?render=otlp`)).status).toBe(200);
    expect((await call("GET", `${byArchive}/trace?render=nope`)).status).toBe(400);
    expect((await call("GET", `${byArchive}/export`)).status).toBe(200);
    expect((await call("GET", `${byArchive}/reviews`)).status).toBe(200);
    for (const sub of ["", "/trace", "/export", "/reviews"]) {
      expect((await call("GET", `/v1/owners/acme/sessions/nope${sub}`)).status, sub).toBe(400);
      expect((await call("GET", `/v1/owners/a%2Fb/sessions/${"0".repeat(64)}${sub}`)).status).toBe(
        400,
      );
      expect((await call("GET", `${byArchive}${sub}`, { token: null })).status, sub).toBe(401);
      expect((await call("GET", `${missing}${sub}`)).status, sub).toBe(404);
    }
    expect((await call("GET", "/v1/changes")).status).toBe(200);
    expect((await call("GET", "/v1/changes?since=2020-01-01T00:00:00Z&limit=10")).status).toBe(200);
    expect((await call("GET", "/v1/changes?limit=nope")).status).toBe(400);

    // Not there, no trace yet, gone.
    expect((await call("GET", "/v1/sessions/claude-code/nope")).status).toBe(404);
    expect((await call("GET", "/v1/sessions/claude-code/nope/trace")).status).toBe(404);
    expect((await call("GET", "/v1/sessions/claude-code/nope/export")).status).toBe(404);
    expect((await call("GET", "/v1/sessions/claude-code/nope/reviews")).status).toBe(404);
    expect((await call("DELETE", "/v1/sessions/claude-code/nope")).status).toBe(404);
    const tiny = await call("POST", "/v1/sessions", {
      body: { format: "claude-code", session_id: "tiny", transcript: SMALL },
    });
    expect(tiny.body).toMatchObject({ status: "filtered" });
    expect((await call("GET", "/v1/sessions/claude-code/tiny/trace")).status).toBe(404);
    expect((await call("DELETE", "/v1/sessions/claude-code/sess1")).status).toBe(200);
    expect((await call("GET", "/v1/sessions/claude-code/sess1/trace")).status).toBe(410);
    expect((await call("GET", "/v1/sessions/claude-code/sess1/export")).status).toBe(410);
    expect((await call("GET", `${byArchive}/trace`)).status).toBe(410);
    expect((await call("GET", `${byArchive}/export`)).status).toBe(410);
    expect(
      (
        await call("POST", "/v1/sessions", {
          body: { format: "claude-code", session_id: "sess1", transcript: CLAUDE },
        })
      ).status,
    ).toBe(422);
  });

  it("refusals", async () => {
    expect(
      (
        await call("POST", "/v1/sessions", {
          token: null,
          body: { format: "codex", session_id: "x", transcript: "x" },
        })
      ).status,
    ).toBe(401);
    expect((await call("POST", "/v1/sessions", { raw: "{not json" })).status).toBe(400);
    expect((await call("POST", "/v1/sessions", { raw: "{}", encoding: "gzip" })).status).toBe(400);
    expect((await call("POST", "/v1/sessions", { raw: "{}", encoding: "br" })).status).toBe(415);
    const tiny = createApp({
      store,
      storage: { url: store.url },
      tokens: [{ token: TOKEN, owner: "acme" }],
      limits: { max_records: 50_000, max_records_bytes: 32 << 20, max_upload_bytes: 16 },
    });
    expect(
      (await call("POST", "/v1/sessions", { raw: " ".repeat((1 << 20) + 64), app: tiny })).status,
    ).toBe(413);
    expect(
      (
        await call("POST", "/v1/sessions", {
          body: { format: "claude-code", session_id: "blank", transcript: "  " },
        })
      ).status,
    ).toBe(422);
    for (const path of [
      "/v1/sessions",
      "/v1/sessions/claude-code/x",
      "/v1/sessions/claude-code/x/trace",
      "/v1/changes",
    ]) {
      expect((await call("GET", path, { token: null })).status).toBe(401);
    }
    expect((await call("DELETE", "/v1/sessions/claude-code/x", { token: null })).status).toBe(401);
  });

  it("every render format", async () => {
    const body = { format: "claude-code", session_id: "render", transcript: CLAUDE };
    expect((await call("POST", "/v1/sessions", { body })).status).toBe(201);
    const path = "/v1/sessions/claude-code/render/trace";
    const seshi = await call("GET", path);
    expect(seshi.body).toMatchObject({ schema: "seshi/trace/1" });
    expect((await call("GET", `${path}?render=seshi`)).body).toEqual(seshi.body);
    const letta = await call("GET", `${path}?render=letta`);
    expect(letta.body).toMatchObject({
      schema: "sessionstorage/trace/1",
      content_hash: (seshi.body as { content_hash: string }).content_hash,
    });
    expect((await call("GET", `${path}?render=otlp`)).body).toHaveProperty("resourceSpans");
    expect((await call("GET", `${path}?render=atif`)).body).toMatchObject({
      schema_version: "ATIF-v1.7",
      agent: { name: "claude-code" },
    });
    const bad = await call("GET", `${path}?render=xml`);
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toContain("seshi, letta, otlp, atif");
  });

  it("a failing bucket", async () => {
    const broken: Store = {
      url: store.url,
      get: () => Promise.reject(new StoreError("down")),
      put: () => Promise.reject(new StoreError("down")),
      stat: () => Promise.reject(new StoreError("down")),
      delete: () => Promise.reject(new StoreError("down")),
      list: () => Promise.reject(new StoreError("down")),
    };
    // An admin's session token is checked without the bucket, so the token routes reach it.
    const downAuth = new Auth(
      {
        staticTokens: [{ token: TOKEN, owner: "acme" }],
        orgKey: true,
        admins: [],
        aliases: {},
        sessionKeys: { k1: "k".repeat(32) },
      },
      { store: broken, deployment: "test" },
    );
    const down = createApp({ store: broken, storage: { url: broken.url }, auth: downAuth });
    const signed = await downAuth.sessions?.sign({
      owner: "ops",
      role: "admin",
      scopes: CREDENTIAL_SCOPES.admin,
    });
    const admin = { app: down, token: signed?.token };
    expect((await call("GET", "/v1/owners", { app: down })).status).toBe(502);
    expect(
      (
        await call("PATCH", "/v1/sessions/claude-code/x", {
          app: down,
          body: { visibility: "owner" },
        })
      ).status,
    ).toBe(502);
    expect(
      (await call("POST", "/v1/tokens", { ...admin, body: { kind: "admin", owner: "x" } })).status,
    ).toBe(502);
    expect((await call("GET", "/v1/tokens", admin)).status).toBe(502);
    expect(
      (await call("POST", "/v1/tokens/revoke", { ...admin, body: { owner: "x" } })).status,
    ).toBe(502);
    expect((await call("DELETE", `/v1/tokens/${"0".repeat(20)}`, admin)).status).toBe(502);
    const body = { format: "claude-code", session_id: "x", transcript: CLAUDE };
    // Who the token is needs no bucket.
    expect((await call("GET", "/v1/me", { app: down })).status).toBe(200);
    expect((await call("POST", "/v1/sessions", { body, app: down })).status).toBe(502);
    expect((await call("GET", "/v1/sessions", { app: down })).status).toBe(502);
    expect((await call("GET", "/v1/sessions/stale", { app: down })).status).toBe(502);
    expect((await call("GET", "/v1/sessions/claude-code/x", { app: down })).status).toBe(502);
    for (const sub of ["", "/trace", "/export", "/reviews"]) {
      const path = `/v1/owners/acme/sessions/${"0".repeat(64)}${sub}`;
      expect((await call("GET", path, { app: down })).status, sub).toBe(502);
    }
    expect((await call("GET", "/v1/sessions/claude-code/x/trace", { app: down })).status).toBe(502);
    expect((await call("GET", "/v1/sessions/claude-code/x/export", { app: down })).status).toBe(
      502,
    );
    expect((await call("GET", "/v1/admin/jobs", admin)).status).toBe(502);
    expect((await call("GET", "/v1/sessions/claude-code/x/reviews", { app: down })).status).toBe(
      502,
    );
    expect((await call("GET", "/v1/admin/sources", admin)).status).toBe(502);
    expect((await call("GET", "/v1/admin/sources/upload", admin)).status).toBe(502);
    expect((await call("GET", "/v1/admin/sources/upload/failed", admin)).status).toBe(502);
    expect((await call("DELETE", "/v1/sessions/claude-code/x", { app: down })).status).toBe(502);
    expect((await call("GET", "/v1/changes", { app: down })).status).toBe(502);
  });
});

describe("identity and access (X5)", () => {
  let idp: FakeIdp;
  let x5: App;
  let auth: Auth;

  beforeAll(async () => {
    idp = await FakeIdp.create();
  });

  beforeEach(() => {
    auth = new Auth(
      {
        staticTokens: [{ token: TOKEN, owner: "acme" }],
        orgKey: true,
        admins: [],
        aliases: {},
        sessionKeys: { k1: "k".repeat(32) },
        oidc: {
          issuer: idp.issuer,
          client_id: "seshi-cli",
          audience: idp.audience,
          owner_claim: "sub",
          groups_claim: "groups",
        },
      },
      { store, deployment: "test", oidcKeys: idp.keys },
    );
    x5 = createApp({ store, storage: { url: store.url }, auth });
  });

  it("the auth routes", async () => {
    expect((await call("GET", "/v1/auth/config", { token: null, app: x5 })).status).toBe(200);
    const signedIn = await call("POST", "/v1/auth/exchange", {
      token: null,
      app: x5,
      body: { id_token: await idp.idToken({ email: "a@acme.com" }), machine: { id: "mbp" } },
    });
    expect(signedIn.status).toBe(200);
    expect(signedIn.body).toHaveProperty("device_token");
    expect(
      (await call("POST", "/v1/auth/exchange", { token: null, app: x5, raw: "{}" })).status,
    ).toBe(400);
    expect(
      (
        await call("POST", "/v1/auth/exchange", {
          token: null,
          app: x5,
          body: { id_token: await idp.idToken({ aud: "elsewhere" }) },
        })
      ).status,
    ).toBe(401);
    // The default server has no IdP.
    expect(
      (await call("POST", "/v1/auth/exchange", { token: null, body: { id_token: "x" } })).status,
    ).toBe(404);
  });

  it("owners, visibility and scopes", async () => {
    const { admin: first, org_key } = await auth.initAdmin({ owner: "ops" });
    const admin = { app: x5, token: first?.token };
    const alice = { app: x5, token: org_key?.token, user: "alice" };
    const created = await call("POST", "/v1/tokens", {
      ...admin,
      body: { kind: "device", owner: "alice", label: "laptop" },
    });
    expect(created.status).toBe(201);
    const device = { app: x5, token: (created.body as { token: string }).token };
    const body = { format: "claude-code", session_id: "s1", transcript: CLAUDE };
    expect((await call("POST", "/v1/sessions", { ...device, body })).status).toBe(201);

    expect((await call("GET", "/v1/owners", alice)).status).toBe(200);
    expect((await call("GET", "/v1/owners?after=a/b", alice)).status).toBe(400);
    expect((await call("GET", "/v1/owners", { app: x5, token: null })).status).toBe(401);
    // A device token reads its owner's own sessions, and finds no one else's (X5.10).
    const other = await call("POST", "/v1/tokens", {
      ...admin,
      body: { kind: "device", owner: "bob" },
    });
    const bob = { app: x5, token: (other.body as { token: string }).token };
    expect((await call("GET", "/v1/owners", device)).status).toBe(403);
    expect((await call("GET", "/v1/sessions", device)).status).toBe(200);
    expect((await call("GET", "/v1/sessions?owner=alice", bob)).status).toBe(403);
    for (const sub of ["", "/trace", "/export", "/reviews"]) {
      const path = `/v1/sessions/claude-code/s1${sub}`;
      expect((await call("GET", path, device)).status, sub).toBe(200);
      expect((await call("GET", `${path}?owner=alice`, bob)).status, sub).toBe(404);
    }
    const s1 = `/v1/owners/alice/sessions/${archiveId("alice", "claude-code", "s1")}`;
    for (const sub of ["", "/trace", "/export", "/reviews"]) {
      expect((await call("GET", `${s1}${sub}`, device)).status, sub).toBe(200);
      expect((await call("GET", `${s1}${sub}`, bob)).status, sub).toBe(404);
    }
    expect((await call("GET", "/v1/admin/jobs", admin)).status).toBe(200);
    expect((await call("GET", "/v1/admin/jobs", alice)).status).toBe(403);
    expect((await call("GET", "/v1/admin/jobs", { app: x5, token: null })).status).toBe(401);
    expect((await call("GET", "/v1/changes", device)).status).toBe(200);
    expect((await call("GET", "/v1/changes?owner=alice", bob)).status).toBe(403);
    expect((await call("DELETE", "/v1/sessions/claude-code/s1", alice)).status).toBe(403);

    const patch = (as: object, visibility: unknown, path = "/v1/sessions/claude-code/s1") =>
      call("PATCH", path, { ...as, body: { visibility } });
    // The device wrote it, so its owner is verified: the org key may not change it, an admin may.
    expect((await patch(alice, "owner")).status).toBe(403);
    expect((await patch(admin, "owner", "/v1/sessions/claude-code/s1?owner=alice")).status).toBe(
      200,
    );
    expect((await call("GET", "/v1/sessions/claude-code/s1?owner=alice", alice)).status).toBe(200);
    expect(
      (
        await call("PATCH", "/v1/sessions/claude-code/s1", {
          ...alice,
          raw: JSON.stringify({ visibility: "everyone" }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call("PATCH", "/v1/sessions/claude-code/s1", {
          app: x5,
          token: null,
          body: { visibility: "org" },
        })
      ).status,
    ).toBe(401);
    // The owner's device token reads nothing, but shares the owner's own session.
    expect((await patch(device, "org")).status).toBe(200);
    expect((await patch(alice, "org", "/v1/sessions/claude-code/nope")).status).toBe(404);
    expect((await call("DELETE", "/v1/sessions/claude-code/s1?owner=alice", admin)).status).toBe(
      200,
    );
    expect(
      (await patch({ ...admin }, "org", "/v1/sessions/claude-code/s1?owner=alice")).status,
    ).toBe(410);
  });

  it("retraction (F9.7)", async () => {
    const { org_key } = await auth.initAdmin({ owner: "ops" });
    const alice = { app: x5, token: org_key?.token, user: "alice" };
    const secret = "s".repeat(43);
    const retract_hash = createHash("sha256").update(secret).digest("hex");
    const body = { format: "claude-code", session_id: "r1", transcript: CLAUDE, retract_hash };
    expect((await call("POST", "/v1/sessions", { ...alice, body })).status).toBe(201);
    const retract = (as: object, value: string, path = "/v1/sessions/claude-code/r1") =>
      call("DELETE", path, { ...as, headers: { "x-seshi-retract": value } });
    expect((await retract(alice, "wrong")).status).toBe(403);
    expect((await retract(alice, secret, "/v1/sessions/claude-code/nope")).status).toBe(404);
    expect((await retract({ app: x5, token: null }, secret)).status).toBe(401);
    // Another member with the secret still reaches only their own sessions, `owner` or not.
    const mallory = { app: x5, token: org_key?.token, user: "mallory" };
    expect((await retract(mallory, secret)).status).toBe(404);
    expect((await retract(mallory, secret, "/v1/sessions/claude-code/r1?owner=alice")).status).toBe(
      404,
    );
    const removed = await retract(alice, secret);
    expect(removed.status).toBe(200);
    expect((await retract(alice, secret)).status).toBe(410);
    // A server that does not allow retraction refuses before it looks.
    const closed = createApp({
      store,
      storage: { url: store.url },
      auth,
      config: "[capture]\nallow_retract = false\n",
    });
    const bob = { app: closed, token: org_key?.token, user: "bob" };
    expect((await call("POST", "/v1/sessions", { ...bob, body })).status).toBe(201);
    const refused = await retract(bob, secret);
    expect(refused.status).toBe(403);
    expect((refused.body as { error: { code: string } }).error.code).toBe("retract_disabled");
    expect(
      (
        await call("POST", "/v1/sessions", {
          ...alice,
          raw: JSON.stringify({ ...body, session_id: "r2", retract_hash: "not-hex" }),
        })
      ).status,
    ).toBe(400);
  });

  it("the config reload routes (F1.5)", async () => {
    const { admin: first, org_key } = await auth.initAdmin({ owner: "ops" });
    const storeUrl = /^(file|s3|r2):\/\//.test(store.url) ? store.url : "file:///unused-test-store";
    let toml = "";
    const reloading = createApp({
      store,
      storage: { url: store.url },
      auth,
      loadConfig: () => serverConfig(toml, { storeUrl }),
    });
    const admin = { app: reloading, token: first?.token };
    const alice = { app: reloading, token: org_key?.token, user: "alice" };
    const nobody = { app: reloading, token: null };

    const status = await call("GET", "/v1/admin/reload", admin);
    expect(status.body).toMatchObject({ generation: 1, reloadable: true, last_reload: null });
    expect((await call("GET", "/v1/admin/reload", alice)).status).toBe(403);
    expect((await call("GET", "/v1/admin/reload", nobody)).status).toBe(401);

    toml = '[[sources]]\nid = "otel"\ntype = "otlp"\n';
    const applied = await call("POST", "/v1/admin/reload", admin);
    expect(applied.status).toBe(200);
    expect(applied.body).toMatchObject({
      reload: { outcome: "applied", trigger: "api", sources: { added: ["otel"] } },
      config: { generation: 2 },
    });
    toml = '[[sources]]\nid = "otel"\ntype = "nope"\n';
    const rejected = await call("POST", "/v1/admin/reload", admin);
    expect(rejected.status).toBe(422);
    expect(rejected.body).toMatchObject({
      error: { code: "reload_rejected" },
      reload: { outcome: "rejected" },
      config: { generation: 2 },
    });
    expect((await call("POST", "/v1/admin/reload", alice)).status).toBe(403);
    expect((await call("POST", "/v1/admin/reload", nobody)).status).toBe(401);
    // A server with no config file to read again.
    expect((await call("POST", "/v1/admin/reload", { ...admin, app: x5 })).status).toBe(409);
  });

  it("the admin source routes", async () => {
    const { admin: first, org_key } = await auth.initAdmin({ owner: "ops" });
    const admin = { app: x5, token: first?.token };
    const alice = { app: x5, token: org_key?.token, user: "alice" };
    const nobody = { app: x5, token: null };
    // A source no longer configured still has its records.
    await writeFailed(store, {
      at: "2026-11-01T00:00:00.000Z",
      source: "gone",
      idempotency_key: "k1",
      code: "invalid",
      message: "no records",
    });
    await writeDropped(store, {
      at: "2026-11-02T00:00:00.000Z",
      source: "upload",
      idempotency_key: "k2",
      session_key: "s1",
      reason: "review_drop",
      policy: "default",
      policy_hash: "h",
      decision_model: "m",
    });

    const all = await call("GET", "/v1/admin/sources?days=3", admin);
    expect(all.status).toBe(200);
    expect((all.body as { sources: { id: string }[] }).sources.map((s) => s.id)).toEqual([
      "upload",
    ]);
    expect((await call("GET", "/v1/admin/sources?days=0", admin)).status).toBe(400);
    expect((await call("GET", "/v1/admin/sources", alice)).status).toBe(403);
    expect((await call("GET", "/v1/admin/sources", nobody)).status).toBe(401);

    const upload = await call("GET", "/v1/admin/sources/upload", admin);
    expect(upload.status).toBe(200);
    expect(upload.body).toMatchObject({ id: "upload", dropped: 1, failed: 0 });
    expect((await call("GET", "/v1/admin/sources/upload?days=x", admin)).status).toBe(400);
    expect((await call("GET", "/v1/admin/sources/gone", admin)).status).toBe(404);
    expect((await call("GET", "/v1/admin/sources/upload", alice)).status).toBe(403);
    expect((await call("GET", "/v1/admin/sources/upload", nobody)).status).toBe(401);

    const failed = await call("GET", "/v1/admin/sources/gone/failed", admin);
    expect(failed.status).toBe(200);
    expect(failed.body).toMatchObject({
      source: "gone",
      kind: "failed",
      records: [{ record: { code: "invalid" } }],
    });
    const dropped = await call("GET", "/v1/admin/sources/upload/dropped?limit=1", admin);
    expect(dropped.body).toMatchObject({ records: [{ record: { session_key: "s1" } }] });
    const cursor = (dropped.body as { cursor: string }).cursor;
    const next = await call(
      "GET",
      `/v1/admin/sources/upload/dropped?after=${encodeURIComponent(cursor)}`,
      admin,
    );
    expect(next.body).toMatchObject({ records: [] });
    const later = await call(
      "GET",
      "/v1/admin/sources/gone/failed?since=2026-11-02T00:00:00Z",
      admin,
    );
    expect(later.body).toMatchObject({ records: [] });
    expect((await call("GET", "/v1/admin/sources/gone/failed?since=soon", admin)).status).toBe(400);
    expect(
      (await call("GET", "/v1/admin/sources/upload/failed?after=elsewhere", admin)).status,
    ).toBe(400);
    expect((await call("GET", "/v1/admin/sources/nope/failed", admin)).status).toBe(404);
    expect((await call("GET", "/v1/admin/sources/upload/failed", alice)).status).toBe(403);
    expect((await call("GET", "/v1/admin/sources/upload/failed", nobody)).status).toBe(401);
  });

  it("the runtime config routes (runtime_config = store)", async () => {
    const { admin: first, org_key } = await auth.initAdmin({ owner: "ops" });
    const SEAL = "s".repeat(32);
    const storeUrl = store.url.startsWith("file://") ? store.url : `file://${store.url}`;
    const text = `default_visibility = "owner"
[store]
url = ${JSON.stringify(storeUrl)}
[server]
runtime_config = "store"
[secrets]
keys = { k1 = "${SEAL}" }
[[sources]]
id = "adx-ingest"
type = "otlp"
`;
    const load = (layer?: RuntimeLayer) => {
      const layered = layer ? runtimeLoadOptions(layer) : undefined;
      return loadConfig(serverConfigSchema, {
        file: "seshi.toml",
        fs: { readFile: () => text, mode: () => 0o100600 },
        env: { SESHI_SEARCH__PATH: ":memory:" },
        ...(layered?.base ? { base: layered.base } : {}),
        ...(layered ? { additions: layered.additions } : {}),
      });
    };
    let down = false;
    const fail = () => Promise.reject(new StoreError("down"));
    const switchable: Store = {
      url: store.url,
      get: (k) => (down ? fail() : store.get(k)),
      put: (k, b, o) => (down ? fail() : store.put(k, b, o)),
      stat: (k) => (down ? fail() : store.stat(k)),
      delete: (k, o) => (down ? fail() : store.delete(k, o)),
      list: (p, o) => (down ? fail() : store.list(p, o)),
    };
    const runtimeApp = (keyring: Keyring) =>
      createApp({
        store: switchable,
        storage: { url: store.url },
        auth,
        config: text,
        runtime: new RuntimeConfig({
          store: switchable,
          keyring,
          load,
          cacheDir: join(dir, `runtime-${Math.random().toString(36).slice(2)}`),
          pollMs: 60_000,
        }),
      });
    const rt = runtimeApp(new Keyring({ k1: SEAL }));
    const admin = { app: rt, token: first?.token };
    const alice = { app: rt, token: org_key?.token, user: "alice" };
    const nobody = { app: rt, token: null };
    const fileOnly = { app: x5, token: first?.token };

    // Reading it.
    const status = await call("GET", "/v1/admin/config", admin);
    expect(status.body).toMatchObject({ runtime_config: "store", locked: ["default_visibility"] });
    expect((await call("GET", "/v1/admin/config", fileOnly)).body).toMatchObject({
      runtime_config: "file",
    });
    expect((await call("GET", "/v1/admin/config?wait=soon", admin)).status).toBe(400);
    expect((await call("GET", "/v1/admin/config", alice)).status).toBe(403);
    expect((await call("GET", "/v1/admin/config", nobody)).status).toBe(401);

    // The data policy.
    const patched = await call("PATCH", "/v1/admin/config", {
      ...admin,
      body: { set: { "capture.exclude": ["acme/hr"] } },
      headers: { "if-none-match": "*" },
    });
    expect(patched.status).toBe(200);
    const etag = patched.headers.get("etag") as string;
    const p = (body: unknown, extra: object = {}) =>
      call("PATCH", "/v1/admin/config", { ...admin, body, ...extra });
    expect((await call("PATCH", "/v1/admin/config", { ...admin, raw: '{"set":5}' })).status).toBe(
      400,
    );
    expect((await p({ set: { default_visibility: "org" } })).status).toBe(409);
    expect(
      (await p({ set: { "filter.min_chars": 1 } }, { headers: { "if-match": '"old"' } })).status,
    ).toBe(412);
    expect((await p({ set: { "search.enabled": false } })).status).toBe(422);
    expect(
      (await p({ set: { "filter.min_chars": 1 } }, { headers: { "if-match": etag } })).status,
    ).toBe(200);
    expect(
      (await call("PATCH", "/v1/admin/config", { ...fileOnly, body: { set: {} } })).status,
    ).toBe(409);
    expect((await call("PATCH", "/v1/admin/config", { ...alice, body: { set: {} } })).status).toBe(
      403,
    );
    expect((await call("PATCH", "/v1/admin/config", { ...nobody, body: { set: {} } })).status).toBe(
      401,
    );

    // Files under config/.
    const file = (method: string, name: string, extra: object = {}) =>
      call(method, `/v1/admin/config/files/${encodeURIComponent(name)}`, {
        ...admin,
        ...(method === "PUT"
          ? {
              raw: JSON.stringify({ patterns: ["ACME-[0-9]{6}"] }),
              contentType: "application/octet-stream",
            }
          : {}),
        ...extra,
      });
    expect((await file("PUT", "packs/org.json")).status).toBe(200);
    expect(
      (await file("PUT", "packs/org.json", { headers: { "if-none-match": "*" } })).status,
    ).toBe(412);
    expect((await file("PUT", "seshi.toml")).status).toBe(422);
    expect((await file("PUT", "packs/org.json", { app: x5 })).status).toBe(409);
    expect(
      (await file("PUT", "packs/org.json", { token: org_key?.token, user: "alice" })).status,
    ).toBe(403);
    expect((await file("PUT", "packs/org.json", { token: null })).status).toBe(401);
    expect((await p({ set: { "redaction.packs": ["packs/org.json"] } })).status).toBe(200);
    expect((await file("DELETE", "packs/org.json")).status).toBe(409);
    expect((await file("DELETE", "packs/none.json")).status).toBe(404);
    expect((await file("PUT", "prompts/p.md")).status).toBe(200);
    expect(
      (await file("DELETE", "prompts/p.md", { headers: { "if-match": '"old"' } })).status,
    ).toBe(412);
    expect((await file("DELETE", "prompts/p.md")).status).toBe(200);
    expect(
      (await file("DELETE", "prompts/p.md", { token: org_key?.token, user: "alice" })).status,
    ).toBe(403);
    expect((await file("DELETE", "prompts/p.md", { token: null })).status).toBe(401);

    // Sources.
    const src = (method: string, id: string, extra: object = {}) =>
      call(method, `/v1/admin/sources/${id}`, { ...admin, ...extra });
    const cursor = { type: "cursor-cloud", enabled: false, api_key: "key_cursor_secret" };
    const created = await src("PUT", "cursor-a", { body: cursor });
    expect(created.status).toBe(201);
    expect(JSON.stringify(created.body)).not.toContain("key_cursor_secret");
    expect(
      (await src("PUT", "cursor-a", { body: { type: "cursor-cloud", enabled: true } })).status,
    ).toBe(200);
    expect(
      (await src("PUT", "cursor-a", { body: cursor, headers: { "if-none-match": "*" } })).status,
    ).toBe(412);
    expect((await src("PUT", "Bad_Id", { body: cursor })).status).toBe(400);
    expect((await src("PUT", "adx-ingest", { body: { type: "otlp" } })).status).toBe(409);
    expect((await src("PUT", "other", { body: { type: "nope" } })).status).toBe(422);
    expect(
      (await src("PUT", "other", { body: { type: "otlp" }, token: org_key?.token, user: "alice" }))
        .status,
    ).toBe(403);
    expect((await src("PUT", "other", { body: { type: "otlp" }, token: null })).status).toBe(401);
    const one = await src("GET", "cursor-a");
    expect(one.body).toMatchObject({
      managed: "store",
      running: true,
      config: { api_key: { set: true } },
    });

    // Sealing keys.
    expect((await call("POST", "/v1/admin/secrets/reseal", admin)).body).toMatchObject({
      key_id: "k1",
      current: ["cursor-a"],
    });
    const noCurrent = runtimeApp(new Keyring({ k1: SEAL, k2: "t".repeat(32) }));
    expect(
      (await call("POST", "/v1/admin/secrets/reseal", { ...admin, app: noCurrent })).status,
    ).toBe(422);
    expect((await call("POST", "/v1/admin/secrets/reseal", fileOnly)).status).toBe(409);
    expect((await call("POST", "/v1/admin/secrets/reseal", alice)).status).toBe(403);
    expect((await call("POST", "/v1/admin/secrets/reseal", nobody)).status).toBe(401);

    expect((await src("DELETE", "nope")).status).toBe(404);
    expect((await src("DELETE", "adx-ingest")).status).toBe(409);
    expect((await src("DELETE", "cursor-a", { headers: { "if-match": '"old"' } })).status).toBe(
      412,
    );
    expect((await src("DELETE", "Bad_Id")).status).toBe(400);
    expect((await src("DELETE", "cursor-a", { token: org_key?.token, user: "alice" })).status).toBe(
      403,
    );
    expect((await src("DELETE", "cursor-a", { token: null })).status).toBe(401);
    expect((await src("DELETE", "cursor-a")).status).toBe(200);

    // The bucket down.
    down = true;
    expect((await call("GET", "/v1/admin/config", admin)).status).toBe(502);
    expect((await p({ set: { "filter.min_chars": 2 } })).status).toBe(502);
    expect((await file("PUT", "packs/org.json")).status).toBe(502);
    expect((await file("DELETE", "packs/org.json")).status).toBe(502);
    expect((await src("PUT", "cursor-b", { body: cursor })).status).toBe(502);
    expect((await src("DELETE", "cursor-b")).status).toBe(502);
    expect((await call("POST", "/v1/admin/secrets/reseal", admin)).status).toBe(502);
  });

  it("the token routes", async () => {
    const { admin: first } = await auth.initAdmin({ owner: "ops" });
    const admin = { app: x5, token: first?.token };
    const member = { app: x5, token: TOKEN };
    const created = await call("POST", "/v1/tokens", {
      ...admin,
      body: { kind: "service", service: "sync", scopes: ["sessions:read", "search"] },
    });
    expect(created.status).toBe(201);
    const id = (created.body as { record: { id: string } }).record.id;
    // The stale listing is the uploader's: a reader's token cannot write, so it is refused.
    const syncToken = (created.body as { token: string }).token;
    expect((await call("GET", "/v1/sessions/stale", { app: x5, token: syncToken })).status).toBe(
      403,
    );
    expect((await call("POST", "/v1/tokens", { ...admin, body: { kind: "device" } })).status).toBe(
      400,
    );
    expect(
      (await call("POST", "/v1/tokens", { app: x5, token: null, body: { kind: "org" } })).status,
    ).toBe(401);
    expect((await call("POST", "/v1/tokens", { ...member, body: { kind: "org" } })).status).toBe(
      403,
    );
    expect((await call("GET", "/v1/tokens?kind=service", admin)).status).toBe(200);
    expect((await call("GET", "/v1/tokens?all=maybe", admin)).status).toBe(400);
    expect((await call("GET", "/v1/tokens", { app: x5, token: null })).status).toBe(401);
    expect((await call("GET", "/v1/tokens", member)).status).toBe(403);
    expect((await call("DELETE", `/v1/tokens/${id}`, admin)).status).toBe(200);
    expect((await call("DELETE", `/v1/tokens/${"0".repeat(20)}`, admin)).status).toBe(404);
    expect((await call("DELETE", `/v1/tokens/${id}`, { app: x5, token: null })).status).toBe(401);
    expect((await call("DELETE", `/v1/tokens/${id}`, member)).status).toBe(403);
    expect(
      (await call("POST", "/v1/tokens/revoke", { ...admin, body: { owner: "svc:sync" } })).status,
    ).toBe(200);
    expect((await call("POST", "/v1/tokens/revoke", { ...admin, raw: "{}" })).status).toBe(400);
    expect(
      (await call("POST", "/v1/tokens/revoke", { app: x5, token: null, body: { owner: "x" } }))
        .status,
    ).toBe(401);
    expect(
      (await call("POST", "/v1/tokens/revoke", { ...member, body: { owner: "x" } })).status,
    ).toBe(403);
  });

  it("OTLP ingest", async () => {
    const sources = '[[sources]]\nid = "console"\ntype = "otlp"\n';
    const otlpAuth = new Auth(
      {
        staticTokens: [{ token: TOKEN, owner: "acme" }],
        orgKey: true,
        admins: [],
        aliases: {},
        sessionKeys: {},
      },
      { store, deployment: "test", sources: ["console", "idle"] },
    );
    const otlp = createApp({
      store,
      auth: otlpAuth,
      config: `${sources}[[sources]]\nid = "idle"\ntype = "otlp"\nenabled = false\n[limits]\nmax_upload_bytes = 2048\nmax_otlp_bytes = "1MiB"\n`,
    });
    const { admin } = await otlpAuth.initAdmin({ owner: "ops" });
    const by = await otlpAuth.authenticate(admin?.token, undefined);
    const writer = (service: string) =>
      otlpAuth.issue({ kind: "service", service, scopes: ["sessions:write"] }, by);
    const console = (await writer("console")).token;
    const idle = (await writer("idle")).token;
    const reader = (await otlpAuth.issue({ kind: "service", service: "sync" }, by)).token;
    const span = (attributes: unknown[]) =>
      JSON.stringify({
        resourceSpans: [
          {
            scopeSpans: [
              {
                spans: [
                  {
                    traceId: "ab".repeat(16),
                    spanId: "cd".repeat(8),
                    name: "chat",
                    startTimeUnixNano: "1790000000000000000",
                    attributes,
                  },
                ],
              },
            ],
          },
        ],
      });
    const content = span([{ key: "gen_ai.input.messages", value: { stringValue: "[]" } }]);
    const send = (token: string | null | undefined, raw: string, contentType?: string) =>
      call("POST", "/otlp/v1/traces", {
        app: otlp,
        token,
        raw,
        ...(contentType ? { contentType } : {}),
      });

    expect((await send(console, content)).body).toEqual({});
    const metadataOnly = await send(console, span([]));
    expect(metadataOnly.status).toBe(200);
    expect(metadataOnly.body).toMatchObject({ partialSuccess: { rejectedSpans: "1" } });
    expect((await send(null, content)).status).toBe(401);
    expect((await send(TOKEN, content)).status).toBe(403);
    expect((await send(reader, content)).status).toBe(403);
    expect((await send(idle, content)).status).toBe(403);
    expect((await send(console, content, "text/plain")).status).toBe(415);
    expect((await send(console, "{not json")).status).toBe(400);
    expect((await send(console, JSON.stringify({ pad: "x".repeat(1_100_000) }))).status).toBe(413);

    const broken: Store = {
      url: store.url,
      get: () => Promise.resolve(null),
      put: () => Promise.reject(new StoreError("down")),
      stat: () => Promise.resolve(null),
      delete: () => Promise.reject(new StoreError("down")),
      list: () => Promise.resolve({ keys: [], truncated: false }),
    };
    const brokenAuth = new Auth(
      { staticTokens: [], orgKey: false, admins: [], aliases: {}, sessionKeys: {} },
      { store, deployment: "test", sources: ["console"] },
    );
    const down = createApp({ store: broken, auth: brokenAuth, config: sources });
    const { admin: downAdmin } = await brokenAuth.initAdmin({ owner: "ops", force: true });
    const issued = await brokenAuth.issue(
      { kind: "service", service: "console", scopes: ["sessions:write"] },
      await brokenAuth.authenticate(downAdmin?.token, undefined),
    );
    expect(
      (await call("POST", "/otlp/v1/traces", { app: down, token: issued.token, raw: content }))
        .status,
    ).toBe(503);
  });
});

describe("search (F10)", () => {
  it("answers, refuses and waits as documented", async () => {
    let down = false;
    const flaky: Store = {
      url: store.url,
      get: (key) => (down ? Promise.reject(new StoreError("down")) : store.get(key)),
      put: (key, body, options) => store.put(key, body, options),
      stat: (key) => store.stat(key),
      delete: (key, options) => store.delete(key, options),
      list: (prefix, options) => store.list(prefix, options),
    };
    const auth = new Auth(
      {
        staticTokens: [{ token: TOKEN, owner: "acme" }],
        orgKey: true,
        admins: [],
        aliases: {},
        sessionKeys: { k1: "k".repeat(32) },
      },
      { store: flaky, deployment: "test" },
    );
    const instance = testInstance({ store: flaky, storage: { url: store.url }, auth });
    const searching = appOver(instance);
    const as = { app: searching };

    // Until the index has caught up once, it says so (F10.3).
    expect((await call("GET", "/v1/search?q=auth", as)).status).toBe(503);
    const body = { format: "claude-code", session_id: "sess1", transcript: CLAUDE };
    expect((await call("POST", "/v1/sessions", { ...as, body })).status).toBe(201);
    await instance.search?.catchUp();

    const found = await call("GET", "/v1/search?q=auth%20flow&limit=5&matches=2&sort=recent", as);
    expect(found.status).toBe(200);
    expect(found.body).toMatchObject({
      total: 1,
      results: [{ owner: "acme", session_id: "sess1" }],
    });
    for (const bad of ["q=", "q=x&limit=two", "q=x&q=y", "q=x&page=2", "q=x&owner=a/b", "q=--"]) {
      expect((await call("GET", `/v1/search?${bad}`, as)).status, bad).toBe(400);
    }
    expect((await call("GET", "/v1/search?q=auth", { ...as, token: null })).status).toBe(401);
    const reader = await auth.sessions?.sign({
      owner: "acme",
      role: "member",
      scopes: ["sessions:read"],
    });
    // Without the search scope it searches only its own owner's sessions.
    expect((await call("GET", "/v1/search?q=auth", { ...as, token: reader?.token })).status).toBe(
      200,
    );
    expect(
      (await call("GET", "/v1/search?q=auth&owner=bob", { ...as, token: reader?.token })).status,
    ).toBe(403);
    const off = appOver(
      testInstance({
        store,
        storage: { url: store.url },
        auth,
        config: "[search]\nenabled = false\n",
      }),
    );
    expect((await call("GET", "/v1/search?q=auth", { app: off })).status).toBe(404);
    down = true;
    expect((await call("GET", "/v1/search?q=auth", as)).status).toBe(502);
    await instance.close();
  });
});

describe("every owner's change feed", () => {
  it("answers, refuses and waits as documented", async () => {
    const auth = new Auth(
      {
        staticTokens: [{ token: TOKEN, owner: "acme" }],
        orgKey: true,
        admins: [],
        aliases: {},
        sessionKeys: { k1: "k".repeat(32) },
      },
      { store, deployment: "test" },
    );
    const instance = testInstance({ store, storage: { url: store.url }, auth });
    const { admin } = await auth.initAdmin({ owner: "ops" });
    const as = { app: appOver(instance), token: admin?.token };

    expect((await call("GET", "/v1/changes/all", as)).status).toBe(503);
    const body = { format: "claude-code", session_id: "feed1", transcript: CLAUDE };
    expect((await call("POST", "/v1/sessions", { ...as, token: TOKEN, body })).status).toBe(201);
    await instance.search?.catchUp();
    const first = await call("GET", "/v1/changes/all?limit=1", as);
    expect(first.status).toBe(200);
    const cursor = (first.body as { cursor: string }).cursor;
    expect(
      (await call("GET", `/v1/changes/all?after=${encodeURIComponent(cursor)}`, as)).status,
    ).toBe(200);
    expect((await call("GET", "/v1/changes/all?since=2020-01-01T00:00:00Z", as)).status).toBe(200);
    for (const bad of ["after=nope", "since=yesterday", "limit=0", "owner=acme"]) {
      expect((await call("GET", `/v1/changes/all?${bad}`, as)).status, bad).toBe(400);
    }
    expect((await call("GET", "/v1/changes/all", { ...as, token: null })).status).toBe(401);
    // A static token reads one owner's sessions, not everyone's.
    expect((await call("GET", "/v1/changes/all", { ...as, token: TOKEN })).status).toBe(403);
    const off = appOver(
      testInstance({
        store,
        storage: { url: store.url },
        auth,
        config: "[search]\nenabled = false\n",
      }),
    );
    expect((await call("GET", "/v1/changes/all", { ...as, app: off })).status).toBe(404);
    await instance.close();
  });
});

afterAll(() => {
  // Every response the document describes, this test has seen the server give.
  const unseen = [...documented].filter((d) => !seen.has(d)).sort();
  expect(unseen, "documented but never observed").toEqual([]);
});
