/** Every push to main that carries a Conventional Commit is a release, the way dosu-cli
 * releases: semantic-release reads the commits since the last `vX.Y.Z` tag, picks the next
 * version, and publishes @dosu/sessiondb to npm; the `release` job in ci.yml then builds
 * ghcr.io/dosu-ai/sessiondb at the same version. The SDK and the server share one version
 * (what traces record as their normalizer, and what /healthz reports), so one tag is one
 * release of both.
 *
 * npm is driven directly rather than through @semantic-release/npm: that plugin runs
 * `npm version` inside sdks/typescript, where npm finds the Bun workspace root above it, loads
 * the whole tree and rejects server/package.json's `workspace:*` dependency. `--workspaces=false`
 * keeps npm inside the SDK directory, and only the command line can set it.
 *
 * @type {import('semantic-release').GlobalConfig} */
export default {
  branches: ["main"],
  plugins: [
    "@semantic-release/commit-analyzer",
    "@semantic-release/release-notes-generator",
    "@semantic-release/changelog",
    [
      "@semantic-release/exec",
      {
        // actions/setup-node writes the npm token from NODE_AUTH_TOKEN into the user .npmrc.
        verifyConditionsCmd:
          "test -n \"$NODE_AUTH_TOKEN\" || { echo 'NODE_AUTH_TOKEN (the npm token) is not set' >&2; exit 1; }",
        // Write the version into both package.json files and bun.lock, and build dist/ so it
        // carries the new version. (@semantic-release/git commits those files below.)
        prepareCmd:
          "bun run scripts/release-version.ts ${nextRelease.version} && bun run --cwd sdks/typescript build",
        // Scripts are off for this publish (NPM_CONFIG_IGNORE_SCRIPTS in ci.yml): dist/ was just
        // built, so prepack must not rebuild it. Provenance comes from NPM_CONFIG_PROVENANCE.
        publishCmd: "cd sdks/typescript && npm publish --workspaces=false --access public",
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
