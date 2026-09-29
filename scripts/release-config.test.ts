import { describe, expect, it } from "vitest";

import { analyzeCommits } from "@semantic-release/commit-analyzer";
import { generateNotes } from "@semantic-release/release-notes-generator";

/**
 * Tests for the release automation described in
 * https://github.com/Synapse-bridgez/synapse-web/issues/159.
 *
 * The configuration under test is `release.config.js`. These tests pin the two
 * things that can silently go wrong: the version arithmetic, and whether a
 * commit type is allowed to trigger a release at all.
 *
 * The plugin options below are duplicated from `release.config.js` on purpose.
 * Importing the config would pull in the `@semantic-release/github` plugin and
 * the rest of the release toolchain, which needs a GitHub token and writes to
 * the repository — neither is possible or desirable in a unit test. The
 * duplication is the trade for being able to test the rules in isolation, so the
 * two must be kept in step if the release policy changes.
 */

const RELEASE_TYPES: { type: string; release: "major" | "minor" | "patch" | false }[] = [
  { type: "feat", release: "minor" },
  { type: "fix", release: "patch" },
  { type: "perf", release: "patch" },
  { type: "revert", release: "patch" },
  { type: "docs", release: false },
  { type: "chore", release: false },
  { type: "refactor", release: false },
  { type: "style", release: false },
  { type: "test", release: false },
  { type: "ci", release: false },
  { type: "build", release: false },
];

const NOTE_TYPES: { type: string; section: string }[] = [
  { type: "feat", section: "Features" },
  { type: "fix", section: "Bug Fixes" },
  { type: "perf", section: "Performance" },
  { type: "revert", section: "Reverts" },
];

/** A commit shaped the way semantic-release passes them to a plugin. */
function commit(message: string) {
  return { hash: "0".repeat(40), message, subject: message.split("\n")[0]! };
}

/** Stands in for semantic-release's own logger, which the plugins log through. */
const logger = { log() {}, error() {}, success: () => ({ log() {} }) };

const options = { repositoryUrl: "https://github.com/Synapse-bridgez/synapse-web.git" };

async function releaseTypeFor(from: string, messages: string[]) {
  return analyzeCommits(
    { preset: "conventionalcommits", presetConfig: { types: RELEASE_TYPES } },
    {
      commits: messages.map(commit),
      lastRelease: { version: from, gitTag: `v${from}`, channels: [null] },
      options,
      cwd: process.cwd(),
      logger,
    }
  );
}

/** Applies semantic-release's version arithmetic to a release type. */
function nextVersion(from: string, type: string | null) {
  if (type === null) return null;
  const [major = 0, minor = 0, patch = 0] = from.split(".").map(Number);
  if (type === "major") return `${major + 1}.0.0`;
  if (type === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

async function versionAfter(from: string, messages: string[]) {
  return nextVersion(from, await releaseTypeFor(from, messages));
}

describe("release version computation", () => {
  it("bumps the minor version for a feat", async () => {
    expect(await versionAfter("0.1.0", ["feat(wallet): add Freighter connect"])).toBe("0.2.0");
  });

  it("bumps the patch version for a fix", async () => {
    expect(await versionAfter("0.1.0", ["fix(origin): validate opaque origin"])).toBe("0.1.1");
  });

  it("bumps the patch version for a perf change", async () => {
    expect(await versionAfter("0.1.0", ["perf(bundle): lazy-load routes"])).toBe("0.1.1");
  });

  it("takes the highest release type across a batch of commits", async () => {
    // A fix and a feat in the same batch must produce a minor, not a patch.
    expect(await versionAfter("0.1.0", ["fix(origin): x", "feat(contract): y"])).toBe("0.2.0");
  });

  it("bumps the major version for a breaking change and leaves 0.x", async () => {
    // Documented behaviour: while the project is pre-1.0, a breaking change is
    // the signal that the project has stabilised, so it goes to 1.0.0.
    expect(await versionAfter("0.1.0", ["feat!: drop node 18"])).toBe("1.0.0");
  });

  it("recognises a BREAKING CHANGE footer", async () => {
    expect(
      await versionAfter("0.1.0", ["feat: rework config\n\nBREAKING CHANGE: env vars renamed"])
    ).toBe("1.0.0");
  });
});

describe("commit types that must not trigger a release", () => {
  const nonReleasing = [
    "docs(readme): document environment variables",
    "chore(deps): bump next to 16",
    "ci: add npm cache",
    "test: raise unit coverage",
    "style: reformat",
    "refactor: extract helper",
    "build: update workflow",
  ];

  it.each(nonReleasing)("produces no release for %s", async (message) => {
    expect(await releaseTypeFor("0.1.0", [message])).toBeNull();
  });

  it("produces no release for a batch of docs and chores alone", async () => {
    // The important case: a docs-only merge must not churn the version.
    expect(await releaseTypeFor("0.1.0", nonReleasing)).toBeNull();
  });

  it("still releases when a fix is mixed in with non-releasing commits", async () => {
    expect(await versionAfter("0.1.0", ["docs: x", "chore: y", "fix: z"])).toBe("0.1.1");
  });
});

describe("changelog generation", () => {
  const fixture = [
    "feat(wallet): add Freighter connect",
    "feat(contract): add tx submission flow",
    "fix(origin): validate opaque origin",
    "perf(bundle): lazy-load route components",
    "docs(readme): document environment variables",
    "chore(deps): bump next to 16",
  ];

  async function notesFor(from: string, nextReleaseVersion: string) {
    return generateNotes(
      { presetConfig: { types: NOTE_TYPES } },
      {
        commits: fixture.map(commit),
        lastRelease: { version: from, gitTag: `v${from}`, channels: [null] },
        nextRelease: {
          version: nextReleaseVersion,
          gitTag: `v${nextReleaseVersion}`,
          channels: [null],
          name: nextReleaseVersion,
          notes: "",
        },
        options,
        cwd: process.cwd(),
        logger,
      }
    );
  }

  it("groups entries under Features, Bug Fixes, and Performance", async () => {
    const notes = await notesFor("0.1.0", "0.2.0");

    expect(notes).toContain("### Features");
    expect(notes).toContain("### Bug Fixes");
    expect(notes).toContain("### Performance Improvements");
  });

  it("lists each released commit with its scope", async () => {
    const notes = await notesFor("0.1.0", "0.2.0");

    expect(notes).toContain("**wallet:** add Freighter connect");
    expect(notes).toContain("**contract:** add tx submission flow");
    expect(notes).toContain("**origin:** validate opaque origin");
    expect(notes).toContain("**bundle:** lazy-load route components");
  });

  it("omits non-releasing commit types from the notes", async () => {
    const notes = await notesFor("0.1.0", "0.2.0");

    expect(notes).not.toContain("document environment variables");
    expect(notes).not.toContain("bump next to 16");
  });

  it("links the release to the previous tag", async () => {
    const notes = await notesFor("0.1.0", "0.2.0");

    expect(notes).toContain("v0.1.0...v0.2.0");
  });
});
