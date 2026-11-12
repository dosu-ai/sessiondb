import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StoreSessionDB } from "../client";
import { getTrace } from "../ingest/ingest";
import type { StoreSessionResult } from "../ingest/session";
import type { OtlpSpan, OtlpTrace } from "../schemas/otlp";
import { LAYOUT_SCHEMA } from "../schemas/store";
import type { Trace } from "../schemas/trace";
import { FsStore } from "../store/fs";
import { archiveId, keys, LAYOUT_KEY } from "../store/layout";
import { decodeJson } from "../store/publish";
import { StoreError } from "../store/store";
import { fromOtlp, isOtlpTrace, otlpMeta, otlpResource, toOtlp } from "./otlp";

const TRANSCRIPTS = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  "spec",
  "testdata",
  "transcripts",
);
const SMALL = readFileSync(join(TRANSCRIPTS, "claude-basic.claude-code.jsonl"), "utf8");
const line = (row: Record<string, unknown>) => `${JSON.stringify(row)}\n`;
const turn = (n: number, text: string, sessionId = "sess1") =>
  line({
    type: "user",
    uuid: `u${n}`,
    timestamp: `2026-09-01T00:${String(n).padStart(2, "0")}:00.000Z`,
    sessionId,
    message: { role: "user", content: `question ${n}` },
  }) +
  line({
    type: "assistant",
    uuid: `a${n}`,
    timestamp: `2026-09-01T00:${String(n).padStart(2, "0")}:05.000Z`,
    sessionId,
    message: { role: "assistant", model: "claude-x", content: [{ type: "text", text }] },
  });
/** The basic fixture (a question, an answer, a Read and its result) plus a long answer, so it
 * is worth a trace. */
const CLAUDE = `${SMALL.trim()}\n${turn(9, `The auth flow: ${"details ".repeat(400)}`)}`;

function stored(result: StoreSessionResult): Extract<StoreSessionResult, { content_hash: string }> {
  if (!("content_hash" in result)) throw new Error(`expected a trace, got ${result.status}`);
  return result;
}

function spansOf(trace: OtlpTrace): OtlpSpan[] {
  return trace.resourceSpans[0]?.scopeSpans[0]?.spans ?? [];
}

function attr(span: OtlpSpan, key: string): string | undefined {
  const v = span.attributes.find((a) => a.key === key)?.value;
  return v && "stringValue" in v ? v.stringValue : undefined;
}

let dir: string;
let store: FsStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sessiondb-otlp-"));
  store = new FsStore(join(dir, "bucket"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("toOtlp", () => {
  async function lettaTrace(): Promise<Trace> {
    const db = new StoreSessionDB({ store, owner: "acme" });
    const result = stored(
      await db.ingest({ agent: "claude-code", session_id: "sess1", transcript: CLAUDE }),
    );
    return (await getTrace(store, "acme", result.archive_id, result.content_hash)) as Trace;
  }

  it("makes an invoke_agent root, a chat span per assistant record and a span per tool call", async () => {
    const trace = await lettaTrace();
    const otlp = toOtlp(trace);
    const spans = spansOf(otlp);
    const [root, ...rest] = spans;

    expect(root?.name).toBe("invoke_agent claude-code");
    expect(root?.parentSpanId).toBeUndefined();
    expect(root?.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(attr(root as OtlpSpan, "gen_ai.conversation.id")).toBe("sess1");
    expect(rest.every((s) => s.parentSpanId === root?.spanId && s.traceId === root?.traceId)).toBe(
      true,
    );
    expect(new Set(spans.map((s) => s.spanId)).size).toBe(spans.length);

    const chats = rest.filter((s) => attr(s, "gen_ai.operation.name") === "chat");
    expect(chats).toHaveLength(3);
    expect(chats[0]?.name).toBe("chat claude-x");
    // The first call's input is the question; it took from the question to the answer.
    const input = JSON.parse(attr(chats[0] as OtlpSpan, "gen_ai.input.messages") as string);
    expect(input).toHaveLength(1);
    expect(input[0].role).toBe("user");
    expect(chats[0]?.startTimeUnixNano).toBe(`${Date.parse("2026-09-01T00:00:00.000Z")}000000`);
    expect(chats[0]?.endTimeUnixNano).toBe(`${Date.parse("2026-09-01T00:00:05.000Z")}000000`);

    const [tool] = rest.filter((s) => attr(s, "gen_ai.operation.name") === "execute_tool");
    expect(tool?.name).toBe("execute_tool Read");
    expect(attr(tool as OtlpSpan, "gen_ai.tool.call.id")).toBe("toolu_01AbCdEfGhJkLmNpQr");
    expect(JSON.parse(attr(tool as OtlpSpan, "gen_ai.tool.call.arguments") as string)).toEqual({
      file_path: "/repo/app/auth.ts",
    });
    expect(attr(tool as OtlpSpan, "gen_ai.tool.call.result")).toContain("KEY");
    expect(tool?.endTimeUnixNano).toBe(`${Date.parse("2026-09-01T00:00:07.000Z")}000000`);

    // The tool result is the next call's input.
    const next = JSON.parse(attr(chats[2] as OtlpSpan, "gen_ai.input.messages") as string);
    expect(next.map((m: { role: string }) => m.role)).toEqual(["tool", "user"]);
  });

  it("is deterministic, redacted, and carries the meta record and session on its resource", async () => {
    const trace = await lettaTrace();
    const otlp = toOtlp(trace);
    expect(JSON.stringify(toOtlp(trace))).toBe(JSON.stringify(otlp));
    const text = JSON.stringify(otlp);
    expect(text).not.toContain("hunter2secretvalue42");
    expect(text).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz012345");

    expect(otlpMeta(otlp)).toEqual(trace.records[0]);
    expect(otlpResource(otlp, "sessiondb.content_hash")).toBe(trace.content_hash);
    expect(otlpResource(otlp, "sessiondb.session_id")).toBe("sess1");
    expect(otlpResource(otlp, "sessiondb.records")).toBe(trace.records.length);
    expect(isOtlpTrace(otlp)).toBe(true);
    expect(isOtlpTrace(trace)).toBe(false);
  });

  it("converts back to the letta trace it was made from", async () => {
    const trace = await lettaTrace();
    expect(fromOtlp(toOtlp(trace))).toEqual(trace);
    // Through JSON too, as a reader gets it from the bucket.
    expect(fromOtlp(JSON.parse(JSON.stringify(toOtlp(trace))))).toEqual(trace);
  });

  it("refuses to convert an object whose records are missing or changed", async () => {
    const otlp = toOtlp(await lettaTrace());
    const spans = otlp.resourceSpans[0]?.scopeSpans[0]?.spans as OtlpSpan[];
    const gap = structuredClone(otlp);
    gap.resourceSpans[0]?.scopeSpans[0]?.spans.splice(1, 1);
    expect(() => fromOtlp(gap)).toThrow(/on no span/);

    const changed = structuredClone(otlp);
    const chat = changed.resourceSpans[0]?.scopeSpans[0]?.spans.find(
      (s) => s.spanId === spans[1]?.spanId,
    ) as OtlpSpan;
    const kv = chat.attributes.find((a) => a.key === "sessiondb.records");
    if (!kv || !("stringValue" in kv.value)) throw new Error("no records");
    kv.value.stringValue = kv.value.stringValue.replace("auth", "AUTH");
    expect(() => fromOtlp(changed)).toThrow(/hash to/);
  });

  it("marks a failed tool call as an error and keeps an unanswered question on the root", () => {
    const trace = {
      schema: "sessionstorage/trace/1",
      content_hash: "h".repeat(64),
      source: "codex",
      agent: "codex",
      session_id: "s",
      started_at: "2026-09-01T00:00:00.000Z",
      ended_at: "2026-09-01T00:00:09.000Z",
      records: [
        { role: "meta", source: "codex" },
        { role: "user", content: "run it", timestamp: "2026-09-01T00:00:00.000Z" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c1", name: "shell", args: "not json" }],
          timestamp: "2026-09-01T00:00:01.000Z",
        },
        {
          role: "tool",
          tool_call_id: "c1",
          content: "boom",
          ok: false,
          timestamp: "bad",
        },
        { role: "user", content: "well?", timestamp: "2026-09-01T00:00:09.000Z" },
      ],
      events: [],
      metadata: {},
    } as unknown as Trace;
    const spans = spansOf(toOtlp(trace));
    const tool = spans.find((s) => s.name === "execute_tool shell") as OtlpSpan;
    expect(tool.status).toEqual({ code: 2, message: "tool call failed" });
    expect(attr(tool, "gen_ai.tool.call.arguments")).toBe("not json");
    // An unparseable timestamp falls back to the last one known.
    expect(tool.endTimeUnixNano).toBe(tool.startTimeUnixNano);
    const left = JSON.parse(attr(spans[0] as OtlpSpan, "sessiondb.unanswered_messages") as string);
    expect(left.map((m: { role: string }) => m.role)).toEqual(["tool", "user"]);
  });
});

describe("an otlp store", () => {
  const db = () => new StoreSessionDB({ store, owner: "acme", format: "otlp" });

  it("records the format in the marker and writes traces as OTLP under their own key", async () => {
    const otlp = db();
    await otlp.check();
    const marker = decodeJson<{ schema: string; format: string }>(
      (await store.get(LAYOUT_KEY)) as Uint8Array,
    );
    expect(marker).toMatchObject({ schema: LAYOUT_SCHEMA, format: "otlp" });

    const result = stored(
      await otlp.ingest({ agent: "claude-code", session_id: "sess1", transcript: CLAUDE }),
    );
    const archive = archiveId("acme", "claude-code", "sess1");
    expect(
      await store.stat(keys.trace("acme", archive, result.content_hash, "otlp")),
    ).not.toBeNull();
    expect(await store.stat(keys.trace("acme", archive, result.content_hash))).toBeNull();

    const trace = await otlp.getTrace("claude-code", "sess1");
    expect(isOtlpTrace(trace)).toBe(true);
    expect(otlpResource(trace as OtlpTrace, "sessiondb.content_hash")).toBe(result.content_hash);
    expect(await otlp.traceFormat()).toBe("otlp");

    // A client configured with no format reads the store's.
    const reader = new StoreSessionDB({ store, owner: "acme" });
    expect(isOtlpTrace(await reader.getTrace("claude-code", "sess1"))).toBe(true);
    expect(await reader.traceFormat()).toBe("otlp");
    // Writing it takes opting in: a client that did not is refused, not switched to otlp.
    await expect(
      reader.ingest({ agent: "claude-code", session_id: "sess2", transcript: CLAUDE }),
    ).rejects.toThrow(/holds otlp traces/);
  });

  it("continues a session in chunks from an OTLP head", async () => {
    const otlp = db();
    const first = stored(
      await otlp.ingest({ agent: "claude-code", session_id: "sess1", transcript: CLAUDE }),
    );
    const second = stored(
      await otlp.ingest({
        agent: "claude-code",
        session_id: "sess1",
        transcript: turn(10, `Second. ${"More. ".repeat(100)}`),
        offset: first.bytes_total,
      }),
    );
    expect(second.records).toBe(3);
    const trace = (await otlp.getTrace("claude-code", "sess1")) as OtlpTrace;
    expect(otlpResource(trace, "sessiondb.continuation.from_record")).toBe(first.records_total);
    const head = (await otlp.getTrace("claude-code", "sess1", first.content_hash)) as OtlpTrace;
    expect(otlpMeta(trace)).toEqual(otlpMeta(head));
    // A continuation converts back too: its tail, with the lineage that places it.
    const tail = fromOtlp(trace);
    expect(tail.content_hash).toBe(second.content_hash);
    expect(tail.metadata.continuation?.from_record).toBe(first.records_total);
  });

  it("writes only what a fork added, reading the parent's records from its spans", async () => {
    const otlp = db();
    const parent = stored(
      await otlp.ingest({ agent: "claude-code", session_id: "parent", transcript: CLAUDE }),
    );
    const fork = stored(
      await otlp.ingest({
        agent: "claude-code",
        session_id: "fork",
        transcript: CLAUDE + turn(30, `Its own answer. ${"More. ".repeat(400)}`, "fork"),
        parent_session_id: "parent",
        fork_of: "parent",
      }),
    );
    expect(fork.records).toBe(3);
    expect(fork.records_total).toBe(parent.records_total + 2);
  });

  it("tombstones the OTLP object", async () => {
    const otlp = db();
    const result = stored(
      await otlp.ingest({ agent: "claude-code", session_id: "sess1", transcript: CLAUDE }),
    );
    expect(await otlp.tombstone("claude-code", "sess1")).toEqual({ removed: 2 });
    const archive = archiveId("acme", "claude-code", "sess1");
    expect(await store.stat(keys.trace("acme", archive, result.content_hash, "otlp"))).toBeNull();
  });
});

describe("one format per store", () => {
  it("refuses to write a store in the other format", async () => {
    await new StoreSessionDB({ store, owner: "acme" }).check();
    const otlp = new StoreSessionDB({ store, owner: "acme", format: "otlp" });
    await expect(otlp.check()).rejects.toThrow(StoreError);
    await expect(
      otlp.ingest({ agent: "claude-code", session_id: "sess1", transcript: CLAUDE }),
    ).rejects.toThrow(/holds letta traces/);
  });

  it("reads a marker written before the choice as letta", async () => {
    await store.put(
      LAYOUT_KEY,
      new TextEncoder().encode(
        JSON.stringify({
          schema: LAYOUT_SCHEMA,
          created_at: "2026-01-01T00:00:00Z",
          created_by: "x",
        }),
      ),
    );
    const db = new StoreSessionDB({ store, owner: "acme" });
    expect(await db.traceFormat()).toBe("letta");
    await expect(
      new StoreSessionDB({ store, owner: "acme", format: "otlp" }).check(),
    ).rejects.toThrow(StoreError);
  });
});
