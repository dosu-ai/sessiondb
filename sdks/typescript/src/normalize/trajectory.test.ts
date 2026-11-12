import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isChunkable, isSource, NormalizeError, normalizeTranscript, SOURCES } from "./index";

const RECORDS = JSON.parse(
  readFileSync(
    join(
      import.meta.dirname,
      "..",
      "..",
      "..",
      "..",
      "spec",
      "testdata",
      "goldens",
      "claude-basic.records.json",
    ),
    "utf8",
  ),
) as Record<string, unknown>[];
const jsonl = (rows: unknown[]) => `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;

const GITHUB_TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz012345";

/** The golden's records with a secret put back in, so the pass-through has something to redact. */
const UNREDACTED = RECORDS.map((record, index) =>
  index === 2 ? { ...record, content: `Token is ${GITHUB_TOKEN} here.` } : record,
);

describe("normalizeTranscript for trajectory-v1 records", () => {
  it("is a source, and chunkable", () => {
    expect(SOURCES).toContain("trajectory");
    expect(isSource("trajectory")).toBe(true);
    expect(isChunkable("trajectory")).toBe(true);
  });

  it("passes whole records through, redacted", () => {
    const { records } = normalizeTranscript({
      source: "trajectory",
      transcript: jsonl(UNREDACTED),
    });
    expect(records).toEqual(RECORDS);
    expect(JSON.stringify(records)).not.toContain(GITHUB_TOKEN);
  });

  it("drops the meta record from a chunk", () => {
    const { records } = normalizeTranscript({
      source: "trajectory",
      transcript: jsonl(UNREDACTED),
      chunk: { offset: 0, session_id: "sess1" },
    });
    expect(records).toEqual(RECORDS.slice(1));
  });

  it("normalizes a log's chunks to the whole log's records", () => {
    const head = jsonl(UNREDACTED.slice(0, 2));
    const tail = jsonl(UNREDACTED.slice(2));
    const first = normalizeTranscript({ source: "trajectory", transcript: head });
    const second = normalizeTranscript({
      source: "trajectory",
      transcript: tail,
      chunk: { offset: new TextEncoder().encode(head).length, session_id: "sess1" },
    });
    expect([...first.records, ...second.records]).toEqual(RECORDS);
  });

  it("is empty for a chunk with only a meta record", () => {
    expect(
      normalizeTranscript({
        source: "trajectory",
        transcript: jsonl(RECORDS.slice(0, 1)),
        chunk: { offset: 0, session_id: "sess1" },
      }),
    ).toEqual({ records: [], empty: true });
  });

  it("refuses a record that is not trajectory-v1", () => {
    const bad = jsonl([RECORDS[0], { role: "user", content: 42, timestamp: "2026-09-01" }]);
    expect(() => normalizeTranscript({ source: "trajectory", transcript: bad })).toThrow(
      NormalizeError,
    );
    try {
      normalizeTranscript({ source: "trajectory", transcript: bad });
    } catch (err) {
      expect((err as NormalizeError).code).toBe("invalid_input");
      expect((err as NormalizeError).message).toContain("content must be a string");
    }
  });

  it("refuses a line that is not JSON", () => {
    expect(() =>
      normalizeTranscript({ source: "trajectory", transcript: `${jsonl(RECORDS)}{not json\n` }),
    ).toThrow(/line 6 is not JSON/);
  });
});
