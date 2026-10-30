/** Sets the release's version everywhere semantic-release's npm plugin does not: server/package.json
 * (the SDK's is already written), and the two workspace entries in bun.lock, which `bun install`
 * leaves alone on a version-only change. The two packages move together (release.config.js). */

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

const lockPath = join(import.meta.dir, "..", "bun.lock");
const lock = await Bun.file(lockPath).text();
const synced = lock.replace(
  /("name": "(?:@dosu\/sessiondb|sessiondb-server)",\n\s*"version": ")[^"]+(")/g,
  `$1${version}$2`,
);
if (synced !== lock) await Bun.write(lockPath, synced);
console.log(`bun.lock: ${version}`);
