import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import FlakeReporter, {
  classify,
  summarize,
  testId,
  FLAKE_REPORT_VERSION,
} from "@/scripts/test/flake-reporter.mjs";

/**
 * A verdict is the only thing standing between a retry and a permanently
 * hidden bug, so the decision table is pinned here attempt by attempt.
 */
describe("classify", () => {
  it("calls a first-attempt pass a pass", () => {
    expect(classify("passed", 0)).toBe("passed");
  });

  it("calls a test undefined diagnostics a pass rather than NaN-flaky", () => {
    // diagnostic() is documented as undefined for tests that never finished.
    expect(classify("passed", undefined)).toBe("passed");
  });

  it("treats a negative retry count as no retries", () => {
    expect(classify("passed", -1)).toBe("passed");
  });

  it("calls a pass that needed one retry flaky", () => {
    expect(classify("passed", 1)).toBe("flaky");
  });

  it("calls a pass that exhausted the retry budget flaky", () => {
    expect(classify("passed", 2)).toBe("flaky");
  });

  it("calls a still-red test a failure", () => {
    expect(classify("failed", 0)).toBe("failed");
  });

  it("calls a still-red test a failure however many times it was retried", () => {
    // The regression that matters most. If this ever returns "flaky" again, a
    // real failure can be laundered into a green build by adding retries.
    expect(classify("failed", 2)).toBe("failed");
  });

  it("calls a pending test skipped", () => {
    expect(classify("pending", 0)).toBe("skipped");
  });

  it("does not call a skipped test flaky even with retries", () => {
    expect(classify("pending", 2)).toBe("skipped");
  });

  it("agrees with vitest's own definition of flaky", () => {
    // vitest computes `flaky` as retryCount > 0 && internal state "pass", in
    // ReportedTask#diagnostic (node_modules/vitest .../cli-api.js). Its internal
    // state string is "pass" while the public result().state is "passed", so
    // the mapping is done here explicitly — getting it wrong would silently
    // report the opposite of what vitest says about a test.
    const vitestFlaky = (internalState: string, retryCount: number) =>
      Boolean(retryCount) && retryCount > 0 && internalState === "pass";
    const cases = [
      ["passed", 0],
      ["passed", 1],
      ["passed", 2],
      ["failed", 0],
      ["failed", 2],
      ["pending", 1],
    ] as const;
    for (const [state, retryCount] of cases) {
      const internal = state === "passed" ? "pass" : state;
      const ours = classify(state, retryCount) === "flaky";
      expect({
        state,
        retryCount,
        ours,
        vitest: vitestFlaky(internal, retryCount) === ours,
      }).toEqual({ state, retryCount, ours, vitest: true });
    }
  });
});

describe("testId", () => {
  it("joins file and full name so identical test names in different files stay distinct", () => {
    expect(testId("a/Badge.test.tsx", "Badge > renders")).toBe(
      "a/Badge.test.tsx :: Badge > renders"
    );
  });

  it("is stable, so history survives renames of unrelated fields", () => {
    expect(testId("a.test.ts", "b > c")).toBe(testId("a.test.ts", "b > c"));
  });
});

describe("summarize", () => {
  it("counts every verdict bucket", () => {
    const summary = summarize([
      { status: "passed" },
      { status: "passed" },
      { status: "flaky" },
      { status: "failed" },
      { status: "skipped" },
    ] as never);
    expect(summary).toEqual({ total: 5, passed: 2, flaky: 1, failed: 1, skipped: 1 });
  });

  it("returns zeros rather than undefined for an empty run", () => {
    expect(summarize([])).toEqual({ total: 0, passed: 0, flaky: 0, failed: 0, skipped: 0 });
  });
});

describe("FlakeReporter run record", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "flake-reporter-"));
  const reportPath = path.join(dir, "nested", "run.json");

  const fakeCase = (fullName: string, state: string, retryCount: number) => ({
    fullName,
    module: { moduleId: "/repo/a.test.ts" },
    result: () => ({ state }),
    diagnostic: () => ({ retryCount, duration: 5 }),
  });

  const runCases = (cases: unknown[]) => {
    const reporter = new FlakeReporter({ quiet: true, reportPath });
    reporter.onInit({ config: { root: "/repo" } } as never);
    for (const testCase of cases) reporter.onTestCaseResult(testCase as never);
    reporter.onTestRunEnd([], [], "failed");
    return JSON.parse(readFileSync(reportPath, "utf8"));
  };

  it("writes a run record that separates flaky from failed", () => {
    // This is the artifact the history is built from, so the four verdicts have
    // to survive the trip to disk rather than only existing in the log.
    const record = runCases([
      fakeCase("a > pass", "passed", 0),
      fakeCase("a > flake", "passed", 2),
      fakeCase("a > fail", "failed", 2),
      fakeCase("a > skip", "pending", 0),
    ]);

    expect(record.version).toBe(FLAKE_REPORT_VERSION);
    expect(record.tests.map((t: { name: string; status: string }) => [t.name, t.status])).toEqual([
      ["a > pass", "passed"],
      ["a > flake", "flaky"],
      ["a > fail", "failed"],
      ["a > skip", "skipped"],
    ]);
    expect(record.summary).toEqual({ total: 4, passed: 1, flaky: 1, failed: 1, skipped: 1 });
  });

  it("records the retry count so a 2-retry pass is distinguishable from a first-time pass", () => {
    const record = runCases([
      fakeCase("a > flake", "passed", 2),
      fakeCase("a > pass", "passed", 0),
    ]);
    expect(record.tests.map((t: { retryCount: number }) => t.retryCount)).toEqual([2, 0]);
  });

  it("makes file paths repo-relative so the id is the same on a developer laptop and in CI", () => {
    const record = runCases([fakeCase("a > pass", "passed", 0)]);
    expect(record.tests[0].file).toBe("a.test.ts");
    expect(record.tests[0].id).toBe("a.test.ts :: a > pass");
  });

  it("creates the report directory when it does not exist yet", () => {
    expect(existsSync(path.dirname(reportPath))).toBe(true);
  });

  it("carries the run's reason and unhandled error count through to the record", () => {
    const record = runCases([fakeCase("a > pass", "passed", 0)]);
    expect(record.reason).toBe("failed");
    expect(record.unhandledErrors).toBe(0);
  });

  it("exports a version so a stale run record is rejected rather than merged", () => {
    expect(FLAKE_REPORT_VERSION).toBe(1);
  });

  it("does not throw when a test has no diagnostics at all", () => {
    const reporter = new FlakeReporter({ quiet: true, reportPath });
    reporter.onInit({ config: { root: "/repo" } } as never);
    expect(() =>
      reporter.onTestCaseResult({
        fullName: "no diagnostics",
        module: { moduleId: "/repo/a.test.ts" },
        result: () => ({ state: "passed" }),
        diagnostic: () => undefined,
      } as never)
    ).not.toThrow();
  });

  it("survives a test whose module id is missing", () => {
    const reporter = new FlakeReporter({ quiet: true, reportPath });
    reporter.onInit({ config: { root: "/repo" } } as never);
    expect(() =>
      reporter.onTestCaseResult({
        fullName: "orphan",
        result: () => ({ state: "passed" }),
        diagnostic: () => ({}),
      } as never)
    ).not.toThrow();
  });
});
