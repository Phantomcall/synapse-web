/**
 * semantic-release configuration.
 *
 * Releases are cut from conventional commits on `main` only, so the version in
 * `package.json`, the `CHANGELOG.md` entry, and the GitHub release are all
 * derived from the same commit history rather than maintained by hand.
 *
 * CommonJS because the package has no `"type": "module"`.
 *
 * `conventional-changelog-conventionalcommits` is a devDependency so the
 * `conventionalcommits` preset is resolvable, but it is deliberately *not* listed
 * as a plugin below: it is ESM-only, and semantic-release loads plugins through
 * CJS require, so naming it as a plugin fails with ERR_PACKAGE_PATH_NOT_EXPORTED.
 * semantic-release already defaults to that preset internally.
 */

module.exports = {
  /**
   * Only `main` may cut a release. Release branches exist precisely so that a
   * release can be *prepared* off `main`; publishing from them would allow two
   * concurrent releases.
   */
  branches: ["main"],

  plugins: [
    [
      "@semantic-release/commit-analyzer",
      {
        preset: "conventionalcommits",
        presetConfig: {
          types: [
            { type: "feat", release: "minor" },
            { type: "fix", release: "patch" },
            { type: "perf", release: "patch" },
            // Docs, chores, tests, and CI changes ship without a version bump.
            // A release driven by a README edit is noise.
            { type: "docs", release: false },
            { type: "chore", release: false },
            { type: "refactor", release: false },
            { type: "style", release: false },
            { type: "test", release: false },
            { type: "ci", release: false },
            { type: "build", release: false },
          ],
        },
      },
    ],
    [
      "@semantic-release/release-notes-generator",
      {
        // No `preset` is given: semantic-release already defaults to the
        // conventionalcommits preset internally. Naming the package explicitly
        // fails, because conventional-changelog-conventionalcommits is ESM-only
        // and semantic-release loads plugins through CJS require.
        presetConfig: {
          types: [
            { type: "feat", section: "Features" },
            { type: "fix", section: "Bug Fixes" },
            { type: "perf", section: "Performance" },
            { type: "revert", section: "Reverts" },
          ],
        },
      },
    ],

    // Fail before any release artefact is created if the tree is not releasable.
    [
      "@semantic-release/exec",
      {
        verifyRelease: "npm run build && npm test",
      },
    ],

    ["@semantic-release/changelog", { changelogFile: "CHANGELOG.md" }],
    [
      "@semantic-release/git",
      {
        assets: ["CHANGELOG.md", "package.json", "package-lock.json"],
        message: "chore(release): ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}",
      },
    ],
    [
      "@semantic-release/github",
      {
        assets: [{ path: "CHANGELOG.md", label: "Changelog" }],
        successComment:
          "Release ${nextRelease.version} published.\n\n${nextRelease.notes}\n\n" +
          "The version, `CHANGELOG.md`, and this tag were updated by semantic-release " +
          "from the commits since the previous tag.",
        failComment:
          "semantic-release could not complete. The `version` step above shows the " +
          "first error; no tag or GitHub release was created.",
      },
    ],
  ],
};
