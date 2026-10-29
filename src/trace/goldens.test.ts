/** For every golden in `testdata/goldens/`, `parseTrajectory` must still produce the committed
 * `content_hash`, events and trace fields, or reject with `TrajectoryError` where the golden
 * says so. `content_hash` is a layout contract (`docs/layout.md`): a change here is a change
 * every reader sees, so it has to be a deliberate `bun run goldens` and a diff in review. */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TrajectoryError } from "../schemas/trajectory";
import { type Expected, expectedOf } from "./goldens";
import { parseTrajectory } from "./parse";

const GOLDENS = join(import.meta.dirname, "..", "..", "testdata", "goldens");

const names = readdirSync(GOLDENS)
  .filter((f) => f.endsWith(".records.json"))
  .map((f) => f.slice(0, -".records.json".length))
  .sort();

describe("goldens", () => {
  it("has goldens to check", () => {
    expect(names.length).toBeGreaterThan(0);
  });

  for (const name of names) {
    const records = JSON.parse(readFileSync(join(GOLDENS, `${name}.records.json`), "utf8"));
    const expected: Expected = JSON.parse(
      readFileSync(join(GOLDENS, `${name}.expected.json`), "utf8"),
    );

    if (expected.rejected) {
      it(`${name}: rejected (${expected.error})`, () => {
        expect(() => parseTrajectory(records)).toThrow(TrajectoryError);
        expect(() => parseTrajectory(records)).toThrow(expected.error);
      });
      continue;
    }

    it(`${name}: content_hash ${expected.content_hash.slice(0, 12)}`, () => {
      expect(expectedOf(parseTrajectory(records))).toEqual(expected);
    });
  }
});
