/**
 * Dependabot auto-merge policy.
 *
 * This module is deliberately pure: no network, no filesystem, no environment,
 * no clock. Everything it needs arrives as an argument and everything it
 * produces is JSON-serialisable. That is what makes it unit-testable, and
 * unit-testable is the point - the workflow around it can only be exercised by
 * a real Dependabot PR, but the *decision* can be verified for every branch of
 * the policy, including the ones that are painful to reproduce in anger
 * (a skipped check, a cancelled check, a grouped PR that contains a major).
 *
 * The policy, stated once:
 *
 *   Auto-merge  <=>  every dependency change in the PR is a `patch`,
 *                    AND none of them is on the security-sensitive exception
 *                    list, AND every check run on the head commit is
 *                    `completed` with conclusion `success`, AND the expected CI
 *                    job actually reported, AND no branch-protection required
 *                    context is missing.
 *
 * Every one of those conditions fails closed. An unparseable version, an
 * unknown package, a missing check run, an unreachable API: all of them mean
 * "hold for a human", never "merge anyway".
 */

/**
 * Packages that must never be auto-merged, at any semver level.
 *
 * `packageName` is matched exactly. These are the actual direct and
 * transitive dependencies of this repo as of `main`; the list is intentionally
 * a flat, editable array so that adding a wallet connector or a new Stellar
 * library is a one-line change with a stated reason next to it.
 *
 * The rationale is the same for all of them: this is a dashboard that holds
 * wallet credentials in the browser and builds and submits signed Soroban
 * transactions. A silently-merged change in any of these packages is a change
 * to key handling, transaction serialisation, or the code that renders what the
 * user is about to sign. "Patch" releases in libraries that handle secrets are
 * not automatically low risk, and the cost of a human spending 60 seconds
 * reading a changelog is far below the cost of a bad one.
 */
export const NEVER_AUTO_MERGE = [
  {
    packageName: "@stellar/stellar-sdk",
    category: "stellar-sdk",
    why: "The Soroban SDK. Owns ScVal/XDR encoding, TransactionBuilder, and the rpc.Server calls in lib/soroban/. A silent change here alters what we serialise and submit on-chain.",
  },
  {
    packageName: "@creit.tech/stellar-wallets-kit",
    category: "wallet-kit",
    why: "The wallet kit. Owns key access, the auth modal, and signing. Direct dependency.",
  },
  {
    packageName: "@creit.tech/xbull-wallet-connect",
    category: "wallet-kit",
    why: "xBull wallet connector, pulled in transitively by the wallet kit. Included so a direct Dependabot PR for it cannot slip past the wallet-kit rule.",
  },
  {
    packageName: "next",
    category: "app-runtime",
    why: "The framework that produces the deployed artifact, and the router the whole app runs on. A bad patch is a production incident, not a lint nit.",
  },
  {
    packageName: "react",
    category: "app-runtime",
    why: "Ships in the client bundle and defines component semantics. Runtime behaviour, not a build detail.",
  },
  {
    packageName: "react-dom",
    category: "app-runtime",
    why: "Ships in the client bundle. Hydration and reconciliation behaviour is user-visible.",
  },
];

/** How a non-exception package is described in the human-review summary. */
const CATEGORY_NOTES = {
  "stellar-sdk":
    "Soroban SDK: verify XDR/ScVal encoding, rpc.Server response shapes, and TransactionBuilder usage in lib/soroban/ still behave. SDK minors have moved envelope and fee handling before.",
  "wallet-kit":
    "Wallet kit: verify Freighter and xBull modules still initialise, the auth modal still opens, and the storage keys in lib/wallet/storage.ts still match what the kit persists.",
  "app-runtime":
    "App runtime: expect build-output and hydration changes. Check `npm run build` output, route list, and client bundle behaviour.",
  "test-tooling":
    "Test/build tooling: dev-only, no production bundle impact, but CI and the Husky hooks depend on it.",
  linting:
    "Linting/formatting tooling: dev-only, but it decides whether pre-commit blocks a commit, so check the config still loads.",
  "runtime-dep":
    "Ships in the production bundle. Read the changelog for behavioural changes and API removals.",
  "dev-dep":
    "Development-only. No production bundle impact, but it can change local tooling, CI, or test results.",
};

const EXEMPT_BY_NAME = new Map(NEVER_AUTO_MERGE.map((rule) => [rule.packageName, rule]));

export function exemptRule(packageName) {
  return EXEMPT_BY_NAME.get(packageName) ?? null;
}

export function isExemptPackage(packageName) {
  return EXEMPT_BY_NAME.has(packageName);
}

/**
 * Classify a package for the human-review note. Deliberately coarse: this
 * drives a sentence in a comment, not a gate.
 */
export function categoryFor(packageName, isDevDependency) {
  if (EXEMPT_BY_NAME.has(packageName)) return EXEMPT_BY_NAME.get(packageName).category;
  if (/^eslint|^prettier/.test(packageName)) return "linting";
  if (/^vitest|^jest|^@vitest|^@playwright|^jsdom|^@testing-library/.test(packageName)) {
    return "test-tooling";
  }
  if (/^@types\//.test(packageName)) return "dev-dep";
  if (/^next|^react|^react-dom|^tailwindcss/.test(packageName)) return "app-runtime";
  return isDevDependency ? "dev-dep" : "runtime-dep";
}

export function categoryNote(category) {
  return CATEGORY_NOTES[category] ?? CATEGORY_NOTES["dev-dep"];
}

// ---------------------------------------------------------------------------
// Minimal semver
// ---------------------------------------------------------------------------

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
// Strip exactly one range operator. A compound range such as ">=1.0.0 <2.0.0"
// deliberately does not fully parse - we would rather hold than guess.
const RANGE_PREFIX_RE = /^(?:\^|~|>=|<=|>|<|=)\s*/;

/**
 * Parse a semver spec as it appears in a manifest. Returns null for anything we
 * are not certain about, including partial versions (`^1.2`) and compound
 * ranges. `null` propagates to a hold, which is the intended behaviour.
 */
export function parseVersion(spec) {
  if (typeof spec !== "string") return null;
  const trimmed = spec.trim().replace(/^["']|["']$/g, "");
  if (trimmed === "") return null;
  const match = VERSION_RE.exec(trimmed.replace(RANGE_PREFIX_RE, ""));
  if (!match) return null;
  const prerelease = match[4] === undefined ? [] : match[4].split(".");
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
  };
}

function comparePrerelease(a, b) {
  // A version without a prerelease outranks one with it (1.0.0 > 1.0.0-rc.1).
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;

  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) {
      const delta = Number(x) - Number(y);
      if (delta !== 0) return delta < 0 ? -1 : 1;
    } else if (xNumeric !== yNumeric) {
      // Numeric identifiers always have lower precedence than alphanumeric ones.
      return xNumeric ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** -1 | 0 | 1. Build metadata is ignored, per semver. */
export function compareVersions(a, b) {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return comparePrerelease(a.prerelease, b.prerelease);
}

/**
 * "patch" | "minor" | "major" | "prerelease" | "downgrade" | "none" | "unknown"
 *
 * `unknown` for anything either side of which fails to parse, and
 * `prerelease` as its own bucket because a pre-release boundary (1.0.0-rc.1 ->
 * 1.0.0) is nominally a patch move but is exactly the kind of thing a human
 * should see.
 */
export function bumpLevel(fromSpec, toSpec) {
  const from = parseVersion(fromSpec);
  const to = parseVersion(toSpec);
  if (!from || !to) return "unknown";
  if (from.prerelease.length > 0 || to.prerelease.length > 0) return "prerelease";

  const order = compareVersions(from, to);
  if (order === 0) return "none";
  if (order > 0) return "downgrade";
  if (to.major !== from.major) return "major";
  if (to.minor !== from.minor) return "minor";
  return "patch";
}

// ---------------------------------------------------------------------------
// GitHub Actions refs
// ---------------------------------------------------------------------------

/**
 * Turn a GitHub Action ref into something `bumpLevel` can reason about.
 *
 * Action refs are not npm specs, so they need translating first:
 *
 *   "v4"        -> "4.0.0"   floating major tag, so v4 -> v5 is a MAJOR bump
 *   "v4.2"      -> "4.2.0"   floating minor tag
 *   "v4.2.2"    -> "4.2.2"   pinned tag
 *   "v1.2.3-rc1"-> "1.2.3-rc1"
 *   "<40-hex>"  -> left as-is, which `bumpLevel` classifies as "unknown" and
 *                  therefore holds. A SHA-to-SHA bump tells us nothing about the
 *                  version, and we do not resolve SHAs to tags over the network
 *                  inside a merge decision.
 *
 * The padding is what stops `v4` -> `v5` from being silently unparseable, and
 * getting a *wrong answer* (auto-merge) instead of the *right* one (hold).
 */
export function normaliseActionRef(ref) {
  if (typeof ref !== "string") return "";
  const trimmed = ref.trim();
  if (/^[0-9a-f]{40}$/.test(trimmed)) return trimmed;
  const withoutV = trimmed.replace(/^v/, "");
  if (!/^\d+(\.\d+){0,2}(-[0-9A-Za-z.-]+)?$/.test(withoutV)) return trimmed;
  const [core, ...rest] = withoutV.split("-");
  const parts = core.split(".");
  while (parts.length < 3) parts.push("0");
  return `${parts.join(".")}${rest.length > 0 ? `-${rest.join("-")}` : ""}`;
}

// ---------------------------------------------------------------------------
// Deriving the change set from the files a Dependabot PR actually touched
// ---------------------------------------------------------------------------

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

/**
 * Flatten a package.json into `{ name -> { spec, isDevDependency } }`.
 *
 * First field wins, so a package listed in both `dependencies` and
 * `devDependencies` gets one stable classification rather than a
 * last-write-wins flip that would change the risk note between runs.
 */
export function readDependencyMap(manifest) {
  const map = new Map();
  for (const field of DEPENDENCY_FIELDS) {
    const section = manifest?.[field];
    if (!section || typeof section !== "object") continue;
    for (const [name, spec] of Object.entries(section)) {
      if (!map.has(name)) {
        map.set(name, { spec, isDevDependency: field !== "dependencies" });
      }
    }
  }
  return map;
}

const USES_RE = /^[^\S\n]*-?[^\S\n]*uses:[^\S\n]*["']?([^"'\s#]+)["']?/gm;

/**
 * Extract `{ "actions/checkout" -> "v4.2.2" }` from workflow YAML.
 *
 * Deliberately a line scan rather than a YAML parse: a workflow's `uses:` lines
 * are always at a known simple shape, and a YAML dependency here would mean the
 * policy can only run after an `npm ci`, which is one more thing that can go
 * wrong in a job holding a write token. Local (`./`) and `docker://` refs have no
 * version to compare and are skipped.
 */
export function readActionRefs(workflowText) {
  const refs = new Map();
  for (const match of String(workflowText ?? "").matchAll(USES_RE)) {
    const value = match[1];
    const at = value.lastIndexOf("@");
    if (at <= 0) continue;
    if (value.startsWith("./") || value.startsWith("docker://")) continue;
    const name = value.slice(0, at);
    if (!refs.has(name)) refs.set(name, value.slice(at + 1));
  }
  return refs;
}

/**
 * The npm half of the change set: compare the base and head manifests and
 * report only entries whose spec actually moved. Additions and removals are
 * included (with synthetic to/from values) rather than skipped, because a
 * Dependabot PR that adds a dependency is not a version bump of an existing one
 * and must not be auto-merged on a technicality.
 */
export function diffDependencyMaps(before, after) {
  const changes = [];
  for (const [name, next] of after) {
    const previous = before.get(name);
    if (previous && previous.spec !== next.spec) {
      changes.push({
        packageName: name,
        from: previous.spec,
        to: next.spec,
        isDevDependency: next.isDevDependency,
        kind: "updated",
      });
    }
  }
  for (const [name, previous] of before) {
    if (!after.has(name)) {
      changes.push({
        packageName: name,
        from: previous.spec,
        // `0.0.0` so the classifier reads this as a downgrade (a hold) rather
        // than a prerelease; `kind` is what the report renders.
        to: "0.0.0",
        isDevDependency: previous.isDevDependency,
        kind: "removed",
      });
    }
  }
  return changes;
}

/** The GitHub Actions half, for the same reason. */
export function diffActionRefs(before, after) {
  const changes = [];
  for (const [name, nextRef] of after) {
    const previousRef = before.get(name);
    if (previousRef && previousRef !== nextRef) {
      changes.push({
        packageName: name,
        from: normaliseActionRef(previousRef),
        to: normaliseActionRef(nextRef),
        isDevDependency: true,
        kind: "updated",
      });
    }
  }
  return changes;
}

/** Ranking used to reduce a PR's changes to a single worst-case level. */ const LEVEL_SEVERITY = {
  patch: 0,
  prerelease: 1,
  minor: 2,
  major: 3,
  downgrade: 4,
  none: 5,
  unknown: 6,
};

export function worstLevel(levels) {
  return levels.reduce(
    (worst, level) => (LEVEL_SEVERITY[level] > LEVEL_SEVERITY[worst] ? level : worst),
    "patch"
  );
}

// ---------------------------------------------------------------------------
// CI evaluation
// ---------------------------------------------------------------------------

/**
 * Decide whether the CI state on a commit is unambiguously green.
 *
 * The failure modes this is written against, all of which are real and all of
 * which produce a *mergeable-looking* PR if you only check "no check failed":
 *
 *   - a check run with conclusion `skipped` (a step's `if:`, or a job that
 *     GitHub reports as skipped) - not a pass;
 *   - conclusion `neutral` - reported for a workflow that exits 0 having done
 *     nothing, e.g. every step was filtered out;
 *   - `cancelled` - a superseded or manually-aborted run;
 *   - `timed_out` / `action_required` / `stale` / `startup_failure`;
 *   - status `queued` / `in_progress` / `waiting` / `pending` - the check
 *     exists but has not finished, so its conclusion is unknowable;
 *   - no check runs at all, because a `paths:` filter meant the workflow never
 *     started. This is why `expectedContexts` is not optional;
 *   - a required context that has not reported yet.
 *
 * Returns reasons for every hold-worthy observation rather than the first one,
 * so the PR comment can explain the whole picture.
 */
export function evaluateCi({
  checkRuns,
  requiredContexts = [],
  requiredContextsError = null,
  expectedContexts = [],
}) {
  const observed = (checkRuns ?? []).map((run) => ({
    name: run.name,
    status: run.status,
    conclusion: run.conclusion ?? null,
  }));

  if (observed.length === 0) {
    return {
      ok: false,
      observed,
      requiredFailures: [],
      advisoryFailures: [],
      reasons: [
        "no check runs are reported for this commit, so the CI result is unknown (usually a paths: filter meant the workflow never started) - not auto-merging",
      ],
    };
  }

  const reasons = [];
  const reportedNames = new Set(observed.map((run) => run.name));
  const requiredSet = new Set(requiredContexts);

  for (const expected of expectedContexts) {
    if (!reportedNames.has(expected)) {
      reasons.push(
        `expected CI check "${expected}" has not reported on this commit - treating the run as incomplete`
      );
    }
  }

  if (requiredContextsError) {
    reasons.push(
      `branch protection could not be read (${requiredContextsError}), so the required-check list is unknown`
    );
  }

  for (const context of requiredContexts) {
    if (!reportedNames.has(context)) {
      reasons.push(
        `branch-protection required context "${context}" has not reported on this commit`
      );
    }
  }

  for (const run of observed) {
    if (run.status !== "completed") {
      reasons.push(
        `check "${run.name}" is ${run.status} - not finished, so its conclusion is unknown`
      );
    } else if (run.conclusion !== "success") {
      reasons.push(
        `check "${run.name}" concluded "${run.conclusion}" (only "success" permits auto-merge)`
      );
    }
  }

  const failures = observed.filter(
    (run) => run.status === "completed" && run.conclusion !== "success"
  );
  const requiredFailures = failures.filter((run) => requiredSet.has(run.name));
  const advisoryFailures = failures.filter((run) => !requiredSet.has(run.name));

  return { ok: reasons.length === 0, observed, requiredFailures, advisoryFailures, reasons };
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

/** Dependabot and its version-bump bot. Anything else is a human's PR. */
export const TRUSTED_AUTHORS = ["dependabot[bot]", "dependabot-preview[bot]"];

const LABEL_FOR_LEVEL = {
  patch: "bump:patch",
  prerelease: "bump:prerelease",
  minor: "bump:minor",
  major: "bump:major",
  downgrade: "bump:downgrade",
  none: "bump:none",
  unknown: "bump:unknown",
};

/**
 * @typedef {object} DependencyChange
 * @property {string} packageName
 * @property {string} from
 * @property {string} to
 * @property {boolean} [isDevDependency]
 */

/**
 * The single decision function. Given facts, return what to do and why.
 *
 * @param {object} input
 * @param {string} input.author
 * @param {boolean} input.isDraft
 * @param {DependencyChange[]} input.changes
 * @param {string[]} [input.changedFiles]
 * @param {Array<{name:string,status:string,conclusion:string|null}>} input.checkRuns
 * @param {string[]} [input.requiredContexts]
 * @param {string|null} [input.requiredContextsError]
 * @param {string[]} [input.expectedContexts]
 */
export function decideTriage({
  author,
  isDraft,
  changes,
  changedFiles = [],
  checkRuns,
  requiredContexts = [],
  requiredContextsError = null,
  expectedContexts = [],
}) {
  const reasons = [];
  const labels = new Set(["dependencies"]);

  if (!TRUSTED_AUTHORS.includes(author)) {
    reasons.push(
      `PR author "${author}" is not a Dependabot account - this policy only applies to automated updates`
    );
  }

  if (isDraft) {
    reasons.push("PR is a draft - not auto-merging");
  }

  const unexpectedFiles = changedFiles.filter((file) => !isClassifiableFile(file));
  if (unexpectedFiles.length > 0) {
    reasons.push(
      `PR touches files this policy cannot classify (${unexpectedFiles.join(", ")}) - the dependency set could not be fully determined`
    );
  }

  const normalised = (changes ?? []).map((change) => {
    const level = bumpLevel(change.from, change.to);
    const exempt = exemptRule(change.packageName);
    const category = exempt
      ? exempt.category
      : categoryFor(change.packageName, change.isDevDependency === true);
    return {
      packageName: change.packageName,
      from: change.from,
      to: change.to,
      kind: change.kind ?? "updated",
      level,
      exempt: Boolean(exempt),
      exemptWhy: exempt ? exempt.why : null,
      category,
      isDevDependency: change.isDevDependency === true,
    };
  });

  if (normalised.length === 0) {
    reasons.push(
      "no dependency changes could be derived from the PR - the update could not be identified"
    );
  }

  for (const change of normalised) {
    labels.add(LABEL_FOR_LEVEL[change.level]);

    if (change.level !== "patch") {
      reasons.push(
        `${change.packageName} ${change.from} -> ${change.to} is a ${change.level} bump, not a patch`
      );
    }

    if (change.exempt) {
      reasons.push(
        `${change.packageName} is on the never-auto-merge exception list (${change.category}): ${change.exemptWhy}`
      );
    }
  }

  const ci = evaluateCi({ checkRuns, requiredContexts, requiredContextsError, expectedContexts });
  reasons.push(...ci.reasons);

  const level =
    normalised.length > 0 ? worstLevel(normalised.map((change) => change.level)) : "unknown";
  const autoMerge = reasons.length === 0;

  if (autoMerge) {
    labels.add("automerge:approved");
  } else {
    labels.add("needs-human-review");
  }

  return {
    action: autoMerge ? "auto-merge" : "hold",
    reasons,
    level,
    autoMerge,
    changes: normalised,
    ci,
    labels: [...labels],
    riskNotes: [
      ...new Set(
        normalised
          .filter((c) => c.level !== "patch" || c.exempt)
          .map((c) => categoryNote(c.category))
      ),
    ],
  };
}

/** A workflow file whose `uses:` refs this policy can read. */
export const WORKFLOW_FILE_RE = /^\.github\/workflows\/[^/]+\.ya?ml$/;

/**
 * Files whose contents this policy knows how to read a dependency version out
 * of. A Dependabot PR that changes anything else is one we cannot fully
 * account for, so it is held.
 */
export function isClassifiableFile(file) {
  return (
    file === "package.json" ||
    file === "package-lock.json" ||
    file === "npm-shrinkwrap.json" ||
    WORKFLOW_FILE_RE.test(file)
  );
}
