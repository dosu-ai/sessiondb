/** Writes `testdata/transcripts/<name>.<source>.<ext>`: real-shaped native transcripts for each
 * harness, the input of `scripts/goldens.ts`. Run with
 * `bun run scripts/fixtures.ts`; the outputs are committed. */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = join(import.meta.dir, "..", "testdata", "transcripts");
mkdirSync(OUT, { recursive: true });

const GITHUB_TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz012345";

function write(name: string, body: string) {
  writeFileSync(join(OUT, name), body);
  console.log(`wrote ${name}`);
}

// --- Claude Code --------------------------------------------------------------

/** A minimal real Claude Code transcript: prose, a tool call, and its result. */
write(
  "claude-basic.claude-code.jsonl",
  [
    {
      type: "user",
      uuid: "u1",
      timestamp: "2026-09-01T00:00:00.000Z",
      cwd: "/repo/app",
      gitBranch: "main",
      sessionId: "sess1",
      message: { role: "user", content: 'How does auth work? password: "hunter2secretvalue42"' },
    },
    {
      type: "assistant",
      uuid: "a1",
      timestamp: "2026-09-01T00:00:05.000Z",
      sessionId: "sess1",
      message: {
        role: "assistant",
        model: "claude-x",
        content: [{ type: "text", text: `Token is ${GITHUB_TOKEN} here.` }],
      },
    },
    {
      type: "assistant",
      uuid: "a2",
      timestamp: "2026-09-01T00:00:06.000Z",
      sessionId: "sess1",
      message: {
        role: "assistant",
        model: "claude-x",
        content: [
          {
            type: "tool_use",
            id: "toolu_01AbCdEfGhJkLmNpQr",
            name: "Read",
            input: { file_path: "/repo/app/auth.ts" },
          },
        ],
      },
    },
    {
      type: "user",
      uuid: "u2",
      timestamp: "2026-09-01T00:00:07.000Z",
      sessionId: "sess1",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_01AbCdEfGhJkLmNpQr",
            content: "export const KEY = 1;  \r\n",
          },
        ],
      },
    },
  ]
    .map((row) => JSON.stringify(row))
    .join("\n"),
);

/** A background task's notification, in place, as what the agent observed. */
{
  const row = (uuid: string, type: string, content: unknown, extra = {}) =>
    JSON.stringify({
      type,
      uuid,
      timestamp: `2026-09-01T00:00:0${uuid.slice(-1)}.000Z`,
      sessionId: "bg",
      message: { role: type, content },
      ...extra,
    });
  const notification =
    "<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n" +
    "<result>README.md has 4 lines.</result>\n</task-notification>";
  write(
    "claude-task-notification.claude-code.jsonl",
    [
      row("u1", "user", "Launch a background agent to count README lines."),
      row("a2", "assistant", [{ type: "tool_use", id: "toolu_1", name: "Agent", input: {} }]),
      row("u3", "user", [{ type: "tool_result", tool_use_id: "toolu_1", content: "launched" }]),
      row("u4", "user", notification, { origin: { kind: "task-notification" } }),
      row("u5", "user", [{ type: "text", text: notification }]),
      row("a6", "assistant", [{ type: "text", text: "The agent counted 4 lines." }]),
    ].join("\n"),
  );
}

/** Input queued while the agent was busy: what nobody typed as observations, the user's as user. */
{
  const row = (uuid: string, type: string, content: unknown) =>
    JSON.stringify({
      type,
      uuid,
      timestamp: `2026-09-01T00:00:${uuid.slice(1)}.000Z`,
      sessionId: "busy",
      message: { role: type, content },
    });
  const queued = (uuid: string, attachment: Record<string, unknown>, timestamp: string) =>
    JSON.stringify({
      type: "attachment",
      uuid,
      timestamp,
      sessionId: "busy",
      isSidechain: false,
      attachment: { type: "queued_command", ...attachment },
    });
  const notification =
    "<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n" +
    "<result>LINES=18 MARKER=OSPREY-5521</result>\n</task-notification>";
  const peer = '<agent-message from="planner">The schema change is merged.</agent-message>';
  write(
    "claude-queued-input.claude-code.jsonl",
    [
      row("u10", "user", "Count the lines in a background agent, then sleep 60."),
      row("a11", "assistant", [{ type: "tool_use", id: "toolu_1", name: "Agent", input: {} }]),
      row("u12", "user", [{ type: "tool_result", tool_use_id: "toolu_1", content: "launched" }]),
      row("a13", "assistant", [{ type: "tool_use", id: "toolu_2", name: "Bash", input: {} }]),
      row("u14", "user", [{ type: "tool_result", tool_use_id: "toolu_2", content: "slept" }]),
      queued(
        "q15",
        {
          prompt: notification,
          commandMode: "task-notification",
          origin: { kind: "task-notification" },
        },
        "2026-09-01T00:00:13.500Z",
      ),
      queued(
        "q16",
        { prompt: "Also check the CHANGELOG.", commandMode: "prompt", origin: { kind: "human" } },
        "2026-09-01T00:00:16.000Z",
      ),
      queued(
        "q17",
        { prompt: peer, isMeta: true, origin: { kind: "peer" } },
        "2026-09-01T00:00:17.000Z",
      ),
      JSON.stringify({
        type: "attachment",
        uuid: "x18",
        timestamp: "2026-09-01T00:00:18.000Z",
        attachment: { type: "hook_additional_context", content: ["Hook context: PELICAN"] },
      }),
      row("a19", "assistant", [{ type: "text", text: "LINES=18; the CHANGELOG is current." }]),
    ].join("\n"),
  );
}

// --- Codex --------------------------------------------------------------------

function codexRollout(items: Record<string, unknown>[]): string {
  const at = "2026-10-02T10:00:00.000Z";
  return `${items.map((item, ordinal) => JSON.stringify({ timestamp: at, ordinal, ...item })).join("\n")}\n`;
}
function codexMeta(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "session_meta",
    payload: { id, timestamp: "2026-10-02T10:00:00.000Z", cwd: "/repo/app", ...extra },
  };
}
function codexMessage(role: string, text: string): Record<string, unknown> {
  const type = role === "assistant" ? "output_text" : "input_text";
  return { type: "response_item", payload: { type: "message", role, content: [{ type, text }] } };
}

{
  const report =
    '<subagent_notification>\n{"agent_path":"01a0ff74-c903","status":{"completed":"Wrote test_calc.py"}}';
  write(
    "codex-subagent-report.codex.jsonl",
    codexRollout([
      codexMeta("01a0ff74-a68d-7ad0-83ee-80cf02c29b14"),
      codexMessage("user", "Spawn a subagent to write the tests"),
      codexMessage("assistant", "Spawned one."),
      codexMessage("user", report),
      codexMessage("assistant", "The subagent wrote the tests."),
    ]),
  );
}
{
  const parent = "01a0ff74-a68d-7ad0-83ee-80cf02c29b14";
  write(
    "codex-forked-subagent.codex.jsonl",
    codexRollout([
      codexMeta("01a0ff74-c903-73c2-b6b1-7546b84710ff", {
        forked_from_id: parent,
        parent_thread_id: parent,
        thread_source: "subagent",
        subagent_history_start_ordinal: 4,
      }),
      codexMeta(parent, { thread_source: "user" }),
      codexMessage("user", "Spawn a subagent to write the tests"),
      codexMessage("assistant", "Spawning one."),
      codexMessage("user", "Write test_calc.py for calc.py"),
      codexMessage("assistant", "Wrote test_calc.py."),
    ]),
  );
}

// --- OpenCode -------------------------------------------------------------------

/** One session as `opencode export` prints it: a prompt, a step that reads a file, an answer. */
{
  const id = "ses_0ff3fixture00001";
  const ids = { sessionID: id };
  const user = { id: `msg_${id}_1`, ...ids };
  const step = { id: `msg_${id}_2`, ...ids };
  const answer = { id: `msg_${id}_3`, ...ids };
  const doc = {
    info: {
      id,
      slug: "calm-eagle",
      projectID: "15d496110225279d",
      directory: "/repo/app",
      path: "",
      title: "Auth walkthrough",
      version: "1.18.34",
      time: { created: 1790963932400, updated: 1790963941200 },
    },
    messages: [
      {
        info: { role: "user", time: { created: 1790963932445 }, agent: "build", ...user },
        parts: [
          {
            type: "text",
            text: 'How does auth work? password: "hunter2secretvalue42"',
            id: `prt_${id}_1`,
            messageID: user.id,
            ...ids,
          },
        ],
      },
      {
        info: {
          role: "assistant",
          parentID: user.id,
          modelID: "claude-haiku-4-5",
          time: { created: 1790963934500, completed: 1790963936000 },
          ...step,
        },
        parts: [
          { type: "step-start", id: `prt_${id}_3`, messageID: step.id, ...ids },
          {
            type: "text",
            text: "Reading the auth module first.",
            time: { start: 1790963934596, end: 1790963934981 },
            id: `prt_${id}_4`,
            messageID: step.id,
            ...ids,
          },
          {
            type: "tool",
            tool: "read",
            callID: "toolu_0156L5aHDegRahdNMdG7zTv9",
            state: {
              status: "completed",
              input: { filePath: "/repo/app/auth.ts" },
              output: "export const KEY = 1;",
              time: { start: 1790963935000, end: 1790963935100 },
            },
            id: `prt_${id}_5`,
            messageID: step.id,
            ...ids,
          },
          {
            type: "step-finish",
            reason: "tool-calls",
            id: `prt_${id}_6`,
            messageID: step.id,
            ...ids,
          },
        ],
      },
      {
        info: {
          role: "assistant",
          parentID: user.id,
          modelID: "claude-haiku-4-5",
          time: { created: 1790963937000, completed: 1790963941100 },
          ...answer,
        },
        parts: [
          {
            type: "text",
            text: `Auth reads KEY; the token is ${GITHUB_TOKEN} here.`,
            id: `prt_${id}_7`,
            messageID: answer.id,
            ...ids,
          },
        ],
      },
    ],
  };
  write("opencode-export.opencode.json", `${JSON.stringify(doc, null, 2)}\n`);
}
