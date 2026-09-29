/**
 * Vitest reporter that separates "passed after a retry" from "actually failed",
 * and writes a machine-readable record of the run for the flake history.
 *
 * Why this exists: `vitest run` with retries enabled exits 0 when a test only
 * passes on a later attempt, and prints those tests in the same shape as real
 * passes. A test that fails once every 40 runs is therefore indistinguishable
 * from a test that always passes, unless something records it. This reporter is
 * that something: it emits a per-test verdict and a run record on disk, which
 * `flake-history.mjs` folds into a rolling flake-rate history.
 *
 * The verdicts are deliberately blunt, because the whole point is to stop a
 * retry from quietly laundering a real bug:
 *
 *   passed  - green on the first attempt
 *   flaky   - failed at least once, green by the end. Does NOT fail the build,
 *             but is recorded, printed in its own section, and annotated as a
 *             CI warning so it is visible on the PR.
 *   failed  - still red after every retry. Fails the build, exactly as before.
 *   skipped - never ran (it.skip, or the whole file was filtered out).
 *
 * A `failed` verdict deliberately outranks retries: `retryCount: 2` plus
 * `failed` is a real failure that happened to be attempted three times, and
 * treating it as anything else is exactly the bug this is meant to catch.
 *
 * Configure it via `vitest.config.ts`. Environment variables:
 *   FLAKE_REPORT_PATH  where to write the run record (default .flake-report.json)
 *   FLAKE_QUIET         set to 1 to suppress the printed summary section
 *
 * @typedef {"passed" | "flaky" | "failed" | "skipped"} FlakeStatus
 *
 * @typedef {object} FlakeVerdict
 * @property {string} id            `<file> :: <full name>`, stable across runs
 * @property {string} file          repo-relative test file path
 * @property {string} name          suite-qualified test name
 * @property {FlakeStatus} status   see above
 * @property {number} retryCount    retries vitest needed (0 when green first time)
 * @property {number} durationMs    wall time of the final attempt, if reported
 *
 * @typedef {object} FlakeRunRecord
 * @property {number} version
 * @property {string} startedAt
 * @property {string} finishedAt
 * @property {number} retried      the retry budget this run was configured with
 * @property {string} reason       vitest's own run reason ("passed" | "failed")
 * @property {number} unhandledErrors
 * @property {{total: number, passed: number, flaky: number, failed: number, skipped: number}} summary
 * @property {FlakeVerdict[]} tests
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export const FLAKE_REPORT_VERSION = 1;

const DEFAULT_REPORT_PATH = ".flake-report.json";

/**
 * Turn a vitest result into a verdict.
 *
 * Pure and total so the decision table can be tested without a test run. The
 * order of the checks is the policy: failures are decided before retries are
 * looked at, so retryCount can never downgrade a real failure into a flake.
 *
 * @param {string | undefined} state      vitest task state: "passed" | "failed" | "pending"
 * @param {number | undefined} retryCount retries vitest needed, if reported
 * @returns {FlakeStatus}
 */
export function classify(state, retryCount) {
  const retries = typeof retryCount === "number" && retryCount > 0 ? retryCount : 0;
  if (state === "failed") return "failed";
  if (state === "pending") return "skipped";
  if (state === "passed" && retries > 0) return "flaky";
  return "passed";
}

/**
 * Build the stable identity for a test.
 *
 * The file path is part of the identity on purpose: `Badge` exists in more than
 * one file, and a flake rate attributed to the wrong file is worse than no
 * flake rate. Test names are not globally unique either, so the pair is used.
 *
 * @param {string} file     repo-relative test file path
 * @param {string} fullName suite-qualified test name, e.g. "Badge > renders"
 * @returns {string}
 */
export function testId(file, fullName) {
  return `${file} :: ${fullName}`;
}

/**
 * @param {FlakeVerdict[]} verdicts
 * @returns {{total: number, passed: number, flaky: number, failed: number, skipped: number}}
 */
export function summarize(verdicts) {
  const summary = { total: verdicts.length, passed: 0, flaky: 0, failed: 0, skipped: 0 };
  for (const verdict of verdicts) summary[verdict.status] += 1;
  return summary;
}

/**
 * @param {import("node:fs").PathLike} target
 * @param {string} contents
 */
function writeFile(target, contents) {
  mkdirSync(path.dirname(path.resolve(String(target))), { recursive: true });
  writeFileSync(String(target), contents, "utf8");
}

export default class FlakeReporter {
  /** @type {FlakeVerdict[]} */
  #verdicts = [];
  /** @type {string | undefined} */
  #startedAt;
  /** @type {string} */
  #root = process.cwd();
  /** @type {string} */
  #reportPath;
  /** @type {boolean} */
  #quiet = process.env.FLAKE_QUIET === "1";

  constructor(options = {}) {
    this.#reportPath = options.reportPath ?? process.env.FLAKE_REPORT_PATH ?? DEFAULT_REPORT_PATH;
    this.#quiet = options.quiet ?? this.#quiet;
  }

  onInit(ctx) {
    this.#root = ctx?.config?.root ?? process.cwd();
    this.#startedAt = new Date().toISOString();
  }

  onTestCaseResult(test) {
    // `diagnostic()` is documented as unavailable before a test finishes, and
    // returns undefined for tests that never really ran. Treat that as zero
    // retries rather than letting it become NaN arithmetic downstream.
    const diagnostic = test.diagnostic();
    const state = test.result?.()?.state;
    const file = this.#relative(test.module?.moduleId ?? test.file?.filepath);
    const name = test.fullName ?? test.name;
    this.#verdicts.push({
      id: testId(file, name),
      file,
      name,
      status: classify(state, diagnostic?.retryCount),
      retryCount: diagnostic?.retryCount ?? 0,
      durationMs: diagnostic?.duration ?? 0,
    });
  }

  onTestRunEnd(testModules, unhandledErrors, reason) {
    const summary = summarize(this.#verdicts);
    /** @type {FlakeRunRecord} */
    const record = {
      version: FLAKE_REPORT_VERSION,
      startedAt: this.#startedAt ?? new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      retried: Number(process.env.FLAKE_RETRY ?? 2),
      reason: String(reason),
      unhandledErrors: (unhandledErrors ?? []).length,
      summary,
      tests: this.#verdicts,
    };

    writeFile(this.#reportPath, `${JSON.stringify(record, null, 2)}\n`);

    if (!this.#quiet) this.#printSummary(record);
  }

  /**
   * @param {string | undefined} absolute
   * @returns {string}
   */
  #relative(absolute) {
    if (typeof absolute !== "string" || absolute === "") return "unknown";
    return path.relative(this.#root, absolute) || absolute;
  }

  /**
   * @param {FlakeRunRecord} record
   */
  #printSummary(record) {
    const flaky = record.tests.filter((t) => t.status === "flaky");
    const failed = record.tests.filter((t) => t.status === "failed");
    const lines = [];

    if (flaky.length > 0) {
      lines.push("── flake report: FLAKY (green only after a retry) ──");
      lines.push(
        "   These did NOT fail the build, but each one is a real bug hiding behind a retry."
      );
      for (const test of flaky) {
        lines.push(`   ! ${test.id}  (retried ${test.retryCount}x)`);
        // GitHub surfaces this on the PR itself, where the merge decision happens.
        console.log(
          `::warning file=${test.file}::FLAKY: ${test.name} passed only after ${test.retryCount} retry/retries. See docs/testing/QUARANTINE.md.`
        );
      }
    }

    if (failed.length > 0) {
      lines.push("── flake report: FAILED (still red after every retry — these DO block merge) ──");
      for (const test of failed) {
        lines.push(`   x ${test.id}  (attempted ${test.retryCount + 1}x)`);
      }
    }

    if (flaky.length === 0 && failed.length === 0) {
      lines.push("── flake report: clean ──   no retries were needed.");
    }

    const { total, passed, flaky: flakyCount, failed: failedCount, skipped } = record.summary;
    lines.push(
      `   ${total} tests: ${passed} passed, ${flakyCount} flaky, ${failedCount} failed, ${skipped} skipped.`
    );
    if (flakyCount > 0) {
      lines.push(
        `   Record written to ${this.#reportPath} — the nightly job folds it into docs/testing/flake-history.json.`
      );
    }
    lines.push(`   Full history and quarantine process: docs/testing/QUARANTINE.md`);

    console.log(lines.join("\n"));
  }
}
