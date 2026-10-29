import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type App, createApp } from "./app";
import { FsStore } from "./store/fs";
import { archiveId, keys } from "./store/layout";
import { gunzipJson, readMetadata } from "./store/publish";

const TOKEN = "sdb_test-token-0123456789abcdef";
const OTHER = "sdb_other-token-0123456789abcdef";
/** The fixture is a greeting-sized session; the server calls those trivial. */
const SMALL = readFileSync(
  join(import.meta.dirname, "../testdata/transcripts/claude-basic.claude-code.jsonl"),
  "utf8",
);
/** The same session with an answer long enough to be worth storing. */
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

/** A Claude Code session in the Datadog Trajectory daemon's on-disk format, finished. */
const STREAM_SMALL = readFileSync(
  join(
    import.meta.dirname,
    "../testdata/transcripts/datadog-claude-session.datadog-trajectory.jsonl",
  ),
  "utf8",
);
const STREAM_SESSION = "0d6f1c2e-7b1a-4c3e-9f2d-5a8b7c6d4e3f";
/** The same stream with an answer long enough to be worth storing, before its session_end. */
const STREAM = (() => {
  const lines = STREAM_SMALL.trim().split("\n");
  const end = lines.pop() as string;
  const answer = JSON.stringify({
    sequence_number: 17,
    client_source: "claude-code",
    session_id: STREAM_SESSION,
    event_type: "agent_message",
    text: `The auth flow: ${"details ".repeat(400)}`,
    timestamp: "2026-10-29T20:27:38.000Z",
    turn_id: 2,
  });
  return `${[...lines, answer, end].join("\n")}\n`;
})();

let dir: string;
let store: FsStore;
let app: App;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sessiondb-server-"));
  store = new FsStore(`file://${join(dir, "bucket")}`);
  app = createApp({
    store,
    storage: { url: store.url },
    // Two people: acme's token and globex's. Each sees only its own folder.
    tokens: [
      { token: TOKEN, owner: "acme" },
      { token: OTHER, owner: "globex" },
    ],
    client: "sessiondb-server/test",
  });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function call(
  method: string,
  path: string,
  options: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Response> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  let body: BodyInit | undefined;
  if (options.body !== undefined) {
    if (options.body instanceof Uint8Array) {
      body = new Uint8Array(options.body) as Uint8Array<ArrayBuffer>;
    } else {
      body = JSON.stringify(options.body);
      headers["content-type"] = "application/json";
    }
  }
  return app.fetch(new Request(`http://sessiondb.test${path}`, { method, headers, body }));
}

describe("health and routing", () => {
  it("answers /healthz without auth", async () => {
    const res = await call("GET", "/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it("404s unknown paths and 405s wrong methods", async () => {
    expect((await call("GET", "/nope")).status).toBe(404);
    expect((await call("PATCH", "/healthz")).status).toBe(405);
  });
});

describe("auth", () => {
  it("accepts any configured token, and nothing else", async () => {
    expect((await call("GET", "/v1/me")).status).toBe(401);
    expect((await call("GET", "/v1/me", { token: "sdb_wrong-0123456789abcdef" })).status).toBe(401);
    expect((await call("GET", "/v1/me", { token: TOKEN.slice(0, -1) })).status).toBe(401);
    for (const [token, owner] of [
      [TOKEN, "acme"],
      [OTHER, "globex"],
    ]) {
      const res = await call("GET", "/v1/me", { token });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ owner, storage: { url: store.url } });
    }
  });

  it("shows a token only its own sessions", async () => {
    const stored = await call("POST", "/v1/sessions", {
      token: TOKEN,
      body: { agent: "claude-code", session_id: "mine", transcript: CLAUDE },
    });
    expect(stored.status).toBe(201);
    expect((await call("GET", "/v1/sessions/claude-code/mine", { token: TOKEN })).status).toBe(200);

    // globex: the session is not there, its list and change log are empty, it cannot delete it.
    const other = { token: OTHER };
    expect((await call("GET", "/v1/sessions/claude-code/mine", other)).status).toBe(404);
    expect((await call("GET", "/v1/sessions/claude-code/mine/trace", other)).status).toBe(404);
    expect((await call("DELETE", "/v1/sessions/claude-code/mine", other)).status).toBe(404);
    expect(await (await call("GET", "/v1/sessions", other)).json()).toMatchObject({ sessions: [] });
    expect(await (await call("GET", "/v1/changes", other)).json()).toMatchObject({ entries: [] });
    const archive = archiveId("acme", "claude-code", "mine");
    expect((await call("GET", `/v1/objects/${keys.metadata("acme", archive)}`, other)).status).toBe(
      403,
    );
    // And acme still has it: globex's 404s touched nothing.
    expect((await call("GET", "/v1/sessions/claude-code/mine", { token: TOKEN })).status).toBe(200);
  });

  it("refuses to start without a token", () => {
    expect(() => createApp({ store, storage: { url: store.url }, tokens: [] })).toThrow(
      "at least one token",
    );
  });
});

describe("sessions", () => {
  it("needs a token", async () => {
    expect((await call("POST", "/v1/sessions", { body: {} })).status).toBe(401);
  });

  it("normalizes, redacts and stores a raw transcript, with the raw part beside it", async () => {
    const token = TOKEN;
    const res = await call("POST", "/v1/sessions", {
      token,
      body: {
        agent: "claude-code",
        session_id: "sess1",
        project: "github.com/acme/widget",
        branch: "main",
        transcript: CLAUDE,
      },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      status: string;
      archive_id: string;
      content_hash: string;
      records: number;
      raw: { status: string; part: number };
    };
    expect(body.status).toBe("stored");
    expect(body.raw).toEqual({ status: "stored", part: 0 });

    const archive = archiveId("acme", "claude-code", "sess1");
    expect(body.archive_id).toBe(archive);
    const metadata = await readMetadata(store, "acme", archive);
    expect(metadata).toMatchObject({
      agent: "claude-code",
      session_id: "sess1",
      project: "github.com/acme/widget",
      branch: "main",
      status: "stored",
      head: body.content_hash,
    });
    expect(metadata?.raw).toHaveLength(1);

    // Nothing unredacted reached the bucket: the trace and the raw part are both scrubbed.
    const trace = gunzipJson<{ records: unknown[]; metadata: { normalizer?: unknown } }>(
      (await store.get(keys.trace("acme", archive, body.content_hash))) as Uint8Array,
    );
    // The trace says what normalized it, so a later pass can pick out what to redo.
    expect(trace.metadata.normalizer).toEqual({
      name: "sessiondb-server",
      version: expect.stringMatching(/^\d+\.\d+\.\d+\+trajectory\.\d+\.\d+\.\d+$/),
    });
    const traceText = JSON.stringify(trace);
    expect(traceText).not.toContain("hunter2secretvalue42");
    expect(traceText).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz012345");
    const rawBytes = (await store.get(keys.raw("acme", archive, 0, "jsonl"))) as Uint8Array;
    const rawText = new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(rawBytes)));
    expect(rawText).not.toContain("hunter2secretvalue42");
    expect(rawText).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz012345");

    // The same transcript again is a duplicate, not a second trace.
    const again = await call("POST", "/v1/sessions", {
      token,
      body: { agent: "claude-code", session_id: "sess1", transcript: CLAUDE },
    });
    expect(again.status).toBe(200);
    expect((await again.json()).status).toBe("duplicate");

    // The change feed has the one publish.
    const changes = await call("GET", "/v1/changes", { token });
    const feed = (await changes.json()) as { entries: { entry: { kind: string } }[] };
    expect(feed.entries.map((e) => e.entry.kind)).toEqual(["published"]);
  });

  it("accepts a gzipped body; the raw copy is always stored, and stored first", async () => {
    const token = TOKEN;
    const payload = JSON.stringify({
      agent: "claude-code",
      session_id: "sess2",
      transcript: CLAUDE,
    });
    const res = await call("POST", "/v1/sessions", {
      token,
      body: Bun.gzipSync(new TextEncoder().encode(payload)),
      headers: { "content-type": "application/json", "content-encoding": "gzip" },
    });
    expect(res.status).toBe(201);
    expect((await res.json()).raw).toEqual({ status: "stored", part: 0 });
    const metadata = await readMetadata(store, "acme", archiveId("acme", "claude-code", "sess2"));
    expect(metadata?.raw).toMatchObject([{ part: 0, format: "jsonl" }]);
    // The raw part is older than, or as old as, the trace made from it.
    expect(
      metadata?.raw[0]?.created_at.localeCompare(metadata?.traces[0]?.created_at ?? ""),
    ).toBeLessThanOrEqual(0);
  });

  it("ships a resumed session's tail as a continuation", async () => {
    const token = TOKEN;
    const first = await call("POST", "/v1/sessions", {
      token,
      body: { agent: "claude-code", session_id: "sess3", transcript: CLAUDE },
    });
    expect(first.status).toBe(201);
    const shipped = (await first.json()) as {
      records: number;
      records_total: number;
      prefix_sha256: string;
    };

    // The session continues: another turn lands in the same log.
    const resumed = `${CLAUDE.trim()}\n${JSON.stringify({
      type: "user",
      uuid: "u2",
      timestamp: "2026-09-01T00:10:00.000Z",
      sessionId: "sess1",
      message: { role: "user", content: "and the tests?" },
    })}\n${JSON.stringify({
      type: "assistant",
      uuid: "a9",
      timestamp: "2026-09-01T00:10:05.000Z",
      sessionId: "sess1",
      message: {
        role: "assistant",
        model: "claude-x",
        content: [{ type: "text", text: `Green. ${"All of them pass. ".repeat(150)}` }],
      },
    })}\n`;

    // The client sends back what the last answer told it; the planner then writes only the tail.
    const second = await call("POST", "/v1/sessions", {
      token,
      body: {
        agent: "claude-code",
        session_id: "sess3",
        transcript: resumed,
        shipped: { records: shipped.records_total, prefix_sha256: shipped.prefix_sha256 },
      },
    });
    expect(second.status).toBe(201);
    const tail = (await second.json()) as {
      records: number;
      records_total: number;
      prefix_sha256: string;
    };
    expect(tail.records_total).toBe(shipped.records_total + 2);
    expect(tail.prefix_sha256).not.toBe(shipped.prefix_sha256);
    // Meta record plus the two new ones went, not the whole session again.
    expect(tail.records).toBe(3);
    const metadata = await readMetadata(store, "acme", archiveId("acme", "claude-code", "sess3"));
    expect(metadata?.traces).toHaveLength(2);
    expect(metadata?.traces[1]?.continuation).toEqual({
      from_record: shipped.records_total,
      prefix_sha256: shipped.prefix_sha256,
    });
    // The raw part now holds the whole resumed log, replaced in place.
    expect(metadata?.raw).toHaveLength(1);
  });

  it("rejects what cannot be stored with 422 and a code", async () => {
    const token = TOKEN;
    const code = async (body: unknown) =>
      (
        (await (await call("POST", "/v1/sessions", { token, body })).json()) as {
          error: { code: string };
        }
      ).error.code;
    expect(await code({ agent: "vim", session_id: "s", transcript: "x" })).toBe(
      "unsupported_agent",
    );
    // The source name is the only spelling: a harness alias would make a second archive.
    expect(await code({ agent: "claude", session_id: "s", transcript: CLAUDE })).toBe(
      "unsupported_agent",
    );
    expect(await code({ agent: "claude-code", session_id: "s", transcript: "   " })).toBe("empty");
    expect(
      await code({ agent: "claude-code", session_id: "s", transcript: CLAUDE, format: "xml" }),
    ).toBe("bad_field");
    expect(await code({ agent: "claude-code", session_id: "s" })).toBe("missing_field");
    expect(
      await code({
        agent: "claude-code",
        session_id: "s",
        transcript: CLAUDE,
        shipped: { x: 1 },
      }),
    ).toBe("bad_field");
  });

  it("reads back metadata, the trace and the list, and tombstones", async () => {
    const token = TOKEN;
    await call("POST", "/v1/sessions", {
      token,
      body: { agent: "claude-code", session_id: "sess4", transcript: CLAUDE },
    });

    const meta = await call("GET", "/v1/sessions/claude-code/sess4", { token });
    expect(meta.status).toBe(200);
    const metadata = (await meta.json()) as { head: string };

    const trace = await call("GET", "/v1/sessions/claude-code/sess4/trace", { token });
    expect(trace.status).toBe(200);
    expect(await trace.json()).toMatchObject({ content_hash: metadata.head });

    const list = await call("GET", "/v1/sessions?limit=10", { token });
    expect((await list.json()).sessions).toHaveLength(1);

    const gone = await call("DELETE", "/v1/sessions/claude-code/sess4", { token });
    expect(gone.status).toBe(200);
    expect((await gone.json()).removed).toBeGreaterThan(0);
    expect((await call("GET", "/v1/sessions/claude-code/sess4/trace", { token })).status).toBe(410);
    const archive = archiveId("acme", "claude-code", "sess4");
    expect(await store.get(keys.trace("acme", archive, metadata.head))).toBeNull();
    expect((await call("DELETE", "/v1/sessions/claude-code/nope", { token })).status).toBe(404);

    // A redacted session cannot come back.
    const retry = await call("POST", "/v1/sessions", {
      token,
      body: { agent: "claude-code", session_id: "sess4", transcript: CLAUDE },
    });
    expect(retry.status).toBe(422);
    expect((await retry.json()).error.code).toBe("redacted");
  });

  it("serves the owner's own objects read-only over HTTP", async () => {
    const token = TOKEN;
    await call("POST", "/v1/sessions", {
      token,
      body: { agent: "claude-code", session_id: "sess5", transcript: CLAUDE },
    });
    const archive = archiveId("acme", "claude-code", "sess5");

    const list = await call(
      "GET",
      `/v1/objects?prefix=${encodeURIComponent(keys.sessions("acme"))}`,
      {
        token,
      },
    );
    expect(list.status).toBe(200);
    const page = (await list.json()) as { keys: string[]; truncated: boolean };
    expect(page.keys).toContain(keys.metadata("acme", archive));

    const get = await call("GET", `/v1/objects/${keys.metadata("acme", archive)}`, { token });
    expect(get.status).toBe(200);
    expect(get.headers.get("content-type")).toBe("application/octet-stream");
    expect(JSON.parse(await get.text())).toMatchObject({ session_id: "sess5" });

    const head = await call("HEAD", `/v1/objects/${keys.metadata("acme", archive)}`, { token });
    expect(head.status).toBe(200);
    expect(Number(head.headers.get("content-length"))).toBeGreaterThan(0);
    expect((await call("HEAD", "/v1/objects/owners/acme/nope", { token })).status).toBe(404);

    // Another owner's keys, and the layout marker, are off limits.
    expect((await call("GET", "/v1/objects/owners/globex/sessions/x", { token })).status).toBe(403);
    expect((await call("GET", "/v1/objects/sessionstorage.json", { token })).status).toBe(403);
    expect((await call("GET", "/v1/objects?prefix=owners/", { token })).status).toBe(403);
  });

  it("calls a greeting-sized session trivial: raw stored, no trace, no change entry", async () => {
    const token = TOKEN;
    const res = await call("POST", "/v1/sessions", {
      token,
      body: { agent: "claude-code", session_id: "tiny", transcript: SMALL },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "trivial",
      records_total: expect.any(Number),
      prefix_sha256: expect.any(String),
      raw: { status: "stored", part: 0 },
    });
    const metadata = await readMetadata(store, "acme", archiveId("acme", "claude-code", "tiny"));
    expect(metadata).toMatchObject({ status: "stored", traces: [], raw: [{ part: 0 }] });
    expect(metadata?.head).toBeUndefined();
    expect(await (await call("GET", "/v1/changes", { token })).json()).toMatchObject({
      entries: [],
    });
    // The session is there, raw only; asking for its trace says so.
    const trace = await call("GET", "/v1/sessions/claude-code/tiny/trace", { token });
    expect(trace.status).toBe(404);
    expect((await trace.json()).error.code).toBe("no_trace");
  });

  it("prefers the branch the transcript recorded over the client's", async () => {
    const token = TOKEN;
    await call("POST", "/v1/sessions", {
      token,
      body: { agent: "claude-code", session_id: "b1", transcript: CLAUDE, branch: "from-client" },
    });
    // The fixture's first record carries gitBranch: main.
    const metadata = await readMetadata(store, "acme", archiveId("acme", "claude-code", "b1"));
    expect(metadata?.branch).toBe("main");
  });

  it("writes only what a fork added past the history it copied from its parent", async () => {
    const token = TOKEN;
    const parent = await call("POST", "/v1/sessions", {
      token,
      body: { agent: "claude-code", session_id: "parent", transcript: CLAUDE },
    });
    expect(parent.status).toBe(201);
    const parentBody = (await parent.json()) as { records_total: number };

    // The fork's log is the parent's whole log plus its own turn.
    const forkLog = `${CLAUDE.trim()}\n${JSON.stringify({
      type: "user",
      uuid: "f1",
      timestamp: "2026-09-01T01:00:00.000Z",
      sessionId: "fork",
      message: { role: "user", content: "now the fork's own question" },
    })}\n${JSON.stringify({
      type: "assistant",
      uuid: "f2",
      timestamp: "2026-09-01T01:00:05.000Z",
      sessionId: "fork",
      message: {
        role: "assistant",
        model: "claude-x",
        content: [{ type: "text", text: `Its own answer. ${"More. ".repeat(400)}` }],
      },
    })}\n`;
    const fork = await call("POST", "/v1/sessions", {
      token,
      body: {
        agent: "claude-code",
        session_id: "fork",
        transcript: forkLog,
        parent_session_id: "parent",
        fork_of: "parent",
      },
    });
    expect(fork.status).toBe(201);
    const forkBody = (await fork.json()) as { records: number; records_total: number };
    expect(forkBody.records_total).toBe(parentBody.records_total + 2);
    // Meta plus the fork's two own records; the copied history was the parent's to ship.
    expect(forkBody.records).toBe(3);
    const metadata = await readMetadata(store, "acme", archiveId("acme", "claude-code", "fork"));
    expect(metadata?.parent_session_id).toBe("parent");
    expect(metadata?.traces[0]?.continuation).toEqual({
      from_record: parentBody.records_total,
      prefix_sha256: expect.any(String),
    });

    // A fork whose parent was never stored ships in full.
    const orphan = await call("POST", "/v1/sessions", {
      token,
      body: { agent: "claude-code", session_id: "orphan", transcript: forkLog, fork_of: "nope" },
    });
    expect(((await orphan.json()) as { records: number }).records).toBe(
      parentBody.records_total + 2,
    );
  });
});

describe("Datadog Trajectory format", () => {
  // A session file in the Datadog Trajectory daemon's on-disk format, posted like any other
  // transcript. The format is one more input the normalizer turns into trajectory-v1.
  const post = (transcript: string, sessionId = STREAM_SESSION) =>
    call("POST", "/v1/sessions", {
      token: TOKEN,
      body: { agent: "datadog-trajectory", session_id: sessionId, transcript },
    });

  it("stores the session under datadog-trajectory, raw first, then the trace", async () => {
    const res = await post(STREAM);
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      status: string;
      archive_id: string;
      content_hash: string;
      raw: { status: string; part: number };
    };
    expect(body.status).toBe("stored");
    expect(body.raw).toEqual({ status: "stored", part: 0 });

    const archive = archiveId("acme", "datadog-trajectory", STREAM_SESSION);
    expect(body.archive_id).toBe(archive);
    const metadata = await readMetadata(store, "acme", archive);
    expect(metadata).toMatchObject({
      agent: "datadog-trajectory",
      source: "datadog-trajectory:claude-code",
      session_id: STREAM_SESSION,
      branch: "feature/auth",
      status: "stored",
      head: body.content_hash,
      raw_format: "jsonl",
    });
    expect(metadata?.parent_session_id).toBeUndefined();

    const trace = gunzipJson<{ events: { role: string }[] }>(
      (await store.get(keys.trace("acme", archive, body.content_hash))) as Uint8Array,
    );
    expect(trace.events.map((e) => e.role)).toContain("tool_call");
    expect(JSON.stringify(trace)).not.toContain("hunter2secretvalue42");
    const rawBytes = (await store.get(keys.raw("acme", archive, 0, "jsonl"))) as Uint8Array;
    const rawText = new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(rawBytes)));
    expect(rawText).toContain('"event_type":"session_end"');
    expect(rawText).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz012345");

    // The same file again changes nothing.
    const again = await post(STREAM);
    expect(again.status).toBe(200);
    expect((await again.json()).status).toBe("duplicate");
    expect((await readMetadata(store, "acme", archive))?.traces).toHaveLength(1);

    // And the session reads back through the ordinary routes.
    const read = await call("GET", `/v1/sessions/datadog-trajectory/${STREAM_SESSION}/trace`, {
      token: TOKEN,
    });
    expect(read.status).toBe(200);
  });

  it("calls a greeting-sized session trivial", async () => {
    const res = await post(STREAM_SMALL);
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("trivial");
  });

  it("rejects a file that is not a session stream, after storing it raw", async () => {
    const res = await post('{"event_type":"user_prompt","prompt":"hi"}\n', "junk");
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("normalize_missing_session_start");
    expect(
      await readMetadata(store, "acme", archiveId("acme", "datadog-trajectory", "junk")),
    ).toMatchObject({ traces: [], raw: [{ part: 0 }] });
  });
});
