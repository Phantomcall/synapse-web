/**
 * Rolling per-test flake-rate history, chronic-offender detection, and the
 * quarantine ledger.
 *
 * The retry budget in `flake-reporter.mjs` buys one thing: a flaky test stops
 * breaking unrelated work. It cannot tell you *whether the flake is being fixed*,
 * and it cannot stop a permanently broken test from being retried into a pass
 * forever. This module closes that gap.
 *
 * The mechanism is deliberately small:
 *
 *   1. Every run contributes one observation per test to a bounded window
 *      (default: the last 30 runs), encoded as one character: 0 passed, 1 flaky,
 *      2 failed. A test's flake rate is `1s / window length`.
 *   2. A test that is flaky in at least `minObservations` runs and whose rate
 *      reaches `rate` is a "chronic offender" — it needs a decision, not a retry.
 *   3. A chronic offender is only allowed to keep flaking if it is in the
 *      quarantine ledger, with a named owner, a tracking issue, and an expiry.
 *   4. An expired quarantine stops working automatically. There is no flag to
 *      set and no way to make a quarantine permanent, so "we'll fix it later"
 *      has to be re-argued out loud on a schedule.
 *
 * Step 4 is the whole point. Without it, a quarantine is a delete button for a
 * test, and the flake history becomes a museum.
 *
 * @typedef {object} HistoryEntry
 * @property {string} file
 * @property {string} window      one char per run: 0 passed, 1 flaky, 2 failed
 * @property {number} lastSeenAt  ISO timestamp of the most recent observation
 * @property {string | null} lastFlakyAt
 * @property {string | null} lastFlakyCommit
 * @property {string | null} lastFailedAt
 * @property {boolean} [stale]    not observed recently; likely renamed or removed
 *
 * @typedef {object} FlakeHistory
 * @property {number} version
 * @property {number} windowRuns
 * @property {string | null} updatedAt
 * @property {Array<{at: string, commit: string | null, tests: number, flaky: number, failed: number}>} runs
 * @property {Record<string, HistoryEntry>} tests
 *
 * @typedef {object} QuarantineEntry
 * @property {string} id
 * @property {string} owner
 * @property {number} issue
 * @property {string} addedAt
 * @property {string} expiresAt
 * @property {string} note
 *
 * @typedef {object} ChronicOffender
 * @property {string} id
 * @property {string} file
 * @property {number} flaky
 * @property {number} observations
 * @property {number} rate
 * @property {string | null} lastFlakyAt
 * @property {QuarantineEntry | null} quarantine
 * @property {"unquarantined" | "expired" | "quarantined"} state
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const HISTORY_VERSION = 1;
export const MAX_RUNS_KEPT = 30;
export const DEFAULT_WINDOW_RUNS = 30;
export const DEFAULT_RATE = 0.1;
export const DEFAULT_MIN_OBSERVATIONS = 5;
export const STALE_AFTER_RUNS = 10;

const OBSERVATION = { passed: "0", flaky: "1", failed: "2" };

/** @returns {FlakeHistory} */
export function createHistory(windowRuns = DEFAULT_WINDOW_RUNS) {
  return {
    version: HISTORY_VERSION,
    windowRuns,
    updatedAt: null,
    runs: [],
    tests: {},
  };
}

/**
 * Read a history file, tolerating absence and tolerating a history written by a
 * future version rather than crashing the nightly job.
 *
 * @param {string} file
 * @returns {FlakeHistory}
 */
export function loadHistory(file) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return createHistory();
    throw new Error(`${file} is not valid JSON: ${error.message}`);
  }
  if (parsed?.version !== HISTORY_VERSION) {
    throw new Error(
      `${file} has version ${parsed?.version}, this tool understands ${HISTORY_VERSION}. Re-seed the file.`
    );
  }
  return { ...createHistory(parsed.windowRuns), ...parsed };
}

/**
 * @param {string} file
 * @returns {QuarantineEntry[]}
 */
export function loadQuarantine(file) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw new Error(`${file} is not valid JSON: ${error.message}`);
  }
  if (!Array.isArray(parsed))
    throw new Error(`${file} must contain a JSON array of quarantine entries.`);
  const required = ["id", "owner", "issue", "addedAt", "expiresAt", "note"];
  for (const entry of parsed) {
    const missing = required.filter((key) => !entry?.[key]);
    if (missing.length > 0) {
      throw new Error(
        `${file}: entry ${JSON.stringify(entry?.id ?? "<no id>")} is missing ${missing.join(", ")}. Every quarantine needs an owner, an issue and an expiry.`
      );
    }
  }
  return parsed;
}

/**
 * @param {HistoryEntry} entry
 * @returns {number} fraction of observations in the window that were flaky
 */
export function flakeRate(entry) {
  if (!entry?.window) return 0;
  const flaky = entry.window.split("").filter((c) => c === OBSERVATION.flaky).length;
  return flaky / entry.window.length;
}

/**
 * Fold one run record into the history. Pure: returns a new history object and
 * leaves the input untouched, so a rejected run cannot corrupt the ledger.
 *
 * Skipped tests contribute no observation. A `it.skip` is not evidence of
 * health, and counting it as a pass would let a suite quietly stop testing
 * itself while its flake rate improved.
 *
 * @param {FlakeHistory} history
 * @param {import("./flake-reporter.mjs").FlakeRunRecord} run
 * @param {{windowRuns?: number, at?: string, commit?: string | null}} [options]
 * @returns {FlakeHistory}
 */
export function mergeRun(history, run, options = {}) {
  const windowRuns = Math.max(1, options.windowRuns ?? history.windowRuns ?? DEFAULT_WINDOW_RUNS);
  const at = options.at ?? run.finishedAt ?? new Date().toISOString();
  const commit = options.commit ?? null;
  const tests = { ...(history.tests ?? {}) };

  let flakyCount = 0;
  let failedCount = 0;

  for (const test of run.tests ?? []) {
    if (test.status === "skipped") continue;
    if (test.status === "flaky") flakyCount += 1;
    if (test.status === "failed") failedCount += 1;

    const previous = tests[test.id] ?? {
      file: test.file,
      window: "",
      lastSeenAt: null,
      lastFlakyAt: null,
      lastFlakyCommit: null,
      lastFailedAt: null,
    };

    tests[test.id] = {
      ...previous,
      file: test.file ?? previous.file,
      window: (previous.window + OBSERVATION[test.status]).slice(-windowRuns),
      lastSeenAt: at,
      lastFlakyAt: test.status === "flaky" ? at : previous.lastFlakyAt,
      lastFlakyCommit: test.status === "flaky" ? commit : previous.lastFlakyCommit,
      lastFailedAt: test.status === "failed" ? at : previous.lastFailedAt,
    };
  }

  const runs = [
    ...(history.runs ?? []),
    { at, commit, tests: (run.tests ?? []).length, flaky: flakyCount, failed: failedCount },
  ].slice(-MAX_RUNS_KEPT);

  return {
    version: HISTORY_VERSION,
    windowRuns,
    updatedAt: at,
    runs,
    tests,
  };
}

/**
 * Entries not seen in the last STALE_AFTER_RUNS runs.
 *
 * Not failures. A renamed or deleted test leaves its history behind, and
 * reporting that as a chronic offender would be a lie. Reported so the ledger
 * can be pruned.
 *
 * @param {FlakeHistory} history
 * @returns {Array<{id: string, file: string, lastSeenAt: string | null, rate: number}>}
 */
export function findStale(history) {
  const runs = history.runs ?? [];
  if (runs.length === 0) return [];
  const cutoffIndex = Math.max(0, runs.length - STALE_AFTER_RUNS);
  const cutoff = runs[cutoffIndex].at;
  return Object.entries(history.tests ?? {})
    .filter(([, entry]) => (entry.lastSeenAt ?? "") < cutoff)
    .map(([id, entry]) => ({
      id,
      file: entry.file,
      lastSeenAt: entry.lastSeenAt,
      rate: flakeRate(entry),
    }))
    .sort((a, b) => b.rate - a.rate);
}

/**
 * @param {string} id
 * @param {QuarantineEntry[]} quarantine
 * @returns {QuarantineEntry | null}
 */
export function findQuarantineEntry(id, quarantine) {
  return (quarantine ?? []).find((entry) => entry.id === id) ?? null;
}

/**
 * @param {QuarantineEntry | null} entry
 * @param {string} now ISO timestamp
 * @returns {boolean}
 */
export function isActive(entry, now) {
  if (!entry) return false;
  const expires = Date.parse(entry.expiresAt);
  if (Number.isNaN(expires)) return false;
  return expires > Date.parse(now);
}

/**
 * Tests that are flaky often enough to demand a decision.
 *
 * @param {FlakeHistory} history
 * @param {object} [options]
 * @param {number} [options.rate]             flake-rate threshold, default 0.1
 * @param {number} [options.minObservations]  ignore tests with too little data
 * @param {QuarantineEntry[]} [options.quarantine]
 * @param {string} [options.now]
 * @returns {ChronicOffender[]}
 */
export function findChronicOffenders(history, options = {}) {
  const rate = options.rate ?? DEFAULT_RATE;
  const minObservations = options.minObservations ?? DEFAULT_MIN_OBSERVATIONS;
  const quarantine = options.quarantine ?? [];
  const now = options.now ?? new Date().toISOString();

  return Object.entries(history.tests ?? {})
    .map(([id, entry]) => {
      const observations = entry.window.length;
      const flaky = entry.window.split("").filter((c) => c === OBSERVATION.flaky).length;
      const actualRate = observations === 0 ? 0 : flaky / observations;
      const entryForTest = findQuarantineEntry(id, quarantine);
      const active = isActive(entryForTest, now);
      return {
        id,
        file: entry.file,
        flaky,
        observations,
        rate: actualRate,
        lastFlakyAt: entry.lastFlakyAt ?? null,
        quarantine: entryForTest,
        state: entryForTest ? (active ? "quarantined" : "expired") : "unquarantined",
      };
    })
    .filter(
      (offender) =>
        offender.flaky > 0 && offender.observations >= minObservations && offender.rate >= rate
    )
    .sort((a, b) => b.rate - a.rate || b.flaky - a.flaky);
}

/**
 * @param {FlakeHistory} history
 * @param {QuarantineEntry[]} quarantine
 * @param {string} now
 * @returns {QuarantineEntry[]} entries whose expiry has passed
 */
export function findExpiredQuarantines(quarantine, now) {
  return (quarantine ?? []).filter((entry) => !isActive(entry, now));
}

/**
 * @param {ChronicOffender[]} offenders
 * @returns {ChronicOffender[]} the ones CI must block on
 */
export function unblocked(offenders) {
  return offenders.filter((offender) => offender.state !== "quarantined");
}

/**
 * @param {FlakeHistory} history
 * @param {ReturnType<typeof findChronicOffenders>} offenders
 * @param {ReturnType<typeof findStale>} stale
 * @param {object} [options]
 * @param {string} [options.now]
 * @param {string} [options.commit]
 * @returns {string} markdown, suitable for a PR body or a step summary
 */
export function formatMarkdown(history, offenders, stale, options = {}) {
  const now = options.now ?? new Date().toISOString();
  const commit = options.commit ? `\`${options.commit}\`` : "unknown commit";
  const lines = [];

  lines.push("## Flake report");
  lines.push("");
  const totalObservations = Object.values(history.tests ?? {}).reduce(
    (sum, entry) => sum + entry.window.length,
    0
  );
  const totalFlaky = Object.values(history.tests ?? {}).reduce(
    (sum, entry) => sum + entry.window.split("").filter((c) => c === "1").length,
    0
  );
  lines.push(
    `${totalObservations} observations across ${Object.keys(history.tests ?? {}).length} tests and ${(history.runs ?? []).length} recorded runs — ${totalFlaky} flaky, at ${(totalObservations === 0 ? 0 : (totalFlaky / totalObservations) * 100).toFixed(1)}% overall.`
  );
  lines.push("");
  lines.push(`Run at ${now} on ${commit}.`);
  lines.push("");

  if (offenders.length === 0) {
    lines.push("No chronic offenders. No test is flaky often enough to need a decision.");
    lines.push("");
  } else {
    lines.push("### Chronic offenders");
    lines.push("");
    lines.push("| Test | Flake rate | Quarantine | Needs |");
    lines.push("| --- | --- | --- | --- |");
    for (const offender of offenders) {
      const quarantine = offender.quarantine
        ? `${offender.state === "expired" ? "**expired** " : ""}until ${offender.quarantine.expiresAt} (${offender.quarantine.owner}, #${offender.quarantine.issue})`
        : "none";
      const needs =
        offender.state === "quarantined"
          ? "nothing yet"
          : offender.state === "expired"
            ? "re-quarantine with a new expiry, or fix"
            : "quarantine with an owner and issue, or fix";
      lines.push(
        `| \`${offender.id}\` | ${(offender.rate * 100).toFixed(0)}% (${offender.flaky}/${offender.observations}) | ${quarantine} | ${needs} |`
      );
    }
    lines.push("");
  }

  if (stale.length > 0) {
    lines.push("### Stale history entries");
    lines.push("");
    lines.push(
      "Not seen in the last " +
        STALE_AFTER_RUNS +
        " recorded runs — usually a renamed or deleted test. Prune them by hand from `docs/testing/flake-history.json`."
    );
    lines.push("");
    for (const entry of stale.slice(0, 20)) {
      lines.push(`- \`${entry.id}\` (last seen ${entry.lastSeenAt ?? "never"})`);
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

/**
 * @param {FlakeHistory} history
 * @param {ChronicOffender[]} offenders
 * @returns {string} one-line-per-finding text for the CI log
 */
export function formatLog(history, offenders) {
  const lines = [];
  if (offenders.length === 0) {
    lines.push(
      `flake history: clean. ${Object.keys(history.tests ?? {}).length} tests tracked, no chronic offenders.`
    );
    return lines.join("\n");
  }
  lines.push("flake history: chronic offenders need a decision (see docs/testing/QUARANTINE.md)");
  for (const offender of offenders) {
    const detail =
      offender.state === "quarantined"
        ? `quarantined until ${offender.quarantine.expiresAt} (${offender.quarantine.owner}, #${offender.quarantine.issue})`
        : offender.state === "expired"
          ? `quarantine EXPIRED ${offender.quarantine.expiresAt} (${offender.quarantine.owner}, #${offender.quarantine.issue})`
          : "NOT quarantined";
    lines.push(`  ${(offender.rate * 100).toFixed(0).padStart(3)}%  ${offender.id}  — ${detail}`);
  }
  lines.push("");
  lines.push(
    "  A retry keeps a flaky test from breaking unrelated work; it does not fix anything."
  );
  lines.push(
    "  Each of the above needs either a fix, or a quarantine entry with an owner, an issue and an expiry date."
  );
  return lines.join("\n");
}

/**
 * Parse `--flag=value` and bare `--flag` arguments.
 *
 * Bare flags matter more than they look. `--no-merge` and `--enforce` used with
 * no value is the natural way to write them, and a regex that only accepts
 * `--flag=value` would drop them on the floor — which for `--enforce` means CI
 * silently stops enforcing anything while still reporting success. Unknown or
 * malformed arguments are a usage error rather than something to ignore.
 *
 * @param {string[]} argv
 * @returns {Record<string, string>}
 */
export function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const flags = {};
  for (const arg of argv) {
    if (!arg.startsWith("--"))
      throw new Error(
        `unexpected argument ${JSON.stringify(arg)}; expected --flag or --flag=value`
      );
    const body = arg.slice(2);
    if (body === "") throw new Error("empty argument '--'");
    const eq = body.indexOf("=");
    if (eq === -1) {
      flags[body] = "1";
      continue;
    }
    const name = body.slice(0, eq);
    if (name === "") throw new Error(`malformed argument ${JSON.stringify(arg)}`);
    flags[name] = body.slice(eq + 1);
  }
  return flags;
}

function main(argv) {
  const flags = parseArgs(argv);
  const root = flags.root ?? process.cwd();
  const historyPath = path.resolve(root, flags.history ?? "docs/testing/flake-history.json");
  const runPath = path.resolve(root, flags["run-report"] ?? ".flake-report.json");
  const quarantinePath = path.resolve(root, flags.quarantine ?? "docs/testing/quarantine.json");
  const summaryPath = flags["summary-out"] ? path.resolve(root, flags["summary-out"]) : null;

  const now = flags.now ?? new Date().toISOString();
  const rate = Number(flags.rate ?? DEFAULT_RATE);
  const minObservations = Number(flags["min-observations"] ?? DEFAULT_MIN_OBSERVATIONS);
  const enforce = flags.enforce === "1";
  const commit = flags.commit ?? process.env.GITHUB_SHA ?? null;

  const history = loadHistory(historyPath);
  const quarantine = loadQuarantine(quarantinePath);
  const stale = findStale(history);

  // Folding the run in first, then deriving offenders, means one invocation
  // both records this run and judges it. Doing it in that order also means the
  // numbers in the report always describe the history as written.
  let merged = history;
  if (!flags["no-merge"]) {
    const run = JSON.parse(readFileSync(runPath, "utf8"));
    merged = mergeRun(history, run, { at: now, commit });
    mkdirSync(path.dirname(historyPath), { recursive: true });
    writeFileSync(historyPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  }

  const offenders = findChronicOffenders(merged, { rate, minObservations, quarantine, now });
  const expired = findExpiredQuarantines(quarantine, now);
  const blocking = unblocked(offenders);

  console.log(formatLog(merged, offenders));
  if (expired.length > 0) {
    console.log("");
    console.log(`  ${expired.length} quarantined test(s) past their expiry date:`);
    for (const entry of expired) console.log(`    ${entry.id}  expired ${entry.expiresAt}`);
  }
  if (stale.length > 0)
    console.log(
      `\n  ${stale.length} stale history entr(ies) — tests renamed or removed since they were last run.`
    );

  if (summaryPath) {
    mkdirSync(path.dirname(summaryPath), { recursive: true });
    writeFileSync(summaryPath, formatMarkdown(merged, offenders, stale, { now, commit }), "utf8");
    // path.relative produces a pile of ../ for a path outside the repo, which
    // is harder to read than the absolute one in that case.
    const relative = path.relative(root, summaryPath);
    const shown = relative.startsWith("..") ? summaryPath : relative;
    console.log(`\n  Summary written to ${shown}`);
  }

  // The whole point of the history: a chronic offender is not allowed to sit
  // here indefinitely being retried into a green build.
  if (enforce && blocking.length > 0) {
    console.error(
      `\n::error::${blocking.length} chronic offender(s) are not covered by an active quarantine. Fix the test, or add an entry to docs/testing/quarantine.json with an owner, a tracking issue and an expiry date.`
    );
    return 1;
  }
  return 0;
}

// process.argv[1] is undefined when this module is imported from `node -e` or a
// REPL, where pathToFileURL would throw on the way to loading the functions.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 2;
  }
}
