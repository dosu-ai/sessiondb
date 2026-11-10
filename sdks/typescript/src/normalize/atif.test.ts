import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ATIF, atifSource } from "./atif";
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

  /** A session of agent steps, each `[calls, results]`: a call is an id (or null for none), a
   * result is `[source_call_id, is_error]`. */
  const session = (...steps: [(string | null)[], [string, boolean | null][]][]) =>
    JSON.stringify({
      schema_version: "ATIF-v1.7",
      session_id: "s",
      agent: { name: "claude-code", version: "1" },
      steps: [
        { step_id: 1, source: "user", message: "go" },
        ...steps.map(([calls, results], index) => ({
          step_id: index + 2,
          source: "agent",
          message: "",
          tool_calls: calls.map((id) => ({
            ...(id === null ? {} : { tool_call_id: id }),
            function_name: "Bash",
            arguments: {},
          })),
          observation: {
            results: results.map(([id, isError]) => ({
              source_call_id: id,
              content: `${id} ${isError}`,
              ...(isError === null ? {} : { extra: { is_error: isError } }),
            })),
          },
        })),
      ],
    });
  /** What the normalizer made of each result: its record's id, content and ok. */
  const results = (transcript: string) =>
    normalize(transcript).records.flatMap((r) =>
      r.role === "tool" ? [[r.tool_call_id, r.content, r.ok]] : [],
    );

  it("follow the adapter's renaming of repeated call ids", () => {
    // The adapter renames the second `c` to `c__2`, so the document's own `c__2` becomes
    // `c__2__2`; each result answers the first of its id's calls not yet answered.
    expect(
      results(
        session([["c"], [["c", false]]], [["c"], [["c", true]]], [["c__2"], [["c__2", false]]]),
      ),
    ).toEqual([
      ["c", "c false", true],
      ["c__2", "c true", false],
      ["c__2__2", "c__2 false", true],
    ]);
  });

  it("take no flag from a result the adapter drops, and link a result to a later call", () => {
    expect(
      results(
        session(
          // A duplicate result for `a`, dropped by the adapter, flagged as failed.
          [
            ["a"],
            [
              ["a", false],
              ["a", true],
            ],
          ],
          // `b`'s result arrives a step before its call; the adapter still links it.
          [[], [["b", true]]],
          [["b", null], []],
          // A call without an id, named after its event by the adapter, answered by name.
          [[null], [["call_10", true]]],
        ),
      ),
    ).toEqual([
      ["a", "a false", true],
      ["b", "b true", false],
      ["call_10", "call_10 true", false],
    ]);
  });

  it("leave ok off a result without a boolean is_error", () => {
    const transcript = session([
      ["x", "y"],
      [
        ["x", null],
        ["y", false],
      ],
    ]).replace('"content":"x null"', '"content":"x null","extra":{"is_error":"yes"}');
    expect(results(transcript)).toEqual([
      ["x", "x null", undefined],
      ["y", "y false", true],
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
