/** The SDK's HTTP backend against this server: the same calls, over `HttpSessionDB` through
 * `createApp` and over `StoreSessionDB` on a store, give the same results and throw the same
 * errors. This is the contract between the two halves of the client: a route or a mapping
 * that drifts fails here. */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FsStore,
  HttpSessionDB,
  OffsetMismatch,
  ServerError,
  type SessionDB,
  SessionRejected,
  StoreError,
  StoreSessionDB,
  type StoreSessionResult,
} from "@dosu-ai/sessiondb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app";

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
/** A chunk with no records in it. */
const PROGRESS = `${JSON.stringify({ type: "progress", uuid: "p1" })}\n`;

/** The result of an upload that wrote a trace; the test fails on any other. */
function stored(result: StoreSessionResult): Extract<StoreSessionResult, { content_hash: string }> {
  if (!("content_hash" in result)) throw new Error(`expected a trace, got ${result.status}`);
  return result;
}

let dir: string;
let direct: SessionDB;
let http: SessionDB;
let store: FsStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sessiondb-http-"));
  // The same clock on both sides, so the two stores come out identical.
  const now = () => new Date("2026-10-30T17:00:00.000Z");
  direct = new StoreSessionDB({ store: new FsStore(join(dir, "direct")), owner: "acme", now });
  store = new FsStore(join(dir, "server"));
  const app = createApp({
    store,
    storage: { url: store.url },
    tokens: [{ token: TOKEN, owner: "acme" }],
    now,
  });
  http = new HttpSessionDB({
    server: "http://sessiondb.test",
    token: TOKEN,
    fetch: (input, init) => app.fetch(new Request(input, init)),
    // Small enough that the transcript goes gzipped, exercising that path too.
    gzipFrom: 1024,
  });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** The same calls through both backends must agree. */
async function both<T>(call: (db: SessionDB) => Promise<T>): Promise<T> {
  const [a, b] = await Promise.all([call(direct), call(http)]);
  expect(b).toEqual(a);
  return a;
}

describe("the two backends agree", () => {
  it("on identity", async () => {
    expect(await http.me()).toEqual({ owner: "acme", storage: { url: store.url } });
  });

  it("on a session's life: store, read, chunk, list, changes, tombstone", async () => {
    const first = stored(
      await both((db) =>
        db.ingest({
          agent: "claude-code",
          session_id: "sess1",
          transcript: CLAUDE,
          project: "github.com/acme/widget",
          branch: "main",
        }),
      ),
    );

    const again = await both((db) =>
      db.ingest({ agent: "claude-code", session_id: "sess1", transcript: CLAUDE }),
    );
    expect(again.status).toBe("duplicate");

    const chunk = await both((db) =>
      db.ingest({
        agent: "claude-code",
        session_id: "sess1",
        transcript: PROGRESS,
        offset: first.bytes_total,
      }),
    );
    expect(chunk.status).toBe("trivial");
    expect(chunk.bytes_total).toBe(first.bytes_total + PROGRESS.length);

    const metadata = await both((db) => db.getSession("claude-code", "sess1"));
    expect(metadata?.head).toBe(first.content_hash);
    expect(metadata?.raw).toHaveLength(2);

    const trace = await both((db) => db.getTrace("claude-code", "sess1"));
    expect(trace?.content_hash).toBe(first.content_hash);
    await both((db) => db.getTrace("claude-code", "sess1", first.content_hash));

    const page = await both((db) => db.listSessions({ limit: 10 }));
    expect(page.sessions).toHaveLength(1);

    const changes = await both((db) => db.changes());
    expect(changes.entries).toHaveLength(1);
    await both((db) => db.changes({ after: changes.cursor }));
    await both((db) => db.changes({ since: "2026-10-30T16:00:00.000Z" }));

    expect(await both((db) => db.tombstone("claude-code", "sess1"))).toEqual({ removed: 3 });
    await both((db) => db.getTrace("claude-code", "sess1"));
    expect(await both((db) => db.getSession("claude-code", "sess1"))).toMatchObject({
      status: "redacted",
    });
  });

  it("on a trivial session: stored raw, no trace", async () => {
    const result = await both((db) =>
      db.ingest({ agent: "claude-code", session_id: "tiny", transcript: SMALL }),
    );
    expect(result.status).toBe("trivial");
    expect(await both((db) => db.getTrace("claude-code", "tiny"))).toBeNull();
  });

  it("on what is not there", async () => {
    expect(await both((db) => db.getSession("claude-code", "nope"))).toBeNull();
    expect(await both((db) => db.getTrace("claude-code", "nope"))).toBeNull();
    expect(await both((db) => db.tombstone("claude-code", "nope"))).toBeNull();
    expect(await both((db) => db.listSessions())).toMatchObject({ sessions: [] });
  });
});

describe("the HTTP backend throws what the pipeline throws", () => {
  it("OffsetMismatch, with where the log ends", async () => {
    const first = await http.ingest({ agent: "claude-code", session_id: "s", transcript: CLAUDE });
    const wrong = http.ingest({
      agent: "claude-code",
      session_id: "s",
      transcript: PROGRESS,
      offset: first.bytes_total + 7,
    });
    await expect(wrong).rejects.toBeInstanceOf(OffsetMismatch);
    await expect(wrong).rejects.toMatchObject({
      offset: first.bytes_total + 7,
      expected: first.bytes_total,
    });
  });

  it("SessionRejected with the server's code", async () => {
    await expect(
      http.ingest({ agent: "claude-code", session_id: "blank", transcript: "  " }),
    ).rejects.toMatchObject({ name: "SessionRejected", code: "empty" });
    await expect(
      http.ingest({ agent: "nope" as never, session_id: "x", transcript: CLAUDE }),
    ).rejects.toMatchObject({ name: "SessionRejected", code: "unsupported_agent" });

    await http.ingest({ agent: "claude-code", session_id: "gone", transcript: CLAUDE });
    await http.tombstone("claude-code", "gone");
    const again = http.ingest({ agent: "claude-code", session_id: "gone", transcript: CLAUDE });
    await expect(again).rejects.toBeInstanceOf(SessionRejected);
    await expect(again).rejects.toMatchObject({ code: "redacted" });
  });

  it("ServerError for the rest", async () => {
    const wrong = new HttpSessionDB({
      server: "http://sessiondb.test/",
      token: "sdb_wrong-0123456789abcdef",
      fetch: (input, init) =>
        createApp({
          store,
          storage: { url: store.url },
          tokens: [{ token: TOKEN, owner: "acme" }],
        }).fetch(new Request(input, init)),
    });
    const denied = wrong.me();
    await expect(denied).rejects.toBeInstanceOf(ServerError);
    await expect(denied).rejects.toMatchObject({ status: 401, code: "unauthorized" });
  });
});

describe("the request itself", () => {
  it("is a string URL with a User-Agent, the SDK's own unless the program names itself", async () => {
    const seen: { input: unknown; agent: string | null }[] = [];
    const capture = (input: string, init?: RequestInit) => {
      seen.push({ input, agent: new Headers(init?.headers).get("user-agent") });
      return Promise.resolve(Response.json({ owner: "acme", storage: { url: store.url } }));
    };
    await new HttpSessionDB({ server: "http://s.test", token: TOKEN, fetch: capture }).me();
    await new HttpSessionDB({
      server: "http://s.test",
      token: TOKEN,
      fetch: capture,
      userAgent: "dosu-cli/1.0.0",
    }).me();
    expect(seen[0]?.input).toBe("http://s.test/v1/me");
    expect(seen[0]?.agent).toMatch(/^@dosu-ai\/sessiondb\/\d/);
    expect(seen[1]?.agent).toBe("dosu-cli/1.0.0");
  });

  it("gives up after timeoutMs as a StoreError", async () => {
    const slow = new HttpSessionDB({
      server: "http://s.test",
      token: TOKEN,
      timeoutMs: 20,
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    });
    const late = slow.me();
    await expect(late).rejects.toBeInstanceOf(StoreError);
    await expect(late).rejects.toThrow(/cannot reach http:\/\/s.test: .*timed out/i);
  });
});

describe("responses that are not the server's", () => {
  const respond = (status: number, text: string) => (_input: string) =>
    Promise.resolve(new Response(text, { status }));

  it("a proxy's 502 page is a StoreError by status, its 504 a ServerError", async () => {
    const down = new HttpSessionDB({
      server: "http://s.test",
      token: TOKEN,
      fetch: respond(502, "<html>bad gateway</html>"),
    });
    await expect(down.me()).rejects.toBeInstanceOf(StoreError);
    await expect(down.me()).rejects.toThrow("HTTP 502");
    const slow = new HttpSessionDB({
      server: "http://s.test",
      token: TOKEN,
      fetch: respond(504, "timeout"),
    });
    await expect(slow.me()).rejects.toMatchObject({
      status: 504,
      code: "unknown",
      message: "HTTP 504",
    });
  });

  it("a 200 that is not JSON is bad_response", async () => {
    const odd = new HttpSessionDB({
      server: "http://s.test",
      token: TOKEN,
      fetch: respond(200, "<html>login</html>"),
    });
    await expect(odd.me()).rejects.toMatchObject({ status: 200, code: "bad_response" });
  });
});

describe("a 409 that is not an offset mismatch", () => {
  it("is a ServerError with the server's code", async () => {
    const db = new HttpSessionDB({
      server: "http://s.test",
      token: TOKEN,
      fetch: () =>
        Promise.resolve(
          Response.json(
            { error: { code: "no_storage", message: "link a bucket" } },
            { status: 409 },
          ),
        ),
    });
    const refused = db.ingest({ agent: "claude-code", session_id: "x", transcript: CLAUDE });
    await expect(refused).rejects.toBeInstanceOf(ServerError);
    await expect(refused).rejects.toMatchObject({ status: 409, code: "no_storage" });
  });
});
