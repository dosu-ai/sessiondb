import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sessiondb-main-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Boot the server with `env` and give it a moment: what it printed, and its exit code if it
 * stopped. */
async function boot(env: Record<string, string>): Promise<{ code: number | null; out: string }> {
  const proc = Bun.spawn(["bun", join(import.meta.dirname, "main.ts")], {
    env: {
      PATH: process.env.PATH ?? "",
      SESSIONDB_TOKEN: "sdb_test-token-0123456789abcdef",
      SESSIONDB_STORE_URL: `file://${join(dir, "bucket")}`,
      PORT: "0",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const exited = await Promise.race([proc.exited, Bun.sleep(3000).then(() => null)]);
  if (exited === null) proc.kill();
  const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
  return { code: exited, out };
}

describe("SESSIONDB_REDACTION_FILE", () => {
  it("refuses to start on a pattern that cannot be used", async () => {
    const file = join(dir, "redaction.json");
    writeFileSync(file, JSON.stringify({ patterns: ["("] }));
    const { code, out } = await boot({ SESSIONDB_REDACTION_FILE: file });
    expect(code).toBe(1);
    expect(out).toContain("patterns '('");
  });

  it("starts with a usable file and says what it added", async () => {
    const file = join(dir, "redaction.json");
    writeFileSync(file, JSON.stringify({ patterns: ["ACME-\\d+"], sensitive_files: ["*.secret"] }));
    const { code, out } = await boot({ SESSIONDB_REDACTION_FILE: file });
    expect(code).toBeNull();
    expect(out).toContain("1 pattern(s) on top of the built-in rules");
  });
});
