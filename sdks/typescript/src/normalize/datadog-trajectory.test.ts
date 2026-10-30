import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeDatadogTrajectory } from "./datadog-trajectory";
import { normalizeTranscript } from "./index";

const fixture = (name: string) =>
  readFileSync(
    join(import.meta.dirname, "..", "..", "..", "..", "spec", "testdata", "transcripts", name),
    "utf8",
  );
/** A session file as Trajectory writes it for a session it captured live. */
const STREAM = fixture("datadog-claude-session.datadog-trajectory.jsonl");
/** A session as the daemon keeps it on disk after importing a client's own history. */
const BACKFILLED = fixture("datadog-backfilled-session.datadog-trajectory.jsonl");

const event = (type: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ event_type: type, session_id: "s1", client_source: "pi", ...extra });

describe("normalizeDatadogTrajectory", () => {
  it("maps the daemon's events to trajectory-v1, meta first", () => {
    const records = normalizeDatadogTrajectory(STREAM);
    expect(records[0]).toEqual({
      role: "meta",
      source: "datadog-trajectory:claude-code",
      cwd: "/repo/app",
      git_branch: "feature/auth",
      model: "claude-sonnet-4-5",
    });
    expect(records.map((r) => r.role)).toEqual([
      "meta",
      "user",
      "assistant",
      "tool",
      "assistant",
      "tool",
      "reasoning",
      "assistant",
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
  });

  it("names a tool call by the client's own name, and links its result", () => {
    const records = normalizeDatadogTrajectory(STREAM);
    const call = records[9] as { tool_calls: { id: string; name: string; args: string }[] };
    expect(call.tool_calls).toEqual([
      {
        id: "toolu_03CdEfGhIjKlMnOpQr",
        name: "Task",
        args: '{"description":"search","prompt":"grep for TODO","subagent_type":"explore"}',
      },
    ]);
    expect(records[10]).toMatchObject({
      role: "tool",
      tool_call_id: "toolu_03CdEfGhIjKlMnOpQr",
      ok: true,
    });
  });

  it("keeps a failed call's error as its result, not ok", () => {
    const records = normalizeDatadogTrajectory(STREAM);
    expect(records[3]).toEqual({
      role: "tool",
      tool_call_id: "toolu_01AbCdEfGhJkLmNpQr",
      content: "File does not exist",
      ok: false,
      timestamp: "2026-10-29T20:27:33.119Z",
    });
  });

  it("splits an agent message into its reasoning and its answer", () => {
    const records = normalizeDatadogTrajectory(STREAM);
    expect(records[6]).toMatchObject({
      role: "reasoning",
      content: expect.stringMatching(/KEY constant/),
    });
    expect(records[7]).toMatchObject({
      role: "assistant",
      content: expect.stringMatching(/Auth reads KEY/),
    });
  });

  it("files input nobody typed as an observation", () => {
    const records = normalizeDatadogTrajectory(
      [
        event("session_start", { timestamp: "2026-10-29T20:00:00Z" }),
        event("user_prompt", {
          prompt: "fix the tests",
          provenance: { actor_type: "human" },
          timestamp: "2026-10-29T20:00:01Z",
        }),
        event("input_prompt", {
          prompt: "<task-notification>done</task-notification>",
          provenance: { actor_type: "automation" },
          timestamp: "2026-10-29T20:00:02Z",
        }),
        event("agent_message", { text: "Fixed.", timestamp: "2026-10-29T20:00:03Z" }),
      ].join("\n"),
    );
    expect(records.map((r) => r.role)).toEqual(["meta", "user", "observation", "assistant"]);
    expect(records[0]).toEqual({ role: "meta", source: "datadog-trajectory:pi" });
  });

  it("gives an event without a timestamp the last one seen", () => {
    const records = normalizeDatadogTrajectory(
      [
        event("session_start", { timestamp: "2026-10-29T20:00:00Z" }),
        event("user_prompt", { prompt: "hi", timestamp: "2026-10-29T20:00:01Z" }),
        event("agent_message", { text: "hello" }),
      ].join("\n"),
    );
    expect(records[2]).toMatchObject({ role: "assistant", timestamp: "2026-10-29T20:00:01Z" });
  });

  it("skips blank and unparseable lines and events it does not know", () => {
    const records = normalizeDatadogTrajectory(
      [
        "",
        event("session_start", { timestamp: "2026-10-29T20:00:00Z" }),
        "not json",
        "[1,2]",
        event("user_prompt", { prompt: "hi", timestamp: "2026-10-29T20:00:01Z" }),
        event("permission_request", { tool_name: "Bash" }),
        event("agent_message", { text: "hello", timestamp: "2026-10-29T20:00:02Z" }),
        "",
      ].join("\n"),
    );
    expect(records.map((r) => r.role)).toEqual(["meta", "user", "assistant"]);
  });

  it("reads the thinner stream the daemon keeps for a session it imported from history", () => {
    // `trajectory session import`: `cwd` for the directory, a tool call present only as its
    // `post` event, and no prose from the agent.
    const records = normalizeDatadogTrajectory(BACKFILLED);
    expect(records[0]).toEqual({
      role: "meta",
      source: "datadog-trajectory:claude-code",
      cwd: "/repo/app",
      model: "claude-x",
    });
    expect(records.map((r) => r.role)).toEqual(["meta", "user", "assistant", "tool"]);
    expect(records[2]).toMatchObject({
      tool_calls: [{ id: "toolu_01AbCdEfGhJkLmNpQr", name: "Read", args: "{}" }],
    });
    expect(records[3]).toMatchObject({ tool_call_id: "toolu_01AbCdEfGhJkLmNpQr", ok: true });
  });

  it("does not repeat a call whose pre event did ship", () => {
    const records = normalizeDatadogTrajectory(
      [
        event("session_start", { timestamp: "2026-10-29T20:00:00Z" }),
        event("user_prompt", { prompt: "go" }),
        event("tool_use", { phase: "pre", tool_name: "Bash", tool_use_id: "t1", input: { c: 1 } }),
        event("tool_use", { phase: "post", tool_name: "Bash", tool_use_id: "t1", success: true }),
      ].join("\n"),
    );
    expect(records.map((r) => r.role)).toEqual(["meta", "user", "assistant", "tool"]);
    expect(records[2]).toMatchObject({ tool_calls: [{ id: "t1", args: '{"c":1}' }] });
  });

  it("reports a stream with no conversation by code", () => {
    const start = event("session_start", { timestamp: "2026-10-29T20:00:00Z" });
    expect(() => normalizeDatadogTrajectory(start)).toThrow(
      expect.objectContaining({ code: "missing_user_records" }),
    );
    expect(() =>
      normalizeDatadogTrajectory(`${start}\n${event("user_prompt", { prompt: "hi" })}`),
    ).toThrow(expect.objectContaining({ code: "missing_assistant_records" }));
  });
});

describe("normalizeTranscript for datadog-trajectory", () => {
  it("redacts, and keeps tool linkage", () => {
    const { records } = normalizeTranscript({ source: "datadog-trajectory", transcript: STREAM });
    const shipped = JSON.stringify(records);
    expect(shipped).not.toContain("hunter2secretvalue42");
    expect(shipped).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz012345");
    expect(shipped).toContain("[redacted:github-token]");
    expect(shipped).toContain("toolu_01AbCdEfGhJkLmNpQr");
  });

  it("calls a stream with no conversation yet empty, not an error", () => {
    const outcome = normalizeTranscript({
      source: "datadog-trajectory",
      transcript: event("session_start", { timestamp: "2026-10-29T20:00:00Z" }),
    });
    expect(outcome).toEqual({ records: [], empty: true });
  });
});
