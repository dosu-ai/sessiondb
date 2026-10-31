/** Writes the golden bucket the Python SDK's tests read: `sdks/python/tests/fixtures/bucket`,
 * a sessionstorage layout the TypeScript SDK produced from the parity transcripts under owner
 * `acme`, with a clock that ticks one second per write so the change keys are stable. One
 * session is uploaded twice (the second time with `shipped`, so it gets a continuation), one is
 * tombstoned after it was published, and one is too short to be worth a trace (raw only, no
 * head). What the Python reader gets out must equal what this put in: the tests compare keys,
 * hashes and records to `manifest.json`, written here from the same run.
 *
 * Run `bun run scripts/golden-bucket.ts` after a change to the layout, the normalizers or the
 * fixtures, and commit the result. */

import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { FsStore, type Source, StoreSessionDB } from "../sdks/typescript/src/index";

const root = join(import.meta.dir, "..");
const transcripts = join(root, "spec", "testdata", "transcripts");
const out = join(root, "sdks", "python", "tests", "fixtures", "bucket");
const OWNER = "acme";

await rm(out, { recursive: true, force: true });

let tick = Date.parse("2026-10-21T21:04:05.000Z");
const now = () => {
  tick += 1000;
  return new Date(tick);
};
const store = new FsStore(out);
const db = new StoreSessionDB({ store, owner: OWNER, client: "golden-bucket", now });
await db.check();

interface Entry {
  agent: string;
  session_id: string;
  archive_id: string;
  content_hash: string | null;
  records: number;
  status: string;
  note?: string;
}
const manifest: { owner: string; sessions: Entry[] } = { owner: OWNER, sessions: [] };

function line(record: Record<string, unknown>): string {
  return JSON.stringify(record);
}

/** A Claude Code session of `turns` question/answer pairs, long enough to be worth a trace
 * (the pipeline drops anything under 2000 characters of conversation as a greeting). */
function conversation(session: string, turns: number, topic: string, from = 0): string {
  const lines: string[] = [];
  for (let i = from; i < from + turns; i++) {
    const t = new Date(Date.parse("2026-09-01T00:00:00.000Z") + i * 60_000);
    lines.push(
      line({
        type: "user",
        uuid: `u${i}`,
        timestamp: t.toISOString(),
        cwd: "/repo/widget",
        gitBranch: "main",
        sessionId: session,
        message: { role: "user", content: `Question ${i} about ${topic}: how is it wired?` },
      }),
      line({
        type: "assistant",
        uuid: `a${i}`,
        timestamp: new Date(t.getTime() + 5000).toISOString(),
        sessionId: session,
        message: {
          role: "assistant",
          model: "claude-x",
          content: [
            {
              type: "text",
              text:
                `On ${topic}, part ${i}: the request enters through the router, is checked by the ` +
                `middleware chain, and reaches the handler, which reads its settings from the ` +
                `config module and writes through the repository layer. ` +
                `Each layer is tested on its own; see the tests directory for the fixtures. `.repeat(
                  3,
                ),
            },
          ],
        },
      }),
    );
  }
  return `${lines.join("\n")}\n`;
}

async function upload(
  agent: Source,
  session_id: string,
  transcript: string,
  options: {
    format?: "jsonl" | "json";
    branch?: string;
    shipped?: { records: number; prefix_sha256: string };
    note?: string;
  } = {},
): Promise<void> {
  const result = await db.ingest({
    agent,
    session_id,
    transcript,
    format: options.format ?? "jsonl",
    project: "github.com/acme/widget",
    branch: options.branch,
    shipped: options.shipped,
  });
  manifest.sessions.push({
    agent,
    session_id,
    archive_id: result.status === "trivial" ? "" : result.archive_id,
    content_hash: result.status === "trivial" ? null : result.content_hash,
    records: result.status === "trivial" ? 0 : result.records,
    status: result.status,
    note: options.note,
  });
  console.log(`${session_id}: ${result.status}${options.note ? ` (${options.note})` : ""}`);
}

// Three sessions worth a trace, on two branches.
await upload("claude-code", "sess-auth", conversation("auth", 8, "authentication"));
await upload("claude-code", "sess-refactor", conversation("refactor", 8, "the refactor"), {
  branch: "feat/refactor",
});
await upload("claude-code", "sess-perf", conversation("perf", 10, "query latency"));

// The parity transcripts are short: each is stored raw, judged trivial, and gets a pointer
// with no head and no change entry. Two of them, one per raw format.
for (const [file, agent, format] of [
  ["claude-basic.claude-code.jsonl", "claude-code", "jsonl"],
  ["opencode-export.opencode.json", "opencode", "json"],
] as const) {
  await upload(
    agent,
    `sess-${file.split(".")[0]}`,
    await readFile(join(transcripts, file), "utf8"),
    {
      format,
      note: "raw only",
    },
  );
}

// A session that grew: the whole log again with the first answer's `shipped`, plus two more
// turns, so the second trace is a continuation of the first.
{
  const pointer = await db.getSession("claude-code", "sess-auth");
  if (!pointer?.normalized) throw new Error("sess-auth has no normalized state");
  const grown =
    conversation("auth", 8, "authentication") + conversation("auth", 6, "authentication", 8);
  await upload("claude-code", "sess-auth", grown, {
    shipped: {
      records: pointer.normalized.records,
      prefix_sha256: pointer.normalized.prefix_sha256,
    },
    note: "continuation",
  });
}

// Published, then tombstoned: the trace object is gone and the feed says so.
{
  const removed = await db.tombstone("claude-code", "sess-refactor");
  console.log(`tombstone sess-refactor: removed ${removed?.removed ?? 0}`);
  const gone = manifest.sessions.find((s) => s.session_id === "sess-refactor");
  if (gone) gone.note = "tombstoned";
}

await Bun.write(join(out, "..", "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`wrote ${out}`);
