import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isSource, NormalizeError, normalizeTranscript } from "./index";

const TRANSCRIPTS = join(import.meta.dirname, "..", "..", "testdata", "transcripts");
const read = (name: string) => readFileSync(join(TRANSCRIPTS, name), "utf8");

const GITHUB_TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz012345";

describe("normalizeTranscript for Claude Code", () => {
  it("normalizes to trajectory-v1 with the meta record first", async () => {
    const { records } = normalizeTranscript({
      source: "claude-code",
      transcript: read("claude-basic.claude-code.jsonl"),
    });
    expect(records[0]).toMatchObject({
      role: "meta",
      source: "claude-code",
      cwd: "/repo/app",
      git_branch: "main",
    });
    expect(records.map((r) => r.role)).toEqual(["meta", "user", "assistant", "assistant", "tool"]);
  });

  it("redacts every text that ships and keeps tool linkage intact", async () => {
    const { records } = normalizeTranscript({
      source: "claude-code",
      transcript: read("claude-basic.claude-code.jsonl"),
    });
    const shipped = JSON.stringify(records);
    expect(shipped).not.toContain(GITHUB_TOKEN);
    expect(shipped).not.toContain("hunter2secretvalue42");
    expect(shipped).toContain("[redacted:github-token]");
    expect(shipped).toContain("[redacted:credential]");
    const call = records.find((r) => "tool_calls" in r) as { tool_calls: { id: string }[] };
    const result = records.find((r) => r.role === "tool") as { tool_call_id: string };
    expect(call.tool_calls[0]?.id).toBe("toolu_01AbCdEfGhJkLmNpQr");
    expect(result.tool_call_id).toBe("toolu_01AbCdEfGhJkLmNpQr");
  });

  it("keeps a task notification, in place, as what the agent observed", async () => {
    const { records } = normalizeTranscript({
      source: "claude-code",
      transcript: read("claude-task-notification.claude-code.jsonl"),
    });
    expect(records.map((r) => r.role)).toEqual([
      "meta",
      "user",
      "assistant",
      "tool",
      "observation",
      "observation",
      "assistant",
    ]);
    expect(records[4]).toMatchObject({
      role: "observation",
      timestamp: "2026-09-01T00:00:04.000Z",
    });
    expect((records[4] as { content: string }).content).toContain("README.md has 4 lines.");
  });

  it("keeps queued input: what nobody typed as observations, the user's as user records", async () => {
    const { records } = normalizeTranscript({
      source: "claude-code",
      transcript: read("claude-queued-input.claude-code.jsonl"),
    });
    expect(records.map((r) => r.role)).toEqual([
      "meta",
      "user",
      "assistant",
      "tool",
      "assistant",
      "tool",
      "observation",
      "user",
      "observation",
      "assistant",
    ]);
    expect(records[7]).toEqual({
      role: "user",
      content: "Also check the CHANGELOG.",
      timestamp: "2026-09-01T00:00:16.000Z",
    });
    expect(JSON.stringify(records)).not.toContain("PELICAN");
  });

  it("returns empty for an empty transcript", async () => {
    expect(normalizeTranscript({ source: "claude-code", transcript: "\n\n" })).toEqual({
      records: [],
      empty: true,
    });
  });

  it("returns empty for a transcript with no conversation in it", async () => {
    const transcript = `${JSON.stringify({ type: "summary", summary: "nothing" })}\n`;
    expect(normalizeTranscript({ source: "claude-code", transcript })).toEqual({
      records: [],
      empty: true,
    });
  });

  it("throws NormalizeError when the adapter fails for any other reason", () => {
    expect(() => normalizeTranscript({ source: "nope" as "codex", transcript: "{}\n" })).toThrow(
      NormalizeError,
    );
  });
});

describe("normalizeTranscript for Codex", () => {
  it("keeps a subagent's report as an observation, not as something the user said", async () => {
    const { records } = normalizeTranscript({
      source: "codex",
      transcript: read("codex-subagent-report.codex.jsonl"),
    });
    expect(records.map((r) => r.role)).toEqual([
      "meta",
      "user",
      "assistant",
      "observation",
      "assistant",
    ]);
    expect((records[3] as { content: string }).content).toContain("<subagent_notification>");
  });

  it("ships a forked subagent without the parent history its rollout copies", async () => {
    const { records } = normalizeTranscript({
      source: "codex",
      transcript: read("codex-forked-subagent.codex.jsonl"),
    });
    expect(
      records.filter((r) => r.role !== "meta").map((r) => (r as { content: string }).content),
    ).toEqual(["Write test_calc.py for calc.py", "Wrote test_calc.py."]);
  });
});

describe("normalizeTranscript for OpenCode", () => {
  it("normalizes the export document", () => {
    const { records } = normalizeTranscript({
      source: "opencode",
      transcript: read("opencode-export.opencode.json"),
    });
    expect(records[0]).toMatchObject({ role: "meta", source: "opencode", cwd: "/repo/app" });
    expect(records.map((r) => r.role)).toEqual([
      "meta",
      "user",
      "assistant",
      "assistant",
      "tool",
      "assistant",
    ]);
    const shipped = JSON.stringify(records);
    expect(shipped).not.toContain("hunter2secretvalue42");
    expect(shipped).not.toContain(GITHUB_TOKEN);
    expect(shipped).toContain("toolu_0156L5aHDegRahdNMdG7zTv9");
  });
});

describe("isSource", () => {
  it("knows the trajectory source names and nothing else", () => {
    expect(isSource("claude-code")).toBe(true);
    expect(isSource("gemini-cli")).toBe(true);
    expect(isSource("claude")).toBe(false);
    expect(isSource("emacs")).toBe(false);
  });
});
