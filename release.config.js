/** Every push to main that carries a Conventional Commit is a release, the way dosu-cli
 * releases: semantic-release reads the commits since the last `vX.Y.Z` tag, picks the next
 * version, and publishes @dosu/sessiondb to npm; the `release` job in ci.yml then builds
 * ghcr.io/dosu-ai/sessiondb at the same version. The SDK and the server share one version
 * (what traces record as their normalizer, and what /healthz reports), so one tag is one
 * release of both.
 *
 * @type {import('semantic-release').GlobalConfig} */
export default {
  branches: ["main"],
  plugins: [
    "@semantic-release/commit-analyzer",
    "@semantic-release/release-notes-generator",
    "@semantic-release/changelog",
    // Writes the version into sdks/typescript/package.json and publishes from there. Scripts
    // are off for that publish (NPM_CONFIG_IGNORE_SCRIPTS in ci.yml): dist/ is built below.
    ["@semantic-release/npm", { pkgRoot: "sdks/typescript" }],
    [
      "@semantic-release/exec",
      {
        // After the npm plugin has written the SDK's version: give the server the same one,
        // refresh bun.lock (it records workspace versions; a stale one fails the next
        // --frozen-lockfile install), and build dist/ so it carries the new version.
        prepareCmd:
          "bun run scripts/release-version.ts ${nextRelease.version} && bun install && bun run --cwd sdks/typescript build",
        successCmd:
          "echo 'released=true' >> $GITHUB_OUTPUT && echo 'version=${nextRelease.version}' >> $GITHUB_OUTPUT",
      },
    ],
    "@semantic-release/github",
    [
      "@semantic-release/git",
      {
        assets: ["sdks/typescript/package.json", "server/package.json", "bun.lock", "CHANGELOG.md"],
        message: "chore(release): ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}",
      },
    ],
  ],
};
