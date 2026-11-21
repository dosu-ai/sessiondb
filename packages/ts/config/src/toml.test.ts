import { describe, expect, it } from "vitest";
import { stringifyToml } from "./toml";

describe("stringifyToml", () => {
  it("round-trips a config tree through Bun's parser", () => {
    const tree = {
      default_visibility: "owner",
      filter: { enabled: true, min_chars: 40 },
      redaction: { packs: ["packs/acme.json", "packs/x y.toml"] },
      capture: { exclude: ['a/"b"', "~/secret\u007f"], allow_retract: false },
      review: {
        required: false,
        policies: [
          {
            id: "p1",
            sources: ["upload"],
            decision: { api_key: { env: "ANTHROPIC_API_KEY" }, model: "m" },
            redactor: { categories: [{ name: "names", description: "people", examples: [] }] },
          },
          { id: "p2", decision: { api_key: { env: "K" } } },
        ],
      },
      records: { "dotted.key": 1.5 },
    };
    const text = stringifyToml(tree);
    expect(Bun.TOML.parse(text)).toEqual(tree);
  });
});
