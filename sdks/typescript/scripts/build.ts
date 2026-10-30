/** Builds `dist/`: the SDK as one ESM file Node and Bun both load, plus its declarations. The
 * package's `bun` export condition points at `src/`, so Bun consumers (and this workspace) run
 * the TypeScript directly; `dist/` is for everyone else, and for every consumer's type-checker.
 * `bun run build`, also `prepack`. */

import { rmSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const dist = join(root, "dist");
rmSync(dist, { recursive: true, force: true });

const bundle = await Bun.build({
  entrypoints: [join(root, "src", "index.ts")],
  outdir: dist,
  target: "node",
  format: "esm",
  packages: "external",
  sourcemap: "linked",
});
if (!bundle.success) {
  for (const log of bundle.logs) console.error(log);
  process.exit(1);
}

const types = Bun.spawnSync(["bunx", "tsc", "-p", join(root, "tsconfig.build.json")], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
});
if (types.exitCode !== 0) process.exit(types.exitCode);

const files = (await Array.fromAsync(new Bun.Glob("**/*").scan(dist))).sort();
console.log(
  `dist/: ${files.length} files\n  ${files.slice(0, 8).join("\n  ")}${files.length > 8 ? "\n  …" : ""}`,
);
