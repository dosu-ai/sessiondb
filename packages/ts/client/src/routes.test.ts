/** The client's calls beyond the session API: other owners' sessions, visibility, tokens, the
 * admin status routes and the two calls made before there is a token. */

import { Forbidden } from "@seshi/model";
import { describe, expect, it } from "vitest";
import { authConfig, exchangeIdToken, HttpSeshi } from "./http";

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Uint8Array | undefined;
}

/** A client over a fake server that answers by route: `routes["GET /v1/x"]` gives the status
 * and body; anything else is 404 `not_found`. */
function routed(routes: Record<string, [number, unknown]>, options: { user?: string } = {}) {
  const seen: Seen[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    seen.push({
      url,
      method,
      headers: init?.headers as Record<string, string>,
      body: init?.body as Uint8Array | undefined,
    });
    const path = new URL(url).pathname;
    const [status, body] = routes[`${method} ${path}`] ?? [404, { error: { code: "not_found" } }];
    return new Response(JSON.stringify(body), { status });
  };
  const db = new HttpSeshi({
    server: "https://seshi.example.com",
    token: "tok",
    fetch,
    ...(options.user ? { user: options.user } : {}),
  });
  return { db, seen, fetch };
}

const sent = (s: Seen | undefined) =>
  s?.body ? JSON.parse(new TextDecoder().decode(s.body)) : undefined;

const param = (s: Seen | undefined, name: string) =>
  new URL(s?.url as string).searchParams.get(name);

describe("reading other owners' sessions (X5.10)", () => {
  it("sends ?owner= on reads, deletes and visibility changes, and leaves it out otherwise", async () => {
    const meta = { owner: "bob", session_id: "s" };
    const { db, seen } = routed({
      "GET /v1/sessions/claude-code/s": [200, meta],
      "GET /v1/sessions/claude-code/s/trace": [200, { records: [] }],
      "DELETE /v1/sessions/claude-code/s": [200, { removed: 2 }],
      "PATCH /v1/sessions/claude-code/s": [200, { ...meta, visibility: "owner" }],
    });
    expect(await db.getSession("claude-code", "s", { owner: "bob" })).toEqual(meta);
    expect(await db.getTrace("claude-code", "s", undefined, "atif", { owner: "bob" })).toEqual({
      records: [],
    });
    expect(await db.tombstone("claude-code", "s", { owner: "bob" })).toEqual({ removed: 2 });
    expect(await db.setVisibility("claude-code", "s", "owner", { owner: "bob" })).toMatchObject({
      visibility: "owner",
    });
    expect(seen.map((s) => param(s, "owner"))).toEqual(["bob", "bob", "bob", "bob"]);
    expect(param(seen[1], "render")).toBe("atif");
    expect(seen[3]?.method).toBe("PATCH");
    expect(sent(seen[3])).toEqual({ visibility: "owner" });
    await db.getSession("claude-code", "s");
    expect(seen.at(-1)?.url).toBe("https://seshi.example.com/v1/sessions/claude-code/s");
  });

  it("is null for a visibility change of a session not there, and refuses a redacted one", async () => {
    const { db } = routed({
      "PATCH /v1/sessions/a/gone": [410, { error: { code: "redacted", message: "redacted" } }],
    });
    expect(await db.setVisibility("a", "nope", "org")).toBeNull();
    await expect(db.setVisibility("a", "gone", "org")).rejects.toMatchObject({
      status: 410,
      code: "redacted",
    });
  });

  it("reads a session's review decisions (F3.8), null for a session not stored", async () => {
    const review = {
      schema: "seshi/review/1",
      n: 0,
      at: "2026-11-14T00:00:00.000Z",
      content_hash: "0".repeat(64),
      decision: "redact",
    };
    const { db, seen } = routed({
      "GET /v1/sessions/claude-code/s/reviews": [200, { reviews: [review] }],
    });
    expect(await db.reviews("claude-code", "s", { owner: "bob" })).toEqual([review]);
    expect(param(seen[0], "owner")).toBe("bob");
    expect(await db.reviews("claude-code", "nope")).toBeNull();
  });

  it("lists the owners", async () => {
    const { db, seen } = routed({
      "GET /v1/owners": [200, { owners: ["alice"], truncated: false }],
    });
    expect(await db.owners({ limit: 5 })).toEqual({ owners: ["alice"], truncated: false });
    expect(param(seen[0], "limit")).toBe("5");
  });
});

describe("tokens (X5.9)", () => {
  const record = { schema: "seshi/token/1", id: "abc", kind: "device", owner: "alice" };

  it("creates, lists, revokes one and revokes an owner's", async () => {
    const { db, seen } = routed({
      "POST /v1/tokens": [201, { token: "seshi_x", record }],
      "GET /v1/tokens": [200, { tokens: [record] }],
      "DELETE /v1/tokens/abc": [200, { token: { ...record, revoked: true } }],
      "POST /v1/tokens/revoke": [200, { revoked: [record] }],
    });
    expect(await db.createToken({ kind: "device", owner: "alice", label: "mbp" })).toEqual({
      token: "seshi_x",
      record,
    });
    expect(sent(seen[0])).toEqual({ kind: "device", owner: "alice", label: "mbp" });
    expect(await db.listTokens({ owner: "alice", kind: "device", all: true })).toEqual([record]);
    expect([param(seen[1], "owner"), param(seen[1], "kind"), param(seen[1], "all")]).toEqual([
      "alice",
      "device",
      "true",
    ]);
    await db.listTokens();
    expect(new URL(seen[2]?.url as string).search).toBe("");
    expect(await db.revokeToken("abc")).toMatchObject({ revoked: true });
    expect(await db.revokeToken("nope")).toBeNull();
    expect(await db.revokeOwnerTokens("alice", "device")).toEqual([record]);
    expect(sent(seen.at(-1))).toEqual({ owner: "alice", kind: "device" });
  });

  it("refuses what the server refuses", async () => {
    const { db } = routed({
      "POST /v1/tokens": [403, { error: { code: "forbidden", message: "needs tokens:admin" } }],
      "GET /v1/tokens": [401, { error: { code: "unauthorized", message: "no" } }],
    });
    await expect(db.createToken({ kind: "org" })).rejects.toBeInstanceOf(Forbidden);
    await expect(db.listTokens()).rejects.toMatchObject({ status: 401 });
  });
});

describe("admin status (X7.5)", () => {
  const source = { id: "dd", type: "datadog", dropped: 0, failed: 1, health: {} };

  it("reads jobs, sources, one source and its records", async () => {
    const { db, seen } = routed({
      "GET /v1/admin/jobs": [200, { worker: { state: "running" } }],
      "GET /v1/admin/sources": [200, { sources: [source] }],
      "GET /v1/admin/sources/dd": [200, source],
      "GET /v1/admin/sources/dd/failed": [
        200,
        { source: "dd", kind: "failed", records: [], truncated: false },
      ],
    });
    expect(await db.jobs()).toMatchObject({ worker: { state: "running" } });
    expect(await db.sources({ days: 3 })).toEqual([source]);
    expect(param(seen[1], "days")).toBe("3");
    expect(await db.source("dd")).toEqual(source);
    expect(
      await db.records("failed", "dd", { since: "2026-11-01T00:00:00.000Z", limit: 5 }),
    ).toMatchObject({ kind: "failed" });
    expect([param(seen[3], "since"), param(seen[3], "limit")]).toEqual([
      "2026-11-01T00:00:00.000Z",
      "5",
    ]);
  });

  it("is null for an unknown source, and refuses a route the server lacks", async () => {
    const unknown: [number, unknown] = [
      404,
      { error: { code: "unknown_source", message: "no source" } },
    ];
    const { db } = routed({
      "GET /v1/admin/sources/zz": unknown,
      "GET /v1/admin/sources/zz/dropped": unknown,
    });
    expect(await db.source("zz")).toBeNull();
    expect(await db.records("dropped", "zz")).toBeNull();
    // An older server without the route: not "unknown source".
    await expect(db.records("failed", "zz")).rejects.toMatchObject({ status: 404 });
  });
});

describe("before there is a token (X5.7)", () => {
  it("reads the auth config and exchanges an ID token, sending no credential", async () => {
    const { seen, fetch } = routed({
      "GET /v1/auth/config": [200, { org_key: true, oidc: null }],
      "POST /v1/auth/exchange": [200, { session_token: "jwt", owner: "alice" }],
    });
    const transport = { server: "https://seshi.example.com/", fetch };
    expect(await authConfig(transport)).toEqual({ org_key: true, oidc: null });
    expect(
      await exchangeIdToken(transport, { id_token: "id", nonce: "n", machine: { id: "m1" } }),
    ).toMatchObject({ session_token: "jwt" });
    expect(seen.map((s) => s.headers.authorization)).toEqual([undefined, undefined]);
    expect(seen[1]?.url).toBe("https://seshi.example.com/v1/auth/exchange");
    expect(sent(seen[1])).toEqual({ id_token: "id", nonce: "n", machine: { id: "m1" } });
  });

  it("refuses an ID token the server does not accept, or a server without the route", async () => {
    const { fetch } = routed({
      "POST /v1/auth/exchange": [401, { error: { code: "unauthorized", message: "bad token" } }],
    });
    const transport = { server: "https://seshi.example.com", fetch };
    await expect(exchangeIdToken(transport, { id_token: "x" })).rejects.toMatchObject({
      status: 401,
    });
    await expect(authConfig(transport)).rejects.toMatchObject({ status: 404 });
  });

  it("sends X-Seshi-User with the org key", async () => {
    const { db, seen } = routed({ "GET /v1/me": [200, { owner: "alice" }] }, { user: "alice" });
    await db.me();
    expect(seen[0]?.headers["x-seshi-user"]).toBe("alice");
  });
});

describe("every owner's change feed", () => {
  it("reads GET /v1/changes/all with its cursor, and maps a refusal to Forbidden", async () => {
    const page = { entries: [], truncated: false, through: "2026-11-14T09:00:00.000Z" };
    const { db, seen } = routed({ "GET /v1/changes/all": [200, page] });
    expect(await db.allChanges({ after: "c1", limit: 50 })).toEqual(page);
    expect(param(seen[0], "after")).toBe("c1");
    expect(param(seen[0], "limit")).toBe("50");
    expect(param(seen[0], "owner")).toBeNull();
    const refused = routed({
      "GET /v1/changes/all": [403, { error: { code: "forbidden", message: "no" } }],
    });
    await expect(refused.db.allChanges()).rejects.toBeInstanceOf(Forbidden);
  });
});

describe("the runtime config calls", () => {
  it("send their conditions and read their refusals", async () => {
    const { db, seen } = routed({
      "PUT /v1/admin/sources/cursor-a": [
        201,
        { id: "cursor-a", etag: "e1", source: {}, version: "v" },
      ],
      "PATCH /v1/admin/config": [
        412,
        { error: { code: "precondition_failed", message: "it changed" } },
      ],
      "PUT /v1/admin/config/files/packs%2Forg.json": [
        422,
        { error: { code: "invalid", message: "bad", problems: ["a", "b"] } },
      ],
      "DELETE /v1/admin/sources/gone": [404, { error: { code: "unknown_source", message: "no" } }],
    });
    await db.putSource("cursor-a", { type: "otlp" }, { create: true });
    expect(seen[0]?.headers["if-none-match"]).toBe("*");
    await expect(
      db.patchRuntimeConfig({ set: { "filter.min_chars": 1 } }, { ifMatch: "e0" }),
    ).rejects.toMatchObject({
      name: "PreconditionFailed",
    });
    expect(seen[1]?.headers["if-match"]).toBe('"e0"');
    await expect(db.putConfigFile("packs/org.json", "{}")).rejects.toMatchObject({
      name: "ConfigRejected",
      problems: ["a", "b"],
    });
    expect(seen[2]?.headers["content-type"]).toBe("application/octet-stream");
    expect(await db.deleteSource("gone")).toBeNull();
    // A server without the route is not "already gone".
    await expect(db.deleteConfigFile("packs/x.json")).rejects.toMatchObject({ status: 404 });
  });
});
