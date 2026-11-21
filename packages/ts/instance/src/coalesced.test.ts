import { describe, expect, it } from "vitest";
import { Coalesced } from "./coalesced";

describe("Coalesced", () => {
  it("runs one at a time and shares the next run among callers that wait", async () => {
    const one = new Coalesced<number>();
    let runs = 0;
    const releases: (() => void)[] = [];
    const task = () =>
      new Promise<number>((resolve) => {
        const n = ++runs;
        releases.push(() => resolve(n));
      });
    const a = one.run(task);
    const b = one.run(task);
    const c = one.run(task);
    expect(runs).toBe(1);
    releases[0]?.();
    expect(await a).toBe(1);
    await Promise.resolve();
    expect(runs).toBe(2);
    releases[1]?.();
    expect(await b).toBe(2);
    expect(await c).toBe(2);
  });
});
