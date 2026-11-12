import { describe, expect, it } from "vitest";
import {
  isSensitivePath,
  namesSensitiveFile,
  redactSensitive,
  runsSecretCommand,
  type SensitiveFiles,
  secretCommands,
  sensitiveFiles,
  sensitiveRules,
} from "./sensitive";

const R = "[redacted:sensitive-file]";
const S = "[redacted:secret-output]";
const files = sensitiveFiles();
const redactSensitiveFiles = (t: string, format: "jsonl" | "json", f: SensitiveFiles) =>
  redactSensitive(t, format, { files: f, commands: [] }).text;
const jsonl = (...rows: object[]) => rows.map((r) => JSON.stringify(r)).join("\n");
const rows = (text: string) => text.split("\n").map((l) => JSON.parse(l));

describe("sensitive file globs", () => {
  it("knows the usual secret files, and the examples that are not", () => {
    for (const path of [
      ".env",
      "/repo/apps/api/.env.local",
      "~/.aws/credentials",
      "/home/me/.ssh/id_ed25519",
      "deploy/tls.key",
      "/Users/me/.docker/config.json",
      "prod.tfvars",
      "C:\\Users\\me\\.npmrc",
    ]) {
      expect(isSensitivePath(path, files), path).toBe(true);
    }
    for (const path of [
      ".env.example",
      "src/env.ts",
      "id_ed25519.pub",
      "config.json",
      "README.md",
      "foo.env.ts",
    ]) {
      expect(isSensitivePath(path, files), path).toBe(false);
    }
  });

  it("takes an org's own globs and exceptions", () => {
    const org = sensitiveFiles(["config/master.key", "secrets/**", "!secrets/README.md", "# note"]);
    expect(isSensitivePath("app/config/master.key", org)).toBe(true);
    expect(isSensitivePath("secrets/db/prod.json", org)).toBe(true);
    expect(isSensitivePath("secrets/README.md", org)).toBe(false);
  });

  it("finds a file named among a command's words", () => {
    expect(namesSensitiveFile("cat .env | grep DB", files)).toBe(true);
    expect(namesSensitiveFile("docker run --env-file=.env.prod app", files)).toBe(true);
    expect(namesSensitiveFile("cp .env.example .env.sample", files)).toBe(false);
  });
});

describe("redactSensitiveFiles", () => {
  it("Claude Code: replaces the result and its toolUseResult, keeps the call", () => {
    const call = {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Reading the env." },
          { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/repo/.env" } },
        ],
      },
    };
    const result = {
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "DB_PASSWORD=hunter2" }],
      },
      toolUseResult: { file: { filePath: "/repo/.env", content: "DB_PASSWORD=hunter2" } },
    };
    const other = {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "toolu_2", content: "ok" }] },
    };
    const input = jsonl(call, result, other);
    const out = redactSensitiveFiles(input, "jsonl", files);
    expect(out).not.toContain("hunter2");
    const [c, r, o] = rows(out);
    expect(c.message.content[1].input.file_path).toBe("/repo/.env");
    expect(r.message.content[0]).toEqual({
      type: "tool_result",
      tool_use_id: "toolu_1",
      content: R,
    });
    expect(r.toolUseResult.file.content).toBe(R);
    // Lines with nothing to replace keep their bytes.
    expect(out.split("\n")[0]).toBe(input.split("\n")[0]);
    expect(out.split("\n")[2]).toBe(JSON.stringify(other));
    expect(o.message.content[0].content).toBe("ok");
  });

  it("Claude Code: an edit to the file keeps its path but not what it wrote", () => {
    const out = redactSensitiveFiles(
      jsonl({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "t",
              name: "Edit",
              input: { file_path: ".env", old_string: "A=1", new_string: "A=s3cret" },
            },
          ],
        },
      }),
      "jsonl",
      files,
    );
    const input = rows(out)[0].message.content[0].input;
    expect(input).toEqual({ file_path: ".env", old_string: R, new_string: R });
  });

  it("Codex: a shell call's JSON arguments and its output by call_id", () => {
    const out = redactSensitiveFiles(
      jsonl(
        {
          type: "response_item",
          payload: {
            type: "function_call",
            name: "shell",
            call_id: "call_9",
            arguments: JSON.stringify({ command: ["bash", "-lc", "cat ~/.aws/credentials"] }),
          },
        },
        {
          type: "response_item",
          payload: { type: "function_call_output", call_id: "call_9", output: "aws_secret=abc" },
        },
        {
          type: "event_msg",
          payload: { type: "exec_command_end", call_id: "call_9", aggregated_output: "abc" },
        },
      ),
      "jsonl",
      files,
    );
    const [call, output, event] = rows(out);
    expect(JSON.parse(call.payload.arguments).command[2]).toBe("cat ~/.aws/credentials");
    expect(output.payload.output).toBe(R);
    expect(event.payload.aggregated_output).toBe(R);
  });

  it("a heredoc into the file keeps the line that names it, not its body", () => {
    const out = redactSensitiveFiles(
      jsonl({
        payload: {
          type: "custom_tool_call",
          call_id: "c",
          input: "cat > .env <<EOF\nTOKEN=abc\nKEY=def\nEOF",
        },
      }),
      "jsonl",
      files,
    );
    expect(rows(out)[0].payload.input).toBe(`cat > .env <<EOF\n${R}`);
  });

  it("Pi: a toolResult message by toolCallId", () => {
    const out = redactSensitiveFiles(
      jsonl(
        {
          message: {
            role: "assistant",
            content: [{ type: "toolCall", id: "p1", name: "read", arguments: { path: "id_rsa" } }],
          },
        },
        {
          message: {
            role: "toolResult",
            toolCallId: "p1",
            toolName: "read",
            content: [{ type: "text", text: "-----BEGIN" }],
            isError: false,
          },
        },
      ),
      "jsonl",
      files,
    );
    const result = rows(out)[1].message;
    expect(result.content).toEqual([{ type: "text", text: R }]);
    expect(result.toolCallId).toBe("p1");
    expect(result.isError).toBe(false);
  });

  it("OpenCode: a part holding its call's input and output in one state", () => {
    const doc = JSON.stringify({
      messages: [
        {
          parts: [
            {
              type: "tool",
              callID: "o1",
              tool: "read",
              state: {
                status: "completed",
                input: { filePath: "/r/.env.production" },
                output: "SECRET=1",
                metadata: { preview: "SECRET=1" },
              },
            },
            { type: "text", text: "done" },
          ],
        },
      ],
    });
    const part = JSON.parse(redactSensitiveFiles(doc, "json", files)).messages[0].parts[0];
    expect(part.state.input).toEqual({ filePath: "/r/.env.production" });
    expect(part.state.output).toBe(R);
    expect(part.state.metadata.preview).toBe(R);
    expect(part.state.status).toBe("completed");
  });

  it("leaves a transcript that touches no sensitive file as it was", () => {
    const t = jsonl({
      message: { content: [{ type: "tool_use", id: "x", name: "Read", input: { path: "a.ts" } }] },
    });
    expect(redactSensitiveFiles(t, "jsonl", files)).toBe(t);
  });
});

describe("what counts as touching a sensitive file", () => {
  const call = (name: string, input: object) =>
    jsonl({ message: { content: [{ type: "tool_use", id: "q", name, input }] } });

  it("not a write whose content only mentions one", () => {
    const t = call("Write", {
      file_path: "src/config.ts",
      content: "// reads .env at startup\nexport const x = 1;",
    });
    expect(redactSensitiveFiles(t, "jsonl", files)).toBe(t);
  });

  it("not prose a tool carries", () => {
    const t = call("report", {
      message: "The server address comes from apps/cli/.env.production.",
    });
    expect(redactSensitiveFiles(t, "jsonl", files)).toBe(t);
  });

  it("a patch by its file headers, not by the code in it", () => {
    const touches = call("apply_patch", {
      input: "*** Begin Patch\n*** Add File: .env\n+TOKEN=abc\n*** End Patch",
    });
    const out = rows(redactSensitiveFiles(touches, "jsonl", files))[0];
    expect(out.message.content[0].input.input).toBe(`${R}\n*** Add File: .env\n${R}`);
    const mentions = call("apply_patch", {
      input: "*** Begin Patch\n*** Update File: src/a.ts\n+load('.env')\n*** End Patch",
    });
    expect(redactSensitiveFiles(mentions, "jsonl", files)).toBe(mentions);
  });
});

describe("secret commands", () => {
  const { commands } = secretCommands();

  it("knows commands that print secrets, wherever they sit in a shell line", () => {
    for (const line of [
      "printenv",
      "printenv GITHUB_TOKEN",
      "env",
      "env | sort",
      "cd app && env",
      "gh auth token",
      "export GH=$(gh auth token)",
      "gh auth status --show-token",
      "sudo -E kubectl get secret db -o yaml",
      "AWS_PROFILE=prod aws configure get aws_secret_access_key",
      "aws ssm get-parameter --name /db/pw --with-decryption",
      "gcloud auth print-access-token",
      "vault kv get secret/app",
      "op read op://vault/item/password",
      "security find-generic-password -s svc -w",
      "echo ok\nheroku config -a app",
    ]) {
      expect(runsSecretCommand(line, commands), line).toBe(true);
    }
  });

  it("leaves ordinary commands alone, including ones that only name a secret tool", () => {
    for (const line of [
      "env FOO=1 npm test",
      "npm run env",
      "grep printenv README.md",
      "gh auth status",
      "kubectl get pods",
      "aws ssm get-parameter --name /app/region",
      "set -euo pipefail",
      "echo 'use gh auth login'",
    ]) {
      expect(runsSecretCommand(line, commands), line).toBe(false);
    }
  });

  it("takes an operator's own commands, and reports those that cannot be used", () => {
    const { commands: own, invalid } = secretCommands(["acme-cli\\s+token\\b", "(", ".*"]);
    expect(runsSecretCommand("acme-cli token --raw", own)).toBe(true);
    expect(invalid.map((i) => i.pattern)).toEqual(["(", ".*"]);
    expect(() => sensitiveRules({ commands: ["("] })).toThrow(/secret command/);
  });

  it("Claude Code: a Bash call that prints a secret keeps its command, not its output", () => {
    const out = redactSensitive(
      jsonl(
        {
          type: "assistant",
          message: {
            content: [
              { type: "tool_use", id: "b1", name: "Bash", input: { command: "gh auth token" } },
            ],
          },
        },
        {
          type: "user",
          message: { content: [{ type: "tool_result", tool_use_id: "b1", content: "gho_abc" }] },
          toolUseResult: { stdout: "gho_abc", stderr: "" },
        },
      ),
      "jsonl",
      sensitiveRules(),
    );
    const [call, result] = rows(out.text);
    expect(call.message.content[0].input.command).toBe("gh auth token");
    expect(result.message.content[0].content).toBe(S);
    expect(result.toolUseResult.stdout).toBe(S);
    expect(out.withheld).toEqual({ b1: "secret-output" });
  });

  it("Codex: a command array with the secret command in its script", () => {
    const out = redactSensitive(
      jsonl(
        {
          payload: {
            type: "function_call",
            call_id: "c1",
            arguments: JSON.stringify({ command: ["bash", "-lc", "printenv | grep KEY"] }),
          },
        },
        { payload: { type: "function_call_output", call_id: "c1", output: "KEY=abc" } },
      ),
      "jsonl",
      sensitiveRules(),
    );
    expect(rows(out.text)[1].payload.output).toBe(S);
  });

  it("does not take a call that only writes a secret command into a file", () => {
    const t = jsonl({
      message: {
        content: [
          {
            type: "tool_use",
            id: "w",
            name: "Write",
            input: { file_path: "docs/setup.md", content: "printenv" },
          },
        ],
      },
    });
    expect(redactSensitive(t, "jsonl", sensitiveRules()).text).toBe(t);
  });
});

describe("a result in a later chunk than its call", () => {
  const call = {
    type: "assistant",
    message: {
      content: [{ type: "tool_use", id: "t9", name: "Read", input: { file_path: ".env" } }],
    },
  };
  const result = {
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "t9", content: "A=secret" }] },
  };

  it("is replaced when the pass starts from what the earlier chunk withheld", () => {
    const first = redactSensitive(jsonl(call), "jsonl", sensitiveRules());
    expect(first.withheld).toEqual({ t9: "sensitive-file" });
    const second = redactSensitive(jsonl(result), "jsonl", sensitiveRules(), first.withheld);
    expect(second.text).not.toContain("A=secret");
    expect(rows(second.text)[0].message.content[0].content).toBe(R);
    expect(second.withheld).toEqual({ t9: "sensitive-file" });
  });

  it("is kept without it, which is why the server carries it", () => {
    const alone = redactSensitive(jsonl(result), "jsonl", sensitiveRules());
    expect(alone.text).toContain("A=secret");
  });
});
