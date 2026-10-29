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

describe("normalizeTranscript in chunks", () => {
  const LOGS: [string, "claude-code" | "codex" | "datadog-trajectory"][] = [
    ["claude-basic.claude-code.jsonl", "claude-code"],
    ["claude-queued-input.claude-code.jsonl", "claude-code"],
    ["claude-task-notification.claude-code.jsonl", "claude-code"],
    ["codex-subagent-report.codex.jsonl", "codex"],
    ["codex-forked-subagent.codex.jsonl", "codex"],
    ["datadog-claude-session.datadog-trajectory.jsonl", "datadog-trajectory"],
    ["datadog-backfilled-session.datadog-trajectory.jsonl", "datadog-trajectory"],
  ];
  const sessionOf = (source: string, log: string): string => {
    const first = JSON.parse(log.slice(0, log.indexOf("\n"))) as Record<string, unknown>;
    if (source === "codex") return (first.payload as Record<string, string>).id;
    return (first.sessionId ?? first.session_id) as string;
  };

  it.each(LOGS)(
    "%s: cut at any line, the head whole and the tail as a chunk normalize to what the whole does",
    (name, source) => {
      // One more turn of the subagent's own on the forked rollout, so a cut past its inherited
      // history and first turn exists.
      const log =
        read(name) +
        (name.startsWith("codex-forked")
          ? `${JSON.stringify({
              timestamp: "2026-10-02T10:00:01.000Z",
              ordinal: 6,
              type: "response_item",
              payload: {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "Then ran them." }],
              },
            })}\n`
          : "");
      const whole = normalizeTranscript({ source, transcript: log });
      expect(whole.empty).toBeFalsy();
      const session_id = sessionOf(source, log);
      const lines = log.split("\n");
      let cuts = 0;
      for (let i = 1; i < lines.length - 1; i++) {
        const head = `${lines.slice(0, i).join("\n")}\n`;
        const tail = lines.slice(i).join("\n");
        const rest = normalizeTranscript({
          source,
          transcript: tail,
          chunk: { offset: Buffer.byteLength(head), session_id },
        });
        // A chunk carries no meta record of its own.
        expect(rest.records.some((r) => r.role === "meta")).toBe(false);

        // The head as the whole log so far (the session's first upload), the tail as a chunk.
        const first = normalizeTranscript({ source, transcript: head });
        if (!first.empty) {
          expect([...first.records, ...rest.records]).toEqual(whole.records);
          cuts++;
        }
      }
      expect(cuts).toBeGreaterThan(0);
    },
  );

  it("is empty for a chunk with no records in it, not for one with any", () => {
    const noise = '{"type":"progress","uuid":"p","sessionId":"s","data":{}}\n';
    expect(
      normalizeTranscript({
        source: "claude-code",
        transcript: noise,
        chunk: { offset: 10, session_id: "s" },
      }),
    ).toEqual({ records: [], empty: true });
    const log = read("claude-basic.claude-code.jsonl");
    const last = log.trimEnd().split("\n").at(-1) as string;
    const chunk = normalizeTranscript({
      source: "claude-code",
      transcript: `${last}\n`,
      chunk: { offset: Buffer.byteLength(log) - Buffer.byteLength(last) - 1, session_id: "sess1" },
    });
    expect(chunk.empty).toBeFalsy();
    expect(chunk.records).toHaveLength(1);
  });
});
