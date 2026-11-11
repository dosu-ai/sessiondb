import { describe, expect, it } from "vitest";
import { applyRules, parseRedactionConfig, RedactionConfigError, redactionRules } from "./rules";

const jsonl = (...rows: object[]) => rows.map((r) => JSON.stringify(r)).join("\n");

describe("redactionRules", () => {
  it("is the built-in rules with nothing added", () => {
    const rules = redactionRules();
    expect(rules.patterns).toEqual([]);
    expect(rules.sensitive.files.include.length).toBeGreaterThan(10);
    expect(rules.sensitive.commands.length).toBeGreaterThan(10);
  });

  it("refuses, naming every one, patterns and commands that cannot be used", () => {
    try {
      redactionRules({ patterns: ["ok", "(", "a*"], secret_commands: ["["] });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(RedactionConfigError);
      expect((err as RedactionConfigError).problems.map((p) => [p.field, p.pattern])).toEqual([
        ["patterns", "("],
        ["patterns", "a*"],
        ["secret_commands", "["],
      ]);
    }
  });
});

describe("parseRedactionConfig", () => {
  it("reads the file Dosu's CLI writes, ignoring what is about the client", () => {
    const rules = parseRedactionConfig(
      JSON.stringify({
        patterns: ["ACME-\\d+"],
        sensitive_files: ["config/master.key"],
        excluded: ["acme/payments"],
        names_only: [],
        fetched_at: "2026-11-11T00:00:00Z",
      }),
    );
    expect(rules.patterns.map((p) => p.source)).toEqual(["ACME-\\d+"]);
  });

  it("refuses a misspelt field, a list that is not strings, and what is not JSON", () => {
    expect(() => parseRedactionConfig('{"sensitve_files": []}')).toThrow(/sensitve_files/);
    expect(() => parseRedactionConfig('{"patterns": [1]}')).toThrow(/list of strings/);
    expect(() => parseRedactionConfig("patterns:")).toThrow(RedactionConfigError);
    expect(() => parseRedactionConfig("[]")).toThrow(/must be an object/);
  });
});

describe("applyRules", () => {
  it("withholds sensitive calls, then applies the custom patterns", () => {
    const rules = redactionRules({
      patterns: ["cust_[a-z0-9]{6}"],
      sensitive_files: ["config/master.key"],
    });
    const out = applyRules(
      jsonl(
        { type: "user", message: { content: "look up cust_abc123" } },
        {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "m",
                name: "Read",
                input: { file_path: "app/config/master.key" },
              },
            ],
          },
        },
        {
          type: "user",
          message: { content: [{ type: "tool_result", tool_use_id: "m", content: "k3y" }] },
        },
      ),
      "jsonl",
      rules,
    );
    expect(out.text).toContain("look up [redacted:custom-pattern]");
    expect(out.text).not.toContain("k3y");
    expect(out.withheld).toEqual({ m: "sensitive-file" });
  });
});
