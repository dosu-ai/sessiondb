/** Regenerates the snapshots in `testdata/goldens/`:
 *
 * 1. every transcript in `testdata/transcripts/` is normalized (redacted) and the records
 *    written to `<name>.records.json`; every hand-written record set in `testdata/records/` is
 *    copied in as-is (edge cases no adapter produces);
 * 2. each record set is parsed and what came out — `content_hash`, events, the rest of the
 *    trace, or the rejection — is written to `<name>.expected.json`.
 *
 * `src/trace/goldens.test.ts` asserts `parseTrajectory` still reproduces every expected file,
 * so a change to the hash or the event derivation is a visible diff here, never an accident.
 * Run with `bun run goldens`; commit the outputs. */

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { isSource, normalizeTranscript } from "../src/normalize";
import { TrajectoryError } from "../src/schemas/trajectory";
import { expectedOf } from "../src/trace/goldens";
import { parseTrajectory } from "../src/trace/parse";

const ROOT = resolve(import.meta.dir, "..");
const TRANSCRIPTS = join(ROOT, "testdata", "transcripts");
const RECORDS = join(ROOT, "testdata", "records");
const GOLDENS = join(ROOT, "testdata", "goldens");

rmSync(GOLDENS, { recursive: true, force: true });
mkdirSync(GOLDENS, { recursive: true });

function writeJson(name: string, value: unknown): void {
  writeFileSync(join(GOLDENS, name), `${JSON.stringify(value, null, 2)}\n`);
}

const names: string[] = [];
for (const file of readdirSync(TRANSCRIPTS).sort()) {
  const [name, source] = file.split(".");
  if (!name || !source || !isSource(source)) throw new Error(`${file}: unknown source`);
  const outcome = normalizeTranscript({
    source,
    transcript: readFileSync(join(TRANSCRIPTS, file), "utf8"),
  });
  if (outcome.empty) throw new Error(`${file}: no conversation`);
  writeJson(`${name}.records.json`, outcome.records);
  names.push(name);
  console.log(`${name}: ${outcome.records.length} records from ${source}`);
}
for (const file of readdirSync(RECORDS).sort()) {
  const name = basename(file, ".json");
  writeFileSync(join(GOLDENS, `${name}.records.json`), readFileSync(join(RECORDS, file)));
  names.push(name);
  console.log(`${name}: hand-written records`);
}

for (const name of names) {
  const records = JSON.parse(readFileSync(join(GOLDENS, `${name}.records.json`), "utf8"));
  try {
    const expected = expectedOf(parseTrajectory(records));
    writeJson(`${name}.expected.json`, expected);
    console.log(`${name}: ${expected.content_hash.slice(0, 12)}`);
  } catch (err) {
    if (!(err instanceof TrajectoryError)) throw err;
    writeJson(`${name}.expected.json`, { rejected: true, error: err.message });
    console.log(`${name}: rejected (${err.message})`);
  }
}
