/**
 * Unit tests for the Dependabot auto-merge policy.
 *
 * These run as part of `npm run test` (Vitest picks up `*.test.mjs` via its
 * default include) and they are the reason `scripts/dependabot-automerge/`
 * exists as a pure module: the *decision* is fully verifiable here, even
 * though a *real* Dependabot PR cannot be manufactured to exercise the
 * workflow around it.
 *
 * Every test asserts a specific value. No smoke tests, no `toBeDefined()`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Vitest runs in jsdom, so `import.meta.url` is an http URL - resolve from cwd. */
const repoFile = (relative) => readFileSync(resolve(process.cwd(), relative), "utf8");
import {
  NEVER_AUTO_MERGE,
  bumpLevel,
  categoryFor,
  categoryNote,
  compareVersions,
  decideTriage,
  diffActionRefs,
  diffDependencyMaps,
  evaluateCi,
  exemptRule,
  isClassifiableFile,
  isExemptPackage,
  normaliseActionRef,
  parseVersion,
  readActionRefs,
  readDependencyMap,
  worstLevel,
} from "./policy.mjs";

const CI_JOB = "Lint, typecheck, test, and build";
const greenCheck = (name = CI_JOB) => ({ name, status: "completed", conclusion: "success" });

describe("parseVersion", () => {
  it("parses an exact version", () => {
    expect(parseVersion("16.2.6")).toEqual({ major: 16, minor: 2, patch: 6, prerelease: [] });
  });

  it("strips the caret, tilde and comparison range operators npm manifests use", () => {
    const cases = [
      ["^16.1.0", { major: 16, minor: 1, patch: 0, prerelease: [] }],
      ["~3.2.7", { major: 3, minor: 2, patch: 7, prerelease: [] }],
      [">=1.0.0", { major: 1, minor: 0, patch: 0, prerelease: [] }],
      ["=4.0.0", { major: 4, minor: 0, patch: 0, prerelease: [] }],
      ["  ^0.1.0  ", { major: 0, minor: 1, patch: 0, prerelease: [] }],
      ["v9.1.7", { major: 9, minor: 1, patch: 7, prerelease: [] }],
    ];
    for (const [spec, expected] of cases) {
      expect(parseVersion(spec), spec).toEqual(expected);
    }
  });

  it("parses prerelease identifiers", () => {
    expect(parseVersion("1.0.0-rc.1")).toEqual({
      major: 1,
      minor: 0,
      patch: 0,
      prerelease: ["rc", "1"],
    });
  });

  it("ignores build metadata", () => {
    expect(parseVersion("1.2.3+build.5")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
  });

  it("returns null rather than guessing on partial, compound or non-semver specs", () => {
    for (const spec of [
      "^1.2",
      "latest",
      "workspace:*",
      ">=1.0.0 <2.0.0",
      "file:../x",
      "",
      "1.2.3.4",
      null,
      undefined,
      42,
    ]) {
      expect(parseVersion(spec)).toBeNull();
    }
  });
});

describe("compareVersions", () => {
  it("orders by major, then minor, then patch", () => {
    expect(compareVersions(parseVersion("2.0.0"), parseVersion("1.9.9"))).toBe(1);
    expect(compareVersions(parseVersion("1.2.0"), parseVersion("1.10.0"))).toBe(-1);
    expect(compareVersions(parseVersion("1.0.9"), parseVersion("1.0.10"))).toBe(-1);
    expect(compareVersions(parseVersion("1.2.3"), parseVersion("1.2.3"))).toBe(0);
  });

  it("treats a prerelease as lower than the matching release", () => {
    expect(compareVersions(parseVersion("1.0.0-rc.1"), parseVersion("1.0.0"))).toBe(-1);
    expect(compareVersions(parseVersion("1.0.0"), parseVersion("1.0.0-rc.1"))).toBe(1);
  });

  it("orders numeric prerelease identifiers numerically and below alphanumeric ones", () => {
    expect(compareVersions(parseVersion("1.0.0-rc.2"), parseVersion("1.0.0-rc.10"))).toBe(-1);
    expect(compareVersions(parseVersion("1.0.0-1"), parseVersion("1.0.0-alpha"))).toBe(-1);
  });

  it("ignores build metadata", () => {
    expect(compareVersions(parseVersion("1.2.3+a"), parseVersion("1.2.3+b"))).toBe(0);
  });
});

describe("bumpLevel", () => {
  it("classifies patch, minor and major", () => {
    expect(bumpLevel("16.2.6", "16.2.7")).toBe("patch");
    expect(bumpLevel("16.1.0", "16.2.0")).toBe("minor");
    expect(bumpLevel("3.2.7", "4.0.0")).toBe("major");
  });

  it("treats a prerelease boundary as its own bucket rather than a patch", () => {
    expect(bumpLevel("1.0.0-rc.1", "1.0.0")).toBe("prerelease");
    expect(bumpLevel("1.0.0", "1.0.1-rc.1")).toBe("prerelease");
  });

  it("flags downgrades rather than calling them patches", () => {
    expect(bumpLevel("2.0.0", "1.9.9")).toBe("downgrade");
  });

  it("reports a no-op change", () => {
    expect(bumpLevel("1.2.3", "1.2.3")).toBe("none");
  });

  it("returns unknown when either side cannot be parsed", () => {
    expect(bumpLevel("^1.2", "1.2.3")).toBe("unknown");
    expect(bumpLevel("1.2.3", "latest")).toBe("unknown");
  });

  it("compares the numeric values, not the strings, when a range prefix is present", () => {
    // The classic string-comparison bug: "16.10.0" < "16.9.0" as strings.
    expect(bumpLevel("^16.9.0", "^16.10.0")).toBe("minor");
  });
});

describe("worstLevel", () => {
  it("returns the most severe level present", () => {
    expect(worstLevel(["patch", "patch"])).toBe("patch");
    expect(worstLevel(["patch", "minor"])).toBe("minor");
    expect(worstLevel(["minor", "major", "patch"])).toBe("major");
    expect(worstLevel(["patch", "unknown"])).toBe("unknown");
    expect(worstLevel(["patch", "downgrade"])).toBe("downgrade");
  });
});

describe("exception list", () => {
  it("covers the Stellar SDK and the wallet kit by their real package names", () => {
    expect(isExemptPackage("@stellar/stellar-sdk")).toBe(true);
    expect(isExemptPackage("@creit.tech/stellar-wallets-kit")).toBe(true);
    expect(isExemptPackage("@creit.tech/xbull-wallet-connect")).toBe(true);
  });

  it("gives every exception a category and a written reason", () => {
    for (const rule of NEVER_AUTO_MERGE) {
      expect(rule.category, `${rule.packageName} needs a category`).toBeTruthy();
      expect(rule.why.length, `${rule.packageName} needs a reason`).toBeGreaterThan(20);
    }
  });

  it("does not exempt ordinary dev tooling", () => {
    expect(isExemptPackage("prettier")).toBe(false);
    expect(isExemptPackage("vitest")).toBe(false);
    expect(isExemptPackage("@types/node")).toBe(false);
    expect(exemptRule("prettier")).toBeNull();
  });

  it("exempts an exact package name only, not a prefix of it", () => {
    expect(isExemptPackage("@stellar/stellar-sdk-fork")).toBe(false);
    expect(isExemptPackage("stellar-sdk")).toBe(false);
  });
});

describe("readDependencyMap", () => {
  it("reads this repo's real package.json and finds the packages the policy cares about", () => {
    const map = readDependencyMap(JSON.parse(repoFile("package.json")));

    expect(map.get("@stellar/stellar-sdk")).toEqual({ spec: "^16.1.0", isDevDependency: false });
    expect(map.get("@creit.tech/stellar-wallets-kit")).toEqual({
      spec: "^2.6.0",
      isDevDependency: false,
    });
    expect(map.get("next")).toEqual({ spec: "16.2.6", isDevDependency: false });
    expect(map.get("prettier")).toEqual({ spec: "^3.9.5", isDevDependency: true });
    expect(map.get("vitest")).toEqual({ spec: "^3.2.7", isDevDependency: true });
  });

  it("ignores non-dependency sections such as scripts and lint-staged", () => {
    const map = readDependencyMap(JSON.parse(repoFile("package.json")));
    expect(map.has("scripts")).toBe(false);
    expect(map.has("prepare")).toBe(false);
    expect(map.has("name")).toBe(false);
    // `lint-staged` really is a devDependency, so it belongs in the map.
    expect(map.get("lint-staged")).toEqual({ spec: "^17.1.0", isDevDependency: true });
  });

  it("tolerates a manifest with no dependency sections at all", () => {
    expect(readDependencyMap({ name: "x", version: "1.0.0" }).size).toBe(0);
    expect(readDependencyMap(null).size).toBe(0);
    expect(readDependencyMap({ dependencies: null }).size).toBe(0);
  });
});

describe("diffDependencyMaps", () => {
  const before = readDependencyMap({
    dependencies: { next: "16.2.6", react: "19.2.4" },
    devDependencies: { prettier: "^3.9.5" },
  });

  it("reports only the spec that moved", () => {
    const after = readDependencyMap({
      dependencies: { next: "16.2.7", react: "19.2.4" },
      devDependencies: { prettier: "^3.9.6" },
    });
    const changes = diffDependencyMaps(before, after);
    expect(changes).toHaveLength(2);
    expect(changes.sort((a, b) => a.packageName.localeCompare(b.packageName))).toEqual([
      {
        packageName: "next",
        from: "16.2.6",
        to: "16.2.7",
        isDevDependency: false,
        kind: "updated",
      },
      {
        packageName: "prettier",
        from: "^3.9.5",
        to: "^3.9.6",
        isDevDependency: true,
        kind: "updated",
      },
    ]);
  });

  it("treats a removal as a change, not as silence", () => {
    // `before` holds next + react (deps) and prettier (dev). `after` keeps only
    // next, so both react and prettier are removals.
    const after = readDependencyMap({ dependencies: { next: "16.2.6" } });
    const changes = diffDependencyMaps(before, after);
    expect(changes.map((change) => change.packageName).sort()).toEqual(["prettier", "react"]);
    for (const change of changes) {
      expect(change.kind).toBe("removed");
      expect(change.to).toBe("0.0.0");
      expect(bumpLevel(change.from, change.to)).toBe("downgrade");
    }
  });

  it("ignores additions, which are not version bumps of an existing dependency", () => {
    const after = readDependencyMap({
      dependencies: { next: "16.2.6", react: "19.2.4", "brand-new": "^1.0.0" },
      devDependencies: { prettier: "^3.9.5" },
    });
    expect(diffDependencyMaps(before, after)).toEqual([]);
  });

  it("feeds a real prettier patch straight into an auto-merge decision", () => {
    const after = readDependencyMap({
      dependencies: { next: "16.2.6", react: "19.2.4" },
      devDependencies: { prettier: "^3.9.6" },
    });
    const decision = decideTriage({
      author: "dependabot[bot]",
      isDraft: false,
      changes: diffDependencyMaps(before, after),
      changedFiles: ["package.json", "package-lock.json"],
      checkRuns: [greenCheck()],
      expectedContexts: [CI_JOB],
    });
    expect(decision.action).toBe("auto-merge");
  });

  it("holds a patch bump of the Stellar SDK taken from a real manifest diff", () => {
    const sdkBefore = readDependencyMap({ dependencies: { "@stellar/stellar-sdk": "^16.1.0" } });
    const sdkAfter = readDependencyMap({ dependencies: { "@stellar/stellar-sdk": "^16.1.1" } });
    const decision = decideTriage({
      author: "dependabot[bot]",
      isDraft: false,
      changes: diffDependencyMaps(sdkBefore, sdkAfter),
      checkRuns: [greenCheck()],
      expectedContexts: [CI_JOB],
    });
    expect(decision.action).toBe("hold");
    expect(decision.reasons.join(" ")).toContain("exception list");
  });
});

describe("readActionRefs", () => {
  it("reads this repo's real CI workflow", () => {
    expect(Object.fromEntries(readActionRefs(repoFile(".github/workflows/ci.yml")))).toEqual({
      "actions/checkout": "v4",
      "actions/setup-node": "v4",
    });
  });

  it("handles quoted, list-item and inline-comment forms", () => {
    const refs = readActionRefs(
      [
        "      - uses: actions/checkout@v4",
        '      - uses: "actions/setup-node@v4.2.1"',
        "        uses: actions/cache@v4  # pin me",
        "      - uses: ./.github/actions/local",
        "      - uses: docker://alpine:3.20",
        "      - name: not a uses line",
      ].join("\n")
    );
    expect(Object.fromEntries(refs)).toEqual({
      "actions/checkout": "v4",
      "actions/setup-node": "v4.2.1",
      "actions/cache": "v4",
    });
  });

  it("does not match a `uses:` buried mid-line, where it would be a false positive", () => {
    expect(readActionRefs("run: echo 'uses: actions/checkout@v4'").size).toBe(0);
  });

  it("tolerates empty or non-string input", () => {
    expect(readActionRefs("").size).toBe(0);
    expect(readActionRefs(undefined).size).toBe(0);
  });
});

describe("diffActionRefs", () => {
  it("turns a setup-node patch into a patch change", () => {
    const before = readActionRefs("uses: actions/setup-node@v4.2.0");
    const after = readActionRefs("uses: actions/setup-node@v4.2.1");
    const changes = diffActionRefs(before, after);
    expect(changes).toEqual([
      {
        packageName: "actions/setup-node",
        from: "4.2.0",
        to: "4.2.1",
        isDevDependency: true,
        kind: "updated",
      },
    ]);
    expect(bumpLevel(changes[0].from, changes[0].to)).toBe("patch");
  });

  it("turns a floating major-tag move into a major change that gets held", () => {
    const before = readActionRefs("uses: actions/checkout@v4");
    const after = readActionRefs("uses: actions/checkout@v5");
    const decision = decideTriage({
      author: "dependabot[bot]",
      isDraft: false,
      changes: diffActionRefs(before, after),
      changedFiles: [".github/workflows/ci.yml"],
      checkRuns: [greenCheck()],
      expectedContexts: [CI_JOB],
    });
    expect(decision.action).toBe("hold");
    expect(decision.level).toBe("major");
  });

  it("holds a SHA-to-SHA bump because the version is unknowable", () => {
    const before = readActionRefs(`uses: actions/checkout@${"a".repeat(40)}`);
    const after = readActionRefs(`uses: actions/checkout@${"b".repeat(40)}`);
    const decision = decideTriage({
      author: "dependabot[bot]",
      isDraft: false,
      changes: diffActionRefs(before, after),
      checkRuns: [greenCheck()],
      expectedContexts: [CI_JOB],
    });
    expect(decision.action).toBe("hold");
    expect(decision.level).toBe("unknown");
  });

  it("ignores a ref that did not move", () => {
    const before = readActionRefs("uses: actions/checkout@v4\nuses: actions/setup-node@v4");
    const after = readActionRefs("uses: actions/checkout@v4\nuses: actions/setup-node@v4");
    expect(diffActionRefs(before, after)).toEqual([]);
  });
});

describe("normaliseActionRef", () => {
  it("pads a floating major tag so a major tag move reads as a major bump", () => {
    expect(normaliseActionRef("v4")).toBe("4.0.0");
    expect(bumpLevel(normaliseActionRef("v4"), normaliseActionRef("v5"))).toBe("major");
  });

  it("keeps fully-qualified tags comparable", () => {
    expect(normaliseActionRef("v4.2.2")).toBe("4.2.2");
    expect(bumpLevel(normaliseActionRef("v4.2.2"), normaliseActionRef("v4.2.3"))).toBe("patch");
    expect(bumpLevel(normaliseActionRef("v4.2.2"), normaliseActionRef("v4.3.0"))).toBe("minor");
  });

  it("pads a floating minor tag", () => {
    expect(normaliseActionRef("v4.2")).toBe("4.2.0");
  });

  it("preserves prerelease tags", () => {
    expect(normaliseActionRef("v1.2.3-rc1")).toBe("1.2.3-rc1");
  });

  it("leaves a commit SHA alone, which the policy then holds as unknown", () => {
    const sha = "a".repeat(40);
    expect(normaliseActionRef(sha)).toBe(sha);
    expect(bumpLevel(normaliseActionRef(sha), normaliseActionRef("b".repeat(40)))).toBe("unknown");
  });

  it("does not invent a version for something that is not a ref", () => {
    expect(normaliseActionRef("main")).toBe("main");
    expect(bumpLevel(normaliseActionRef("main"), normaliseActionRef("main"))).toBe("unknown");
  });
});

describe("categoryFor / categoryNote", () => {
  it("routes exempt packages to their exception category", () => {
    expect(categoryFor("@stellar/stellar-sdk", false)).toBe("stellar-sdk");
    expect(categoryFor("@creit.tech/stellar-wallets-kit", false)).toBe("wallet-kit");
  });

  it("classifies dev tooling and runtime deps", () => {
    expect(categoryFor("vitest", true)).toBe("test-tooling");
    expect(categoryFor("prettier", true)).toBe("linting");
    expect(categoryFor("tailwindcss", true)).toBe("app-runtime");
    expect(categoryFor("some-new-runtime-lib", false)).toBe("runtime-dep");
    expect(categoryFor("some-new-dev-lib", true)).toBe("dev-dep");
  });

  it("has a written note for every category it can return", () => {
    for (const name of [
      "@stellar/stellar-sdk",
      "@creit.tech/stellar-wallets-kit",
      "next",
      "vitest",
      "prettier",
      "left-pad",
      "some-dev-thing",
    ]) {
      const category = categoryFor(name, true);
      expect(categoryNote(category).length, `no note for ${name} (${category})`).toBeGreaterThan(
        20
      );
    }
  });
});

describe("isClassifiableFile", () => {
  it("accepts the files a Dependabot PR is allowed to touch", () => {
    expect(isClassifiableFile("package.json")).toBe(true);
    expect(isClassifiableFile("package-lock.json")).toBe(true);
    expect(isClassifiableFile(".github/workflows/ci.yml")).toBe(true);
    expect(isClassifiableFile(".github/dependabot.yml")).toBe(false);
  });

  it("rejects anything else so an unaccounted-for change forces a hold", () => {
    expect(isClassifiableFile("lib/soroban/contract.ts")).toBe(false);
    expect(isClassifiableFile(".github/workflows/nested/dir.yml")).toBe(false);
  });
});

describe("evaluateCi", () => {
  it("accepts a single completed, successful check", () => {
    const result = evaluateCi({ checkRuns: [greenCheck()], expectedContexts: [CI_JOB] });
    expect(result.ok).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("fails closed on an empty check-run list", () => {
    const result = evaluateCi({ checkRuns: [], expectedContexts: [CI_JOB] });
    expect(result.ok).toBe(false);
    expect(result.reasons[0]).toMatch(/no check runs are reported/);
  });

  it("treats every non-success conclusion as a hold, including the subtle ones", () => {
    for (const conclusion of [
      "skipped",
      "cancelled",
      "neutral",
      "timed_out",
      "action_required",
      "stale",
      "startup_failure",
      "failure",
    ]) {
      const result = evaluateCi({
        checkRuns: [{ name: CI_JOB, status: "completed", conclusion }],
        expectedContexts: [CI_JOB],
      });
      expect(result.ok, `${conclusion} must not count as green`).toBe(false);
      expect(result.reasons.join(" ")).toContain(conclusion);
    }
  });

  it("treats a check that has not finished as a hold", () => {
    for (const status of ["queued", "in_progress", "waiting", "pending", "requested"]) {
      const result = evaluateCi({
        checkRuns: [{ name: CI_JOB, status, conclusion: null }],
        expectedContexts: [CI_JOB],
      });
      expect(result.ok, `${status} must not count as green`).toBe(false);
      expect(result.reasons.join(" ")).toMatch(/not finished/);
    }
  });

  it("holds when the expected CI job never reported, even if other checks are green", () => {
    // The paths:-filter case: some unrelated workflow went green, CI never ran.
    const result = evaluateCi({
      checkRuns: [greenCheck("Some Other Workflow")],
      expectedContexts: [CI_JOB],
    });
    expect(result.ok).toBe(false);
    expect(result.reasons.join(" ")).toContain(`expected CI check "${CI_JOB}" has not reported`);
  });

  it("holds when a required branch-protection context is missing", () => {
    const result = evaluateCi({
      checkRuns: [greenCheck()],
      requiredContexts: ["CodeQL"],
      expectedContexts: [CI_JOB],
    });
    expect(result.ok).toBe(false);
    expect(result.reasons.join(" ")).toContain('required context "CodeQL" has not reported');
  });

  it("holds when branch protection itself cannot be read", () => {
    const result = evaluateCi({
      checkRuns: [greenCheck()],
      requiredContextsError: "404 Not Found",
      expectedContexts: [CI_JOB],
    });
    expect(result.ok).toBe(false);
    expect(result.reasons.join(" ")).toContain("branch protection could not be read");
  });

  it("separates required failures from advisory ones for the PR comment", () => {
    const result = evaluateCi({
      checkRuns: [
        greenCheck(),
        { name: "Advisory lint", status: "completed", conclusion: "skipped" },
      ],
      requiredContexts: [CI_JOB],
      expectedContexts: [CI_JOB],
    });
    expect(result.ok).toBe(false);
    expect(result.requiredFailures).toEqual([]);
    expect(result.advisoryFailures).toEqual([
      { name: "Advisory lint", status: "completed", conclusion: "skipped" },
    ]);
  });

  it("reports every observation, not just the first problem", () => {
    const result = evaluateCi({
      checkRuns: [
        { name: "A", status: "completed", conclusion: "failure" },
        { name: "B", status: "queued", conclusion: null },
      ],
    });
    expect(result.reasons).toHaveLength(2);
  });
});

describe("decideTriage", () => {
  const green = { checkRuns: [greenCheck()], expectedContexts: [CI_JOB] };
  const patch = (packageName, from = "1.0.0", to = "1.0.1", extra = {}) => ({
    packageName,
    from,
    to,
    ...extra,
  });

  it("auto-merges a plain patch bump of a non-exempt dependency", () => {
    const decision = decideTriage({
      author: "dependabot[bot]",
      isDraft: false,
      changes: [patch("prettier")],
      changedFiles: ["package.json", "package-lock.json"],
      ...green,
    });
    expect(decision.action).toBe("auto-merge");
    expect(decision.level).toBe("patch");
    expect(decision.reasons).toEqual([]);
    expect(decision.labels).toEqual(
      expect.arrayContaining(["dependencies", "bump:patch", "automerge:approved"])
    );
    expect(decision.labels).not.toContain("needs-human-review");
  });

  it("holds a minor bump", () => {
    const decision = decideTriage({
      author: "dependabot[bot]",
      isDraft: false,
      changes: [patch("vitest", "3.2.7", "3.3.0")],
      ...green,
    });
    expect(decision.action).toBe("hold");
    expect(decision.level).toBe("minor");
    expect(decision.reasons.join(" ")).toContain("is a minor bump, not a patch");
    expect(decision.labels).toContain("needs-human-review");
    expect(decision.labels).toContain("bump:minor");
  });

  it("holds a major bump", () => {
    const decision = decideTriage({
      author: "dependabot[bot]",
      isDraft: false,
      changes: [patch("eslint", "9.39.5", "10.0.0")],
      ...green,
    });
    expect(decision.action).toBe("hold");
    expect(decision.level).toBe("major");
    expect(decision.riskNotes.join(" ")).toBeTruthy();
  });

  it.each([
    ["@stellar/stellar-sdk", "stellar-sdk"],
    ["@creit.tech/stellar-wallets-kit", "wallet-kit"],
    ["next", "app-runtime"],
  ])("holds a PATCH bump of the exempt package %s", (packageName, category) => {
    const decision = decideTriage({
      author: "dependabot[bot]",
      isDraft: false,
      changes: [patch(packageName)],
      ...green,
    });
    expect(decision.action).toBe("hold");
    // The reason must name the package and its category, not just "exempt".
    expect(decision.reasons.join(" ")).toContain(packageName);
    expect(decision.reasons.join(" ")).toContain(category);
    expect(decision.changes[0].exempt).toBe(true);
    expect(decision.changes[0].exemptWhy).toBeTruthy();
  });

  it("holds a grouped PR that mixes a patch with a minor - the worst level wins", () => {
    const decision = decideTriage({
      author: "dependabot[bot]",
      isDraft: false,
      changes: [patch("prettier"), patch("vitest", "3.2.7", "3.3.0")],
      ...green,
    });
    expect(decision.action).toBe("hold");
    expect(decision.level).toBe("minor");
  });

  it("holds a grouped PR that mixes a patch with an exempt package", () => {
    const decision = decideTriage({
      author: "dependabot[bot]",
      isDraft: false,
      changes: [patch("prettier"), patch("@stellar/stellar-sdk")],
      ...green,
    });
    expect(decision.action).toBe("hold");
    expect(decision.reasons.join(" ")).toContain("@stellar/stellar-sdk");
  });

  it("auto-merges a grouped PR of nothing but patches", () => {
    const decision = decideTriage({
      author: "dependabot[bot]",
      isDraft: false,
      changes: [
        patch("prettier"),
        patch("jsdom"),
        patch("@types/node", "20.1.0", "20.1.1", { isDevDependency: true }),
      ],
      changedFiles: ["package.json", "package-lock.json"],
      ...green,
    });
    expect(decision.action).toBe("auto-merge");
    expect(decision.changes).toHaveLength(3);
  });

  it("holds when CI was skipped, cancelled, or never ran", () => {
    for (const checkRuns of [
      [{ name: CI_JOB, status: "completed", conclusion: "skipped" }],
      [{ name: CI_JOB, status: "completed", conclusion: "cancelled" }],
      [{ name: CI_JOB, status: "completed", conclusion: "neutral" }],
      [],
    ]) {
      const decision = decideTriage({
        author: "dependabot[bot]",
        isDraft: false,
        changes: [patch("prettier")],
        checkRuns,
        expectedContexts: [CI_JOB],
      });
      expect(decision.action, JSON.stringify(checkRuns)).toBe("hold");
    }
  });

  it("holds an unparseable version rather than guessing", () => {
    const decision = decideTriage({
      author: "dependabot[bot]",
      isDraft: false,
      changes: [patch("some-lib", "workspace:*", "1.0.0")],
      ...green,
    });
    expect(decision.action).toBe("hold");
    expect(decision.level).toBe("unknown");
    expect(decision.reasons.join(" ")).toContain("is a unknown bump");
  });

  it("holds when no dependency changes could be derived at all", () => {
    const decision = decideTriage({
      author: "dependabot[bot]",
      isDraft: false,
      changes: [],
      ...green,
    });
    expect(decision.action).toBe("hold");
    expect(decision.reasons.join(" ")).toContain("no dependency changes could be derived");
  });

  it("holds when the PR touches a file it cannot classify", () => {
    const decision = decideTriage({
      author: "dependabot[bot]",
      isDraft: false,
      changes: [patch("prettier")],
      changedFiles: ["package.json", "lib/soroban/contract.ts"],
      ...green,
    });
    expect(decision.action).toBe("hold");
    expect(decision.reasons.join(" ")).toContain("lib/soroban/contract.ts");
  });

  it("holds a downgrade", () => {
    const decision = decideTriage({
      author: "dependabot[bot]",
      isDraft: false,
      changes: [patch("prettier", "3.9.5", "3.0.0")],
      ...green,
    });
    expect(decision.action).toBe("hold");
    expect(decision.level).toBe("downgrade");
  });

  it("holds a draft", () => {
    const decision = decideTriage({
      author: "dependabot[bot]",
      isDraft: true,
      changes: [patch("prettier")],
      ...green,
    });
    expect(decision.action).toBe("hold");
    expect(decision.reasons.join(" ")).toContain("draft");
  });

  it("ignores PRs that Dependabot did not author", () => {
    const decision = decideTriage({
      author: "some-human",
      isDraft: false,
      changes: [patch("prettier")],
      ...green,
    });
    expect(decision.action).toBe("hold");
    expect(decision.reasons.join(" ")).toContain("not a Dependabot account");
  });

  it("surfaces every holding reason at once rather than only the first", () => {
    const decision = decideTriage({
      author: "dependabot[bot]",
      isDraft: true,
      changes: [patch("@stellar/stellar-sdk", "16.1.0", "17.0.0")],
      checkRuns: [{ name: CI_JOB, status: "completed", conclusion: "skipped" }],
      expectedContexts: [CI_JOB],
    });
    expect(decision.reasons).toHaveLength(4); // draft, major, exempt, CI skipped
    expect(decision.level).toBe("major");
  });
});
