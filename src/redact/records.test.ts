import { describe, expect, it } from "vitest";
import type { NormalizedRecord } from "../schemas/trajectory";
import { redactRaw } from "./raw";
import { redactRecords } from "./records";

const SECRET = "sk-abcdefghijklmnopqrstuvwxyz123456";

describe("redactRecords", () => {
  const records = [
    { role: "meta", source: "claude-code", cwd: "/repo/app", git_branch: "feat/ABC-1234-xYz9Qw" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "toolu_01AbCdEfGhJkLmNpQr",
          name: "Bash",
          args: `{"command":"export API_KEY=${SECRET}"}`,
        },
      ],
      timestamp: "2026-09-01T00:00:06.000Z",
    },
  ] as unknown as NormalizedRecord[];

  it("redacts tool args and content but never structural keys", () => {
    const shipped = JSON.stringify(redactRecords(records));
    expect(shipped).not.toContain(SECRET);
    expect(shipped).toContain("[redacted:");
    expect(shipped).toContain("toolu_01AbCdEfGhJkLmNpQr");
    expect(shipped).toContain('"name":"Bash"');
    expect(shipped).toContain("feat/ABC-1234-xYz9Qw");
    expect(JSON.stringify(records)).toContain(SECRET);
  });

  it("redacts a printed CLI config's session tokens, nested and as JSON inside a string", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.fake-signature";
    const refresh = "abc123def456";
    const config = JSON.stringify(
      { active_account: { session: { access_token: jwt, refresh_token: refresh } } },
      null,
      2,
    );
    const printed = [
      {
        role: "tool",
        tool_call_id: "toolu_01AbCdEfGhJkLmNpQr",
        // The config as printed, and wrapped as a JSON string by a tool that returns JSON;
        // `jq -r` puts the bare token at the start of an escaped line.
        content: [{ type: "text", text: config }],
        meta: {
          stdout: JSON.stringify({ output: config }),
          tail: JSON.stringify(`$ jq -r .active_account.session.access_token\n${jwt}\n`),
        },
      },
    ] as unknown as NormalizedRecord[];

    const shipped = JSON.stringify(redactRecords(printed));

    expect(shipped).not.toContain("eyJ");
    expect(shipped).not.toContain(refresh);
    expect(shipped).toContain("[redacted:jwt]");
    expect(shipped).toContain("toolu_01AbCdEfGhJkLmNpQr");
  });

  it("is idempotent", () => {
    const once = redactRecords(records);
    expect(redactRecords(once)).toEqual(once);
  });
});

describe("raw passes", () => {
  it("redacts string values line by line, keys and non-strings untouched", () => {
    const lines = [
      JSON.stringify({ type: "user", n: 3, message: { content: `token ${SECRET}` } }),
      "",
      "not json but has sk-abcdefghijklmnopqrstuvwxyz123456",
      JSON.stringify({ nested: [{ deep: `Bearer ${"a".repeat(30)}` }] }),
    ].join("\n");
    const out = redactRaw(`${lines}\n`, "jsonl");
    expect(out).not.toContain(SECRET);
    expect(out.split("\n")).toHaveLength(5);
    expect(out.split("\n")[1]).toBe("");
    expect(out.endsWith("\n")).toBe(true);
    const first = JSON.parse(out.split("\n")[0] as string);
    expect(first.n).toBe(3);
    expect(first.type).toBe("user");
    expect(first.message.content).toContain("[redacted:");
  });

  it("redacts every string in a document", () => {
    const doc = JSON.stringify({ info: { title: "x" }, messages: [{ parts: [{ text: SECRET }] }] });
    const out = redactRaw(doc, "json");
    expect(out).not.toContain(SECRET);
    expect(JSON.parse(out).info.title).toBe("x");
  });

  it("redacts a document that does not parse as one string", () => {
    expect(redactRaw(`{ broken ${SECRET}`, "json")).not.toContain(SECRET);
  });
});
