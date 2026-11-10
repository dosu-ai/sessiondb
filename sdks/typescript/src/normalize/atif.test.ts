import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ATIF, atifSource, withAtifDetails } from "./atif";
import { isChunkable, isSource, NormalizeError, normalizeTranscript } from "./index";

const FIXTURE = readFileSync(
  join(
    import.meta.dirname,
    "..",
    "..",
    "..",
    "..",
    "spec",
    "testdata",
    "transcripts",
    "atif-claude-session.atif.json",
  ),
  "utf8",
);

/** The fixture with its top-level fields changed. */
function document(change: (doc: Record<string, unknown>) => void): string {
  const doc = JSON.parse(FIXTURE) as Record<string, unknown>;
  change(doc);
  return JSON.stringify(doc);
}

const withAgentName = (name: unknown) =>
  document((doc) => {
    doc.agent = { ...(doc.agent as object), name };
  });

const normalize = (transcript: string) => normalizeTranscript({ source: ATIF, transcript });

describe("ATIF documents", () => {
  it("are a source, sent whole only", () => {
    expect(isSource("atif")).toBe(true);
    expect(isChunkable("atif")).toBe(false);
    expect(isChunkable("claude-code")).toBe(true);
  });

  it("take the harness from agent.name as the meta record's source", () => {
    const { records } = normalize(FIXTURE);
    expect(records[0]).toEqual({ role: "meta", source: "claude-code", model: "claude-sonnet-4-5" });
    expect(normalize(withAgentName("codex")).records[0]).toMatchObject({ source: "codex" });
  });

  it("fall back to atif when agent.name is not a usable source", () => {
    for (const name of ["", "   ", "claude\ncode", "claude\u0000code", "a\u2028b"]) {
      expect(normalize(withAgentName(name)).records[0]).toMatchObject({ source: "atif" });
    }
    // The adapter refuses a document with no agent.name before the fixup sees it; the fixup
    // still falls back for one.
    expect(() => normalize(withAgentName(undefined))).toThrow(NormalizeError);
    expect(atifSource({ agent: {} })).toBe("atif");
    expect(atifSource({})).toBe("atif");
    expect(atifSource(null)).toBe("atif");
  });

  it("set ok on a tool record from extra.is_error, and only when the document has it", () => {
    const tools = normalize(FIXTURE).records.flatMap((r) => (r.role === "tool" ? [r] : []));
    expect(tools.map((r) => [r.tool_call_id, r.ok])).toEqual([
      ["toolu_01AtifReadAuthModule", true],
      ["toolu_01AtifRunAuthTests", false],
      ["toolu_01AtifSubagentTask", undefined],
    ]);
    expect(tools[2]).not.toHaveProperty("ok");
  });

  it("match repeated call ids to their results in document order", () => {
    const transcript = JSON.stringify({
      steps: [
        { observation: { results: [{ source_call_id: "c", extra: { is_error: true } }] } },
        { observation: { results: [{ source_call_id: "c" }] } },
        { observation: { results: [{ source_call_id: "c", extra: { is_error: false } }] } },
      ],
    });
    const tool = (n: number) => ({
      role: "tool" as const,
      tool_call_id: "c",
      content: `${n}`,
      timestamp: "2026-11-01T00:00:00.000Z",
    });
    const records = withAtifDetails(transcript, [tool(0), tool(1), tool(2), tool(3)]);
    expect(records.map((r) => (r.role === "tool" ? r.ok : null))).toEqual([
      false,
      undefined,
      true,
      undefined,
    ]);
  });

  it("leave embedded subagent trajectories unnormalized", () => {
    const { records } = normalize(FIXTURE);
    // The subagent's own steps (09:00:20, 09:00:24) are not in the parent's records.
    const times = records.flatMap((r) => ("timestamp" in r ? [r.timestamp] : []));
    expect(times.filter((t) => t >= "2026-11-01T09:00:20" && t < "2026-11-01T09:00:30")).toEqual(
      [],
    );
    expect(JSON.stringify(records)).not.toContain("The token is checked in src/auth.ts");
    // The parent keeps the reference, as the Task tool's result.
    expect(records.find((r) => r.role === "tool" && r.ok === undefined)).toMatchObject({
      content: JSON.stringify({
        subagent_trajectory_ref: [{ session_id: "atif-sess1:agent-7f3a" }],
      }),
    });
  });

  it("refuse ATIF-v1.8 and later, naming the version", () => {
    for (const version of ["ATIF-v1.8", "ATIF-v2.0"]) {
      const transcript = document((doc) => {
        doc.schema_version = version;
      });
      expect(() => normalize(transcript)).toThrow(
        expect.objectContaining({
          code: "invalid_input",
          message: `${version} is not supported: this normalizer reads ATIF-v1.0 through ATIF-v1.7`,
        }),
      );
    }
  });

  it("leave other unreadable documents to the adapter's refusal", () => {
    expect(() => normalize('{"schema_version":"ATIF-v1.7","steps":[]}')).toThrow(
      expect.objectContaining({ code: "invalid_input", message: expect.stringContaining("ATIF") }),
    );
    expect(() => normalize("not json")).toThrow(expect.objectContaining({ code: "invalid_input" }));
  });
});
