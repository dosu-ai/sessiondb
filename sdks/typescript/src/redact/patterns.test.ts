import { describe, expect, it } from "vitest";
import { compilePatterns, redactPatterns, redactTranscriptPatterns } from "./patterns";

const R = "[redacted:custom-pattern]";
const compile = (...sources: string[]) => compilePatterns(sources).patterns;

describe("compilePatterns", () => {
  it("leaves out what does not compile or matches empty text, and says why", () => {
    const { patterns, invalid } = compilePatterns(["ACME-\\d+", "(", "x*", "  "]);
    expect(patterns.map((p) => p.source)).toEqual(["ACME-\\d+"]);
    expect(invalid.map((i) => i.pattern)).toEqual(["(", "x*"]);
    expect(invalid[1].reason).toBe("matches empty text");
  });
});

describe("redactPatterns", () => {
  it("replaces every match", () => {
    expect(redactPatterns("a ACME-12 b ACME-3", compile("ACME-\\d+"))).toBe(`a ${R} b ${R}`);
  });

  it("replaces only the secret group, keeping the rest of the match", () => {
    const patterns = compile("internal-key: (?<secret>\\S+)");
    expect(redactPatterns("internal-key: abc123 then internal-key: zz", patterns)).toBe(
      `internal-key: ${R} then internal-key: ${R}`,
    );
  });

  it("applies each pattern in turn and returns the same string when nothing matched", () => {
    const patterns = compile("cust_[a-z0-9]{6}", "ACME-\\d+");
    expect(redactPatterns("cust_abc123 ACME-9", patterns)).toBe(`${R} ${R}`);
    const text = "nothing here";
    expect(redactPatterns(text, patterns)).toBe(text);
  });

  it("names its own kind when given one", () => {
    expect(redactPatterns("ACME-1", compile("ACME-\\d"), "org-pattern")).toBe(
      "[redacted:org-pattern]",
    );
  });
});

describe("redactTranscriptPatterns", () => {
  const line = (text: string) =>
    JSON.stringify({ role: "user", message: { content: [{ type: "text", text }] } });

  it("redacts string values only and keeps lines with nothing to replace byte for byte", () => {
    const keep = '{"a":  1, "text": "fine"}';
    const transcript = `${keep}\n${line('key is "ACME-42"\nok')}\n`;
    const out = redactTranscriptPatterns(transcript, "jsonl", compile("ACME-\\d+"));
    const [first, second, last] = out.split("\n");
    expect(first).toBe(keep);
    expect(JSON.parse(second).message.content[0].text).toBe(`key is "${R}"\nok`);
    expect(last).toBe("");
  });

  it("does not touch keys, and redacts a line that is not JSON as text", () => {
    const out = redactTranscriptPatterns(
      `{"ACME-1":"ACME-2"}\nplain ACME-3`,
      "jsonl",
      compile("ACME-\\d"),
    );
    expect(out).toBe(`{"ACME-1":"${R}"}\nplain ${R}`);
  });

  it("redacts a whole JSON document", () => {
    const doc = JSON.stringify({ messages: [{ parts: ["ACME-7", 3] }] });
    expect(
      JSON.parse(redactTranscriptPatterns(doc, "json", compile("ACME-\\d"))).messages[0].parts,
    ).toEqual([R, 3]);
  });

  it("is the transcript itself without patterns, and the same output for the same input", () => {
    const t = line("ACME-1");
    expect(redactTranscriptPatterns(t, "jsonl", [])).toBe(t);
    const p = compile("ACME-\\d");
    expect(redactTranscriptPatterns(t, "jsonl", p)).toBe(redactTranscriptPatterns(t, "jsonl", p));
  });
});
