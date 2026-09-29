import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { summarize } from "@/scripts/test/flake-reporter.mjs";
import {
  createHistory,
  findChronicOffenders,
  findExpiredQuarantines,
  findQuarantineEntry,
  findStale,
  flakeRate,
  formatLog,
  formatMarkdown,
  isActive,
  loadQuarantine,
  mergeRun,
  parseArgs,
  unblocked,
  HISTORY_VERSION,
  type FlakeHistory,
} from "@/scripts/test/flake-history.mjs";

/**
 * @param {Array<{id: string, status: string, file?: string}>} tests
 * @param {object} [extra]
 * @returns {import("@/scripts/test/flake-reporter.mjs").FlakeRunRecord}
 */
function run(
  tests: Array<{ id: string; status: string; file?: string }>,
  extra: Record<string, unknown> = {}
) {
  const verdicts = tests.map((t) => ({
    id: t.id,
    file: t.file ?? (t.id.split(" :: ")[0] as string),
    name: (t.id.split(" :: ")[1] ?? t.id) as string,
    status: t.status as never,
    retryCount: t.status === "flaky" ? 1 : 0,
    durationMs: 1,
  }));
  return {
    version: 1,
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:00.000Z",
    retried: 2,
    reason: "passed",
    unhandledErrors: 0,
    summary: summarize(verdicts),
    tests: verdicts,
    ...extra,
  } as unknown as import("@/scripts/test/flake-reporter.mjs").FlakeRunRecord;
}

const id = "a.test.ts :: suite > flaky one";

/**
 * Read one history entry, failing loudly rather than returning undefined.
 *
 * A missing entry means the test id under test is wrong, and a silent undefined
 * would turn that into a confusing "no offenders" result instead of an error.
 */
function entryOf(history: FlakeHistory, testId: string) {
  const entry = history.tests[testId];
  if (!entry)
    throw new Error(
      `no history entry for ${testId}; have ${Object.keys(history.tests).join(", ")}`
    );
  return entry;
}

/** Fold `count` identical runs into a history, so a rate can be described declaratively. */
function historyAfterFlaky(
  count: number,
  total = 10,
  options: { windowRuns?: number } = {}
): FlakeHistory {
  let history = createHistory(options.windowRuns ?? total);
  for (let i = 0; i < total; i += 1) {
    const status = i < count ? "flaky" : "passed";
    history = mergeRun(history, run([{ id, status }]), {
      at: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
    });
  }
  return history;
}

describe("mergeRun", () => {
  it("records one observation per test per run", () => {
    const history = mergeRun(
      createHistory(),
      run([
        { id, status: "flaky" },
        { id: "b.test.ts :: t", status: "passed" },
      ])
    );
    expect(Object.keys(history.tests)).toEqual([id, "b.test.ts :: t"]);
    expect(entryOf(history, id).window).toBe("1");
    expect(entryOf(history, "b.test.ts :: t").window).toBe("0");
  });

  it("accumulates a window across runs", () => {
    const history = historyAfterFlaky(3, 5);
    expect(entryOf(history, id).window).toBe("11100");
  });

  it("caps the window so the history file cannot grow without bound", () => {
    const history = historyAfterFlaky(0, 12, { windowRuns: 5 });
    expect(entryOf(history, id).window).toBe("00000");
    expect(entryOf(history, id).window).toHaveLength(5);
  });

  it("drops the oldest observations, keeping the most recent", () => {
    // Window of 3 with the flake first: the flaky observation must fall off,
    // so a test that was fixed stops counting as chronic.
    let history = createHistory(3);
    history = mergeRun(history, run([{ id, status: "flaky" }]));
    history = mergeRun(history, run([{ id, status: "passed" }]));
    history = mergeRun(history, run([{ id, status: "passed" }]));
    history = mergeRun(history, run([{ id, status: "passed" }]));
    expect(entryOf(history, id).window).toBe("000");
  });

  it("contributes no observation for a skipped test", () => {
    // it.skip is not evidence of health. Counting it would let a suite stop
    // testing itself while its flake rate improved.
    const history = mergeRun(createHistory(), run([{ id, status: "skipped" }]));
    expect(history.tests).toEqual({});
  });

  it("stamps the last flaky run and its commit", () => {
    let history = mergeRun(createHistory(), run([{ id, status: "passed" }]), {
      at: "2026-01-01T00:00:00.000Z",
      commit: "aaa",
    });
    history = mergeRun(history, run([{ id, status: "flaky" }]), {
      at: "2026-01-02T00:00:00.000Z",
      commit: "bbb",
    });
    history = mergeRun(history, run([{ id, status: "passed" }]), {
      at: "2026-01-03T00:00:00.000Z",
      commit: "ccc",
    });
    expect(entryOf(history, id)).toMatchObject({
      lastFlakyAt: "2026-01-02T00:00:00.000Z",
      lastFlakyCommit: "bbb",
      lastSeenAt: "2026-01-03T00:00:00.000Z",
    });
  });

  it("leaves the input history untouched", () => {
    const original = createHistory();
    const before = JSON.stringify(original);
    mergeRun(original, run([{ id, status: "flaky" }]));
    expect(JSON.stringify(original)).toBe(before);
  });

  it("keeps a bounded list of run summaries", () => {
    let history = createHistory();
    for (let i = 0; i < 45; i += 1) history = mergeRun(history, run([{ id, status: "passed" }]));
    expect(history.runs).toHaveLength(30);
    expect(history.version).toBe(HISTORY_VERSION);
  });
});

describe("flakeRate", () => {
  it("is the fraction of the window that was flaky", () => {
    expect(flakeRate({ window: "1010" } as never)).toBe(0.5);
    expect(flakeRate({ window: "10100" } as never)).toBe(0.4);
  });

  it("ignores failed observations in the numerator but counts them in the denominator", () => {
    // A hard failure is not a flake; it already fails the build. But it is part
    // of the test's track record, so it stays in the denominator.
    expect(flakeRate({ window: "1" } as never)).toBe(1);
    expect(flakeRate({ window: "2" } as never)).toBe(0);
    expect(flakeRate({ window: "12" } as never)).toBe(0.5);
  });

  it("is zero for a test with no observations", () => {
    expect(flakeRate({ window: "" } as never)).toBe(0);
  });
});

describe("findChronicOffenders", () => {
  it("flags a test that is flaky often enough, once there is enough data", () => {
    const offenders = findChronicOffenders(historyAfterFlaky(3, 10), {
      now: "2026-02-01T00:00:00.000Z",
    });
    expect(offenders).toHaveLength(1);
    expect(offenders[0]).toMatchObject({
      id,
      flaky: 3,
      observations: 10,
      rate: 0.3,
      state: "unquarantined",
    });
  });

  it("does not flag a test that is flaky once in many runs", () => {
    expect(
      findChronicOffenders(historyAfterFlaky(1, 20), { now: "2026-02-01T00:00:00.000Z" })
    ).toHaveLength(0);
  });

  it("does not flag a test on too little data, however bad the rate", () => {
    // A test that failed its very first two runs and then passed 8 times is at
    // 20% over 2 observations. Failing CI on that would train everyone to
    // ignore the offender report.
    expect(
      findChronicOffenders(historyAfterFlaky(2, 2), { now: "2026-02-01T00:00:00.000Z" })
    ).toHaveLength(0);
  });

  it("does not flag a consistently failing test, because a real failure already blocks the build", () => {
    const history = mergeRun(createHistory(), run([{ id, status: "failed" }]));
    expect(
      findChronicOffenders(history, { minObservations: 1, now: "2026-02-01T00:00:00.000Z" })
    ).toHaveLength(0);
  });

  it("sorts the worst offender first", () => {
    let history = createHistory(10);
    const other = "b.test.ts :: suite > worse";
    for (let i = 0; i < 10; i += 1) {
      history = mergeRun(
        history,
        run([
          { id, status: i < 2 ? "flaky" : "passed" },
          { id: other, status: i < 6 ? "flaky" : "passed" },
        ])
      );
    }
    const offenders = findChronicOffenders(history, { now: "2026-02-01T00:00:00.000Z" });
    expect(offenders.map((o) => o.id)).toEqual([other, id]);
  });

  it("honours a custom rate threshold", () => {
    const history = historyAfterFlaky(2, 10);
    expect(
      findChronicOffenders(history, { rate: 0.5, now: "2026-02-01T00:00:00.000Z" })
    ).toHaveLength(0);
    expect(
      findChronicOffenders(history, { rate: 0.2, now: "2026-02-01T00:00:00.000Z" })
    ).toHaveLength(1);
  });
});

describe("quarantine", () => {
  const entry = {
    id,
    owner: "@someone",
    issue: 42,
    addedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-03-01T00:00:00.000Z",
    note: "needs a real clock injection; tracked in #42",
  };

  it("is satisfied by a live entry", () => {
    const offenders = findChronicOffenders(historyAfterFlaky(3, 10), {
      quarantine: [entry],
      now: "2026-02-01T00:00:00.000Z",
    });
    expect(offenders.map((o) => o.state)).toEqual(["quarantined"]);
    expect(unblocked(offenders)).toHaveLength(0);
  });

  it("stops being satisfied once it expires — no flag can extend it", () => {
    // This is the anti-laundering guarantee. A test cannot be quarantined
    // forever, so "we will fix it later" has to be re-argued on a schedule.
    const offenders = findChronicOffenders(historyAfterFlaky(3, 10), {
      quarantine: [entry],
      now: "2026-04-01T00:00:00.000Z",
    });
    expect(offenders.map((o) => o.state)).toEqual(["expired"]);
    expect(unblocked(offenders)).toHaveLength(1);
  });

  it("does not accept an unparseable expiry date as valid", () => {
    expect(isActive({ ...entry, expiresAt: "soon" }, "2026-02-01T00:00:00.000Z")).toBe(false);
  });

  it("does not accept a missing entry as valid", () => {
    expect(isActive(null, "2026-02-01T00:00:00.000Z")).toBe(false);
  });

  it("does not satisfy a different test", () => {
    const offenders = findChronicOffenders(historyAfterFlaky(3, 10), {
      quarantine: [{ ...entry, id: "b.test.ts :: suite > other" }],
      now: "2026-02-01T00:00:00.000Z",
    });
    expect(offenders.map((o) => o.state)).toEqual(["unquarantined"]);
  });

  it("finds the entry for a test id", () => {
    expect(findQuarantineEntry(id, [entry])).toEqual(entry);
    expect(findQuarantineEntry("nope", [entry])).toBeNull();
  });

  it("lists expired entries so they get cleaned up rather than accumulating", () => {
    expect(findExpiredQuarantines([entry], "2026-04-01T00:00:00.000Z")).toEqual([entry]);
    expect(findExpiredQuarantines([entry], "2026-02-01T00:00:00.000Z")).toEqual([]);
  });
});

describe("loadQuarantine", () => {
  const write = (contents: string) => {
    const file = path.join(
      mkdtempSync(path.join(tmpdir(), "flake-quarantine-")),
      "quarantine.json"
    );
    writeFileSync(file, contents, "utf8");
    return file;
  };

  it("returns an empty list when the file does not exist", () => {
    expect(loadQuarantine("/nonexistent/quarantine.json")).toEqual([]);
  });

  it("loads a well-formed ledger", () => {
    const file = write(
      JSON.stringify([
        {
          id: "a.test.ts :: t",
          owner: "@x",
          issue: 1,
          addedAt: "2026-01-01T00:00:00.000Z",
          expiresAt: "2026-03-01T00:00:00.000Z",
          note: "n",
        },
      ])
    );
    expect(loadQuarantine(file)).toHaveLength(1);
  });

  it("rejects an entry with no owner, issue or expiry", () => {
    // Silently accepting an incomplete entry would create a quarantine that
    // nobody is accountable for, which is worse than no quarantine at all.
    const file = write(JSON.stringify([{ id: "a.test.ts :: t", note: "later" }]));
    expect(() => loadQuarantine(file)).toThrow(/missing owner, issue, addedAt, expiresAt/);
  });

  it("rejects a ledger that is not an array", () => {
    expect(() => loadQuarantine(write(JSON.stringify({ "a.test.ts :: t": {} })))).toThrow(
      /must contain a JSON array/
    );
  });

  it("rejects unparseable JSON rather than quietly treating it as empty", () => {
    expect(() => loadQuarantine(write("{ oops"))).toThrow(/not valid JSON/);
  });
});

describe("findStale", () => {
  it("reports tests that stopped being observed, rather than calling them offenders", () => {
    let history = createHistory();
    history = mergeRun(history, run([{ id: "gone.test.ts :: old", status: "flaky" }]), {
      at: "2026-01-01T00:00:00.000Z",
    });
    for (let i = 0; i < 12; i += 1) {
      history = mergeRun(history, run([{ id, status: "passed" }]), {
        at: `2026-02-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
      });
    }
    const stale = findStale(history);
    expect(stale.map((s) => s.id)).toEqual(["gone.test.ts :: old"]);
  });
});

describe("parseArgs", () => {
  it("reads a flag with a value", () => {
    expect(parseArgs(["--rate=0.25", "--now=2026-01-01"])).toEqual({
      rate: "0.25",
      now: "2026-01-01",
    });
  });

  it("reads a bare flag as set", () => {
    // Regression. `--no-merge` and `--enforce` read naturally without a value,
    // and a parser that only understood `--flag=value` dropped them — which for
    // --enforce meant CI reported success while enforcing nothing.
    expect(parseArgs(["--no-merge", "--enforce"])).toEqual({ "no-merge": "1", enforce: "1" });
  });

  it("keeps a value that itself contains an equals sign", () => {
    expect(parseArgs(["--commit=abc=def"])).toEqual({ commit: "abc=def" });
  });

  it("keeps a hyphenated flag name", () => {
    expect(parseArgs(["--run-report=a.json", "--min-observations=3"])).toEqual({
      "run-report": "a.json",
      "min-observations": "3",
    });
  });

  it("rejects a stray positional argument instead of ignoring it", () => {
    expect(() => parseArgs(["history.json"])).toThrow(/unexpected argument/);
  });

  it("rejects an empty flag", () => {
    expect(() => parseArgs(["--"])).toThrow(/empty argument/);
    expect(() => parseArgs(["--=x"])).toThrow(/malformed argument/);
  });
});

describe("reporting", () => {
  it("says plainly that a chronic offender needs a decision", () => {
    const offenders = findChronicOffenders(historyAfterFlaky(3, 10), {
      now: "2026-02-01T00:00:00.000Z",
    });
    const log = formatLog(createHistory(), offenders);
    expect(log).toContain("need a decision");
    expect(log).toContain("NOT quarantined");
    expect(log).toContain("30%");
  });

  it("names the owner, issue and expiry for a quarantined offender", () => {
    const offenders = findChronicOffenders(historyAfterFlaky(3, 10), {
      quarantine: [
        {
          id,
          owner: "@someone",
          issue: 42,
          addedAt: "2026-01-01T00:00:00.000Z",
          expiresAt: "2026-03-01T00:00:00.000Z",
          note: "n",
        },
      ],
      now: "2026-02-01T00:00:00.000Z",
    });
    expect(formatLog(createHistory(), offenders)).toContain(
      "quarantined until 2026-03-01T00:00:00.000Z (@someone, #42)"
    );
  });

  it("reports a clean history without inventing offenders", () => {
    expect(formatLog(historyAfterFlaky(0, 10), [])).toContain("clean");
  });

  it("renders a markdown summary with the numbers that decided the verdict", () => {
    const offenders = findChronicOffenders(historyAfterFlaky(3, 10), {
      now: "2026-02-01T00:00:00.000Z",
    });
    const md = formatMarkdown(historyAfterFlaky(3, 10), offenders, [], {
      now: "2026-02-01T00:00:00.000Z",
      commit: "abc1234",
    });
    expect(md).toContain("## Flake report");
    expect(md).toContain("3/10");
    expect(md).toContain("`abc1234`");
    expect(md).toContain("quarantine with an owner and issue, or fix");
  });

  it("says so explicitly when there is nothing to do", () => {
    const history = historyAfterFlaky(0, 10);
    expect(formatMarkdown(history, [], [])).toContain("No chronic offenders");
  });
});
