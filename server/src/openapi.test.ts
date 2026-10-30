/** The server against `spec/openapi.yaml`. Every request this test sends is validated against
 * the operation's request schema and every response against the schema the document gives
 * for that status; at the end, every documented status of every operation must have been
 * seen. A route that drifts from the document fails here, and so does a response the
 * document describes that the server never gives. */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsStore, type Store, StoreError } from "@dosu/sessiondb";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { type App, createApp } from "./app";

// --- the document -------------------------------------------------------------------------

const SPEC_PATH = join(import.meta.dirname, "../../spec/openapi.yaml");
// biome-ignore lint/suspicious/noExplicitAny: a parsed document, walked by path
const spec: any = Bun.YAML.parse(readFileSync(SPEC_PATH, "utf8"));

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
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
const TRANSCRIPTS = join(import.meta.dirname, "../../spec/testdata/transcripts");
const SMALL = readFileSync(join(TRANSCRIPTS, "claude-basic.claude-code.jsonl"), "utf8");
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
  dir = mkdtempSync(join(tmpdir(), "sessiondb-openapi-"));
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
  options: { token?: string | null; body?: unknown; raw?: string; app?: App } = {},
): Promise<{ status: number; body: unknown }> {
  const url = new URL(`http://sessiondb.test${path}`);
  const op = operationFor(method, url.pathname);
  const headers: Record<string, string> = {};
  if (options.token !== null) headers.authorization = `Bearer ${options.token ?? TOKEN}`;
  let body: string | undefined;
  if (options.raw !== undefined) {
    body = options.raw;
    headers["content-type"] = "application/json";
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
  return { status, body: parsed };
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
        "GET /v1/me",
        "POST /v1/sessions",
        "GET /v1/sessions",
        "GET /v1/sessions/{agent}/{session_id}",
        "DELETE /v1/sessions/{agent}/{session_id}",
        "GET /v1/sessions/{agent}/{session_id}/trace",
        "GET /v1/changes",
      ].sort(),
    );
  });
});

describe("the server honours it", () => {
  it("health and identity", async () => {
    expect((await call("GET", "/healthz", { token: null })).status).toBe(200);
    expect((await call("GET", "/v1/me")).status).toBe(200);
    expect((await call("GET", "/v1/me", { token: null })).status).toBe(401);
  });

  it("a session's life", async () => {
    const stored = await call("POST", "/v1/sessions", {
      body: {
        agent: "claude-code",
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

    // Duplicate, with `shipped`; a chunk with nothing in it; a wrong offset.
    const again = await call("POST", "/v1/sessions", {
      body: {
        agent: "claude-code",
        session_id: "sess1",
        transcript: CLAUDE,
        shipped: { records: records_total, prefix_sha256 },
      },
    });
    // Everything shipped already: nothing new to write.
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ status: "trivial" });
    const duplicate = await call("POST", "/v1/sessions", {
      body: { agent: "claude-code", session_id: "sess1", transcript: CLAUDE },
    });
    expect(duplicate.status).toBe(200);
    expect(duplicate.body).toMatchObject({ status: "duplicate" });
    const chunk = await call("POST", "/v1/sessions", {
      body: {
        agent: "claude-code",
        session_id: "sess1",
        transcript: PROGRESS,
        offset: bytes_total,
      },
    });
    expect(chunk.body).toMatchObject({ status: "trivial" });
    const wrong = await call("POST", "/v1/sessions", {
      body: { agent: "claude-code", session_id: "sess1", transcript: PROGRESS, offset: 5 },
    });
    expect(wrong.status).toBe(409);
    expect(wrong.body).toMatchObject({ error: { expected: bytes_total + PROGRESS.length } });

    // Reads.
    expect((await call("GET", "/v1/sessions")).status).toBe(200);
    expect((await call("GET", "/v1/sessions?limit=5")).status).toBe(200);
    expect((await call("GET", "/v1/sessions?limit=0")).status).toBe(400);
    expect((await call("GET", "/v1/sessions/claude-code/sess1")).status).toBe(200);
    expect((await call("GET", "/v1/sessions/claude-code/sess1/trace")).status).toBe(200);
    expect(
      (await call("GET", `/v1/sessions/claude-code/sess1/trace?hash=${content_hash}`)).status,
    ).toBe(200);
    expect((await call("GET", "/v1/changes")).status).toBe(200);
    expect((await call("GET", "/v1/changes?since=2020-01-01T00:00:00Z&limit=10")).status).toBe(200);
    expect((await call("GET", "/v1/changes?limit=nope")).status).toBe(400);

    // Not there, no trace yet, gone.
    expect((await call("GET", "/v1/sessions/claude-code/nope")).status).toBe(404);
    expect((await call("GET", "/v1/sessions/claude-code/nope/trace")).status).toBe(404);
    expect((await call("DELETE", "/v1/sessions/claude-code/nope")).status).toBe(404);
    const tiny = await call("POST", "/v1/sessions", {
      body: { agent: "claude-code", session_id: "tiny", transcript: SMALL },
    });
    expect(tiny.body).toMatchObject({ status: "trivial" });
    expect((await call("GET", "/v1/sessions/claude-code/tiny/trace")).status).toBe(404);
    expect((await call("DELETE", "/v1/sessions/claude-code/sess1")).status).toBe(200);
    expect((await call("GET", "/v1/sessions/claude-code/sess1/trace")).status).toBe(410);
    expect(
      (
        await call("POST", "/v1/sessions", {
          body: { agent: "claude-code", session_id: "sess1", transcript: CLAUDE },
        })
      ).status,
    ).toBe(422);
  });

  it("refusals", async () => {
    expect(
      (
        await call("POST", "/v1/sessions", {
          token: null,
          body: { agent: "codex", session_id: "x", transcript: "x" },
        })
      ).status,
    ).toBe(401);
    expect((await call("POST", "/v1/sessions", { raw: "{not json" })).status).toBe(400);
    expect(
      (
        await call("POST", "/v1/sessions", {
          body: { agent: "claude-code", session_id: "blank", transcript: "  " },
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

  it("a failing bucket", async () => {
    const broken: Store = {
      url: store.url,
      get: () => Promise.reject(new StoreError("down")),
      put: () => Promise.reject(new StoreError("down")),
      stat: () => Promise.reject(new StoreError("down")),
      delete: () => Promise.reject(new StoreError("down")),
      list: () => Promise.reject(new StoreError("down")),
    };
    const down = createApp({
      store: broken,
      storage: { url: broken.url },
      tokens: [{ token: TOKEN, owner: "acme" }],
    });
    const body = { agent: "claude-code", session_id: "x", transcript: CLAUDE };
    expect((await call("POST", "/v1/sessions", { body, app: down })).status).toBe(502);
    expect((await call("GET", "/v1/sessions", { app: down })).status).toBe(502);
    expect((await call("GET", "/v1/sessions/claude-code/x", { app: down })).status).toBe(502);
    expect((await call("GET", "/v1/sessions/claude-code/x/trace", { app: down })).status).toBe(502);
    expect((await call("DELETE", "/v1/sessions/claude-code/x", { app: down })).status).toBe(502);
    expect((await call("GET", "/v1/changes", { app: down })).status).toBe(502);
  });
});

afterAll(() => {
  // Every response the document describes, this test has seen the server give.
  const unseen = [...documented].filter((d) => !seen.has(d)).sort();
  expect(unseen, "documented but never observed").toEqual([]);
});
