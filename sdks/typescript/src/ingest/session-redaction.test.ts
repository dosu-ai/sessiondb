import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { redactionRules } from "../redact/rules";
import { FsStore } from "../store/fs";
import { archiveId, keys } from "../store/layout";
import { getSession } from "./ingest";
import { storeSession } from "./session";

let dir: string;
let store: FsStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sessiondb-redaction-"));
  store = new FsStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const owner = "acme";
const sid = "sess-r";
const line = (row: object) => `${JSON.stringify(row)}\n`;
const at = (s: number) => new Date(Date.UTC(2026, 10, 11, 12, 0, s)).toISOString();

const prompt = line({
  type: "user",
  uuid: "u1",
  timestamp: at(0),
  sessionId: sid,
  message: {
    role: "user",
    content: `Check the env and the customer cust_abc123. ${"x".repeat(2100)}`,
  },
});
const readEnv = line({
  type: "assistant",
  uuid: "a1",
  parentUuid: "u1",
  timestamp: at(1),
  sessionId: sid,
  message: {
    role: "assistant",
    model: "claude-x",
    content: [
      { type: "tool_use", id: "toolu_env", name: "Read", input: { file_path: "/repo/.env" } },
    ],
  },
});
const envResult = line({
  type: "user",
  uuid: "u2",
  parentUuid: "a1",
  timestamp: at(2),
  sessionId: sid,
  message: {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "toolu_env", content: "STRIPE_PW=plainvalue" }],
  },
  toolUseResult: { file: { filePath: "/repo/.env", content: "STRIPE_PW=plainvalue" } },
});
const answer = line({
  type: "assistant",
  uuid: "a2",
  parentUuid: "u2",
  timestamp: at(3),
  sessionId: sid,
  message: { role: "assistant", model: "claude-x", content: [{ type: "text", text: "Done." }] },
});

async function rawPart(part: number): Promise<string> {
  const bytes = await store.get(
    keys.raw(owner, archiveId(owner, "claude-code", sid), part, "jsonl"),
  );
  return new TextDecoder().decode(gunzipSync(bytes as Uint8Array));
}

describe("storeSession redaction", () => {
  it("withholds a sensitive result that arrives in a later chunk than its call", async () => {
    const first = prompt + readEnv;
    const one = await storeSession(
      { owner, agent: "claude-code", session_id: sid, transcript: first, format: "jsonl" },
      { store },
    );
    expect((await getSession(store, owner, "claude-code", sid))?.withheld_calls).toEqual({
      toolu_env: "sensitive-file",
    });

    await storeSession(
      {
        owner,
        agent: "claude-code",
        session_id: sid,
        transcript: envResult + answer,
        format: "jsonl",
        offset: one.bytes_total,
      },
      { store },
    );
    const raw = await rawPart(1);
    expect(raw).not.toContain("plainvalue");
    expect(raw).toContain("[redacted:sensitive-file]");
    expect((await getSession(store, owner, "claude-code", sid))?.withheld_calls).toEqual({
      toolu_env: "sensitive-file",
    });
  });

  it("applies the operator's patterns to the raw part and the trace", async () => {
    const redaction = redactionRules({ patterns: ["cust_[a-z0-9]{6}"] });
    const result = await storeSession(
      {
        owner,
        agent: "claude-code",
        session_id: sid,
        transcript: prompt + readEnv + envResult + answer,
        format: "jsonl",
      },
      { store, redaction },
    );
    expect(result.status).toBe("stored");
    const raw = await rawPart(0);
    expect(raw).not.toContain("cust_abc123");
    expect(raw).toContain("[redacted:custom-pattern]");
    expect(raw).not.toContain("plainvalue");
    const metadata = await getSession(store, owner, "claude-code", sid);
    const trace = await store.get(
      keys.trace(owner, metadata?.archive_id as string, metadata?.head as string),
    );
    const text = new TextDecoder().decode(gunzipSync(trace as Uint8Array));
    expect(text).not.toContain("cust_abc123");
    expect(text).not.toContain("plainvalue");
  });

  it("keeps no withheld_calls on a session that has none", async () => {
    await storeSession(
      {
        owner,
        agent: "claude-code",
        session_id: sid,
        transcript: prompt + answer,
        format: "jsonl",
      },
      { store },
    );
    const metadata = await getSession(store, owner, "claude-code", sid);
    expect(metadata && "withheld_calls" in metadata).toBe(false);
  });
});
