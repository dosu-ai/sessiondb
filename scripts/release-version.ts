/** Sets server/package.json's version: the release's, which semantic-release has already
 * written into sdks/typescript/package.json. The two move together (release.config.js). */

import { join } from "node:path";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`usage: bun run scripts/release-version.ts <X.Y.Z>; got ${JSON.stringify(version)}`);
  process.exit(2);
}

for (const pkg of ["server", "sdks/typescript"]) {
  const path = join(import.meta.dir, "..", pkg, "package.json");
  const manifest = await Bun.file(path).json();
  if (manifest.version !== version) {
    manifest.version = version;
    await Bun.write(path, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  console.log(`${pkg}/package.json: ${version}`);
}
