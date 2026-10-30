/** Writes `spec/testdata/transcripts/<name>.<source>.<ext>`: real-shaped native transcripts for each
 * harness, the input of `scripts/goldens.ts`. Run with
 * `bun run scripts/fixtures.ts`; the outputs are committed. */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = join(import.meta.dir, "..", "..", "..", "spec", "testdata", "transcripts");
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

// --- Datadog Trajectory -----------------------------------------------------------

/** A Claude Code session as the Trajectory daemon forwards it (stream version 1): the canonical
 * events it writes to `session-<id>.jsonl`, with the state and accounting events it mixes in
 * (`inventory.snapshot`, `llm_call`, `turn_end`), a failed tool call, a subagent, and the
 * `session_end` that marks the delivery as the finished one. */
{
  const session = "0d6f1c2e-7b1a-4c3e-9f2d-5a8b7c6d4e3f";
  const at = (second: number, ms = 0) =>
    `2026-10-29T20:27:${String(second).padStart(2, "0")}.${String(ms).padStart(3, "0")}Z`;
  const base = { client_source: "claude-code", session_id: session };
  const events: Record<string, unknown>[] = [
    {
      sequence_number: 0,
      ...base,
      client_version: "2.1.283",
      event_type: "session_start",
      format_version: 1,
      git_branch: "feature/auth",
      model: "claude-sonnet-4-5",
      next_turn_id: 1,
      parent_session_id: null,
      project_dir: "/repo/app",
      provider: "anthropic",
      start_source: "startup",
      start_trigger: "fresh",
      started_at: at(31, 713),
      timestamp: at(31, 713),
    },
    {
      sequence_number: 1,
      ...base,
      event_kind: "state",
      event_type: "inventory.snapshot",
      generated_at: at(31, 713),
      inventory_items: [{ id: "client:claude-code", kind: "client", name: "claude-code" }],
      project: { dir: "/repo/app" },
      schema_version: 1,
      timestamp: at(31, 713),
    },
    {
      sequence_number: 2,
      ...base,
      event_type: "user_prompt",
      hour_of_day: 20,
      input_source: "user",
      model: "claude-sonnet-4-5",
      prompt: 'How does auth work? password: "hunter2secretvalue42"',
      prompt_type: "human",
      provenance: { actor_type: "human" },
      timestamp: at(32, 360),
      turn_id: 1,
    },
    {
      ...base,
      event_type: "tool_use",
      input: { file_path: "/repo/app/auth.ts" },
      phase: "pre",
      provenance: { actor_type: "assistant" },
      sequence_number: 3,
      timestamp: at(32, 899),
      tool_name: "Read",
      tool_operation: "file.read",
      tool_type: "read",
      tool_use_id: "toolu_01AbCdEfGhJkLmNpQr",
      turn_id: 1,
    },
    {
      ...base,
      error: "File does not exist",
      event_type: "tool_use",
      is_interrupt: false,
      phase: "post",
      provenance: { actor_type: "assistant" },
      sequence_number: 4,
      success: false,
      timestamp: at(33, 119),
      tool_name: "Read",
      tool_operation: "file.read",
      tool_type: "read",
      tool_use_id: "toolu_01AbCdEfGhJkLmNpQr",
      turn_id: 1,
    },
    {
      ...base,
      event_type: "tool_use",
      input: { command: "ls -la" },
      phase: "pre",
      provenance: { actor_type: "assistant" },
      sequence_number: 5,
      timestamp: at(33, 400),
      tool_name: "Bash",
      tool_operation: "shell.execute",
      tool_type: "shell",
      tool_use_id: "toolu_02BcDeFgHiJkLmNoPq",
      turn_id: 1,
    },
    {
      ...base,
      event_type: "tool_use",
      output_summary: '{"interrupted":false,"stderr":"","stdout":"auth.ts\\nREADME.md\\n"}',
      phase: "post",
      provenance: { actor_type: "assistant" },
      sequence_number: 6,
      success: true,
      timestamp: at(33, 433),
      tool_name: "Bash",
      tool_operation: "shell.execute",
      tool_type: "shell",
      tool_use_id: "toolu_02BcDeFgHiJkLmNoPq",
      turn_id: 1,
    },
    {
      sequence_number: 7,
      ...base,
      content_blocks: ["thinking", "text"],
      event_type: "agent_message",
      has_thinking: true,
      model: "claude-sonnet-4-5",
      provenance: { actor_type: "assistant" },
      provider: "anthropic",
      text: `Auth reads KEY; the token is ${GITHUB_TOKEN} here.`,
      thinking_text: "The file list shows auth.ts; its KEY constant is the credential.",
      timestamp: at(33, 900),
      token_usage: { input_tokens: 120, output_tokens: 30, total_tokens: 150 },
      tool_use_ids: [],
      turn_id: 1,
    },
    {
      sequence_number: 8,
      ...base,
      event_type: "turn_end",
      model: "claude-sonnet-4-5",
      provider: "anthropic",
      timestamp: at(33, 966),
      token_usage: { input_tokens: 120, output_tokens: 30, total_tokens: 150 },
      tokens_status: "final",
      turn_id: 1,
    },
    {
      sequence_number: 9,
      ...base,
      event_type: "user_prompt",
      hour_of_day: 20,
      input_source: "user",
      model: "claude-sonnet-4-5",
      prompt: "Now have a subagent grep for TODOs.",
      prompt_type: "human",
      provenance: { actor_type: "human" },
      timestamp: at(35, 6),
      turn_id: 2,
    },
    {
      ...base,
      event_type: "tool_use",
      input: { description: "search", prompt: "grep for TODO", subagent_type: "explore" },
      native_tool_name: "Task",
      phase: "pre",
      provenance: { actor_type: "assistant" },
      sequence_number: 10,
      timestamp: at(35, 539),
      tool_name: "Agent",
      tool_operation: "agent.delegate",
      tool_type: "agent",
      tool_use_id: "toolu_03CdEfGhIjKlMnOpQr",
      turn_id: 2,
    },
    {
      sequence_number: 11,
      ...base,
      agent_type: "explore",
      child_session_id: "agent-a1b2c3",
      event_type: "subagent_start",
      provenance: { actor_type: "subagent", agent: { name: "explore" } },
      timestamp: at(36, 73),
      turn_id: 2,
    },
    {
      sequence_number: 12,
      event_type: "llm_call",
      model: "claude-sonnet-4-5",
      operation: "messages",
      provider: "anthropic",
      response_summary: { content_block_types: ["text"], text_length: 15 },
      session_id: session,
      status: "ok",
      stop_reason: "end_turn",
      timestamp: at(36, 500),
      tokens: { input_tokens: 80, output_tokens: 10 },
      turn_id: 2,
    },
    {
      sequence_number: 13,
      ...base,
      agent_type: "explore",
      child_session_id: "agent-a1b2c3",
      event_type: "subagent_stop",
      last_assistant_message: "No TODOs found.",
      provenance: { actor_type: "subagent", agent: { name: "explore" } },
      timestamp: at(36, 605),
      turn_id: 2,
    },
    {
      ...base,
      event_type: "tool_use",
      native_tool_name: "Task",
      output_summary: '{"content":[{"text":"No TODOs found.","type":"text"}]}',
      phase: "post",
      provenance: { actor_type: "assistant" },
      sequence_number: 14,
      success: true,
      timestamp: at(37, 135),
      tool_name: "Agent",
      tool_operation: "agent.delegate",
      tool_type: "agent",
      tool_use_id: "toolu_03CdEfGhIjKlMnOpQr",
      turn_id: 2,
    },
    {
      sequence_number: 15,
      ...base,
      event_type: "agent_message",
      has_thinking: false,
      model: "claude-sonnet-4-5",
      provenance: { actor_type: "assistant" },
      text: "The subagent found no TODOs.",
      timestamp: at(37, 600),
      tool_use_ids: ["toolu_03CdEfGhIjKlMnOpQr"],
      turn_id: 2,
    },
    {
      sequence_number: 16,
      ...base,
      event_type: "turn_end",
      model: "claude-sonnet-4-5",
      provider: "anthropic",
      timestamp: at(37, 668),
      token_usage: { input_tokens: 200, output_tokens: 25, total_tokens: 225 },
      tokens_status: "final",
      turn_id: 2,
    },
    {
      sequence_number: 17,
      ...base,
      event_type: "session_end",
      exit_reason: "exit",
      timestamp: at(38, 701),
      total_input_tokens: 320,
      total_output_tokens: 55,
      total_turns: 2,
    },
  ];
  write(
    "datadog-claude-session.datadog-trajectory.jsonl",
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
  );
}

/** The same client's session as the daemon writes it to
 * `~/.trajectory/trajectories/sessions/<date>/session-<id>.jsonl` after `trajectory session
 * import claude`, which is what a Trajectory install holds for a client's history:
 * `_backfilled`, `cwd` rather than `project_dir`, a prompt-less `user_prompt` for the turn the
 * tool result came back in, a tool call present only as its `post` event, and no
 * `agent_message` at all. Shaped on what trajectory 0.6.1 wrote for `claude-basic`. */
{
  const session = "0f9c1a2b-1111-4222-8333-444455556666";
  const base = { _backfilled: true, client_source: "claude-code", session_id: session };
  const events: Record<string, unknown>[] = [
    {
      ...base,
      cwd: "/repo/app",
      event_type: "session_start",
      format_version: 1,
      model: "claude-x",
      sequence_number: 1,
      start_trigger: "backfill",
      started_at: "2026-09-01T00:00:00.000Z",
      timestamp: "2026-09-01T00:00:00.000Z",
    },
    {
      ...base,
      event_type: "user_prompt",
      input_source: "user",
      prompt: 'How does auth work? password: "hunter2secretvalue42"',
      prompt_type: "human",
      sequence_number: 2,
      timestamp: "2026-09-01T00:00:00.000Z",
      turn_id: 1,
    },
    {
      ...base,
      event_type: "user_prompt",
      input_source: "user",
      prompt_type: "human",
      sequence_number: 3,
      timestamp: "2026-09-01T00:00:07.000Z",
      turn_id: 1,
    },
    {
      ...base,
      event_type: "tool_use",
      output_summary: "export const KEY = 1;  \r\n",
      phase: "post",
      sequence_number: 4,
      success: true,
      timestamp: "2026-09-01T00:00:07.000Z",
      tool_name: "Read",
      tool_operation: "file.read",
      tool_type: "read",
      tool_use_id: "toolu_01AbCdEfGhJkLmNpQr",
      turn_id: 1,
    },
    {
      ...base,
      event_type: "turn_end",
      model: "claude-x",
      sequence_number: 5,
      timestamp: "2026-09-01T00:00:07.000Z",
      token_usage: null,
      turn_id: 1,
    },
    {
      ...base,
      event_type: "session_end",
      exit_reason: "session_end",
      sequence_number: 6,
      timestamp: "2026-09-01T00:00:07.000Z",
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_token_usage: null,
      total_turns: 1,
    },
  ];
  write(
    "datadog-backfilled-session.datadog-trajectory.jsonl",
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
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
