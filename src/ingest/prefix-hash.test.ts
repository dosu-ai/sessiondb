import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { NormalizedRecord } from "../schemas/trajectory";
import { prefixSha256 } from "./continuation";
import { PrefixHash, ResumableSha256 } from "./prefix-hash";

const reference = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe("ResumableSha256", () => {
  it("matches node:crypto for every length around the block boundaries", () => {
    for (let length = 0; length <= 300; length++) {
      const bytes = randomBytes(length);
      expect(new ResumableSha256().update(bytes).digest()).toBe(reference(bytes));
    }
  });

  it("the digest is the same however the input is cut, and after a save and resume", () => {
    const bytes = randomBytes(1000);
    for (const cut of [0, 1, 55, 56, 63, 64, 65, 127, 128, 500, 999, 1000]) {
      const first = new ResumableSha256().update(bytes.subarray(0, cut));
      const digestBefore = first.digest();
      const resumed = ResumableSha256.resume(first.export());
      expect(resumed.digest()).toBe(digestBefore);
      expect(resumed.update(bytes.subarray(cut)).digest()).toBe(reference(bytes));
      // Digesting did not disturb the stream.
      expect(first.update(bytes.subarray(cut)).digest()).toBe(reference(bytes));
    }
  });

  it("refuses a state that is not one", () => {
    expect(() => ResumableSha256.resume("nope")).toThrow("invalid sha256 state");
    // 65 bytes hashed leaves one pending; a state with none is not one this made.
    expect(() => ResumableSha256.resume(`${"0".repeat(64)}:65:`)).toThrow("invalid sha256 state");
  });
});

describe("PrefixHash", () => {
  const records: NormalizedRecord[] = Array.from({ length: 10 }, (_, i) => ({
    role: "assistant" as const,
    content: `turn ${i} ${"x".repeat(i * 7)}`,
    timestamp: `2026-01-01T00:00:${String(i).padStart(2, "0")}Z`,
  }));

  it("after n records, the digest is prefixSha256(records, n)", () => {
    const hash = PrefixHash.empty();
    expect(hash.digest()).toBe(prefixSha256(records, 0));
    records.forEach((record, i) => {
      hash.append(record);
      expect(hash.records).toBe(i + 1);
      expect(hash.digest()).toBe(prefixSha256(records, i + 1));
    });
    expect(PrefixHash.of(records).digest()).toBe(prefixSha256(records, records.length));
  });

  it("resumes between chunks", () => {
    const first = PrefixHash.of(records.slice(0, 4));
    const second = PrefixHash.resume(first.export());
    for (const record of records.slice(4)) second.append(record);
    expect(second.records).toBe(10);
    expect(second.digest()).toBe(prefixSha256(records, 10));
    expect(() => PrefixHash.resume("x:nope")).toThrow("invalid prefix hash state");
  });
});
