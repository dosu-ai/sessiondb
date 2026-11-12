import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectSource } from "./detect";
import { normalizeTranscript, type Source } from "./index";

const TESTDATA = join(import.meta.dirname, "..", "..", "..", "..", "spec", "testdata");
const read = (name: string) => readFileSync(join(TESTDATA, "transcripts", name), "utf8");
const jsonl = (rows: unknown[]) => `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;

/** trajectory-v1 records as JSONL, from a golden's records. */
const TRAJECTORY_LOG = jsonl(
  JSON.parse(readFileSync(join(TESTDATA, "goldens", "claude-basic.records.json"), "utf8")),
);

// No fixture file holds these three; each is the shape its adapter reads, and the test below
// checks the adapter does read it.
const CURSOR_LOG = jsonl([
  { role: "user", message: { content: [{ type: "text", text: "How does auth work?" }] } },
  {
    role: "assistant",
    message: { model: "gpt-5", content: [{ type: "text", text: "Through a session token." }] },
  },
]);
const PI_LOG = jsonl([
  { type: "session", id: "pi-sess1", timestamp: "2026-09-01T00:00:00.000Z", cwd: "/repo/app" },
  {
    type: "message",
    id: "m1",
    parentId: null,
    timestamp: "2026-09-01T00:00:01.000Z",
    message: { role: "user", content: [{ type: "text", text: "How does auth work?" }] },
  },
  {
    type: "message",
    id: "m2",
    parentId: "m1",
    timestamp: "2026-09-01T00:00:02.000Z",
    message: {
      role: "assistant",
      model: "claude-x",
      content: [{ type: "text", text: "Through a session token." }],
    },
  },
]);
const GEMINI_DOCUMENT = JSON.stringify(
  {
    sessionId: "gem-sess1",
    projectHash: "a1b2c3",
    startTime: "2026-09-01T00:00:00.000Z",
    lastUpdated: "2026-09-01T00:00:02.000Z",
    messages: [
      {
        id: "g1",
        timestamp: "2026-09-01T00:00:01.000Z",
        type: "user",
        content: "How does auth work?",
      },
      {
        id: "g2",
        timestamp: "2026-09-01T00:00:02.000Z",
        type: "gemini",
        model: "gemini-2.5-pro",
        content: "Through a session token.",
      },
    ],
  },
  null,
  2,
);

const SAMPLES: [string, string, Source][] = [
  ["claude-basic", read("claude-basic.claude-code.jsonl"), "claude-code"],
  ["claude-queued-input", read("claude-queued-input.claude-code.jsonl"), "claude-code"],
  ["claude-task-notification", read("claude-task-notification.claude-code.jsonl"), "claude-code"],
  ["codex-forked-subagent", read("codex-forked-subagent.codex.jsonl"), "codex"],
  ["codex-subagent-report", read("codex-subagent-report.codex.jsonl"), "codex"],
  ["opencode-export", read("opencode-export.opencode.json"), "opencode"],
  ["atif-claude-session", read("atif-claude-session.atif.json"), "atif"],
  [
    "datadog-claude-session",
    read("datadog-claude-session.datadog-trajectory.jsonl"),
    "datadog-trajectory",
  ],
  [
    "datadog-backfilled-session",
    read("datadog-backfilled-session.datadog-trajectory.jsonl"),
    "datadog-trajectory",
  ],
  ["cursor", CURSOR_LOG, "cursor"],
  ["pi", PI_LOG, "pi"],
  ["gemini-cli", GEMINI_DOCUMENT, "gemini-cli"],
  ["trajectory", TRAJECTORY_LOG, "trajectory"],
];

describe("detectSource", () => {
  it.each(SAMPLES)("detects %s", (_, sample, source) => {
    expect(detectSource(sample)).toBe(source);
  });

  it.each(SAMPLES)("detects %s from a sample cut mid-way", (_, sample, source) => {
    // Through the first record or the document's distinguishing keys, then cut mid-line.
    const firstLine = sample.indexOf("\n", 1);
    const cut = sample.startsWith("{\n")
      ? sample.slice(0, sample.indexOf('"messages"') + 40)
      : sample.slice(0, firstLine + 30);
    expect(detectSource(cut)).toBe(source);
  });

  it("reads the hand-written samples' shapes as their adapters do", () => {
    for (const [source, transcript] of [
      ["cursor", CURSOR_LOG],
      ["pi", PI_LOG],
      ["gemini-cli", GEMINI_DOCUMENT],
    ] as const) {
      const { records } = normalizeTranscript({ source, transcript });
      expect(records.map((r) => r.role)).toEqual(["meta", "user", "assistant"]);
    }
  });

  it("detects an ATIF document from its opening keys alone", () => {
    expect(detectSource('{\n  "schema_version": "ATIF-v1.7",\n  "session_id": "x",\n  "ag')).toBe(
      "atif",
    );
  });

  it("is null for empty, garbage, and unknown input", () => {
    expect(detectSource("")).toBeNull();
    expect(detectSource("   \n\n")).toBeNull();
    expect(detectSource("not json at all\nnor this\n")).toBeNull();
    expect(detectSource("\u0000\u0001binary")).toBeNull();
    expect(detectSource('{"hello":"world"}\n{"foo":1}\n')).toBeNull();
    expect(detectSource("[1, 2, 3]")).toBeNull();
    expect(detectSource('{\n  "unknown": true,\n  "messages": []\n}')).toBeNull();
  });

  it("is null when a line other than the last is not JSON", () => {
    const [first, ...rest] = read("claude-basic.claude-code.jsonl").split("\n");
    expect(detectSource([first, "garbage", ...rest].join("\n"))).toBeNull();
  });

  it("is null when the records match more than one source", () => {
    const mixed = `${read("claude-basic.claude-code.jsonl").trim()}\n${read("codex-subagent-report.codex.jsonl")}`;
    expect(detectSource(mixed)).toBeNull();
  });

  it("strips a byte-order mark", () => {
    expect(detectSource(`﻿${read("claude-basic.claude-code.jsonl")}`)).toBe("claude-code");
  });
});
