import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { decide, validatePolicy } from "./canary-policy.mjs";

const policy = validatePolicy(
  JSON.parse(
    readFileSync(path.join(__dirname, "..", "..", ".github", "canary-policy.json"), "utf8")
  )
);

const MIN = 60_000;
const ok = { ok: true, status: 200 };
const fail = { ok: false, status: 500 };
const healthyProbes = Array.from({ length: 10 }, () => ok);

const vitals = (lcp: number, inp: number, cls: number, samples = 100) => ({
  lcp: { p75: lcp, samples },
  inp: { p75: inp, samples },
  cls: { p75: cls, samples },
});
const production = { requests: 5000, errors: 10, webVitals: vitals(1800, 120, 0.02) };

describe("the committed policy file", () => {
  it("is valid", () => {
    expect(policy.bakeMinutes).toBeGreaterThan(0);
  });

  it("rejects a typo instead of silently disabling a rule", () => {
    const broken = { ...policy, errorRate: { ...policy.errorRate, max: "2%" } };
    expect(() => validatePolicy(broken)).toThrow(/errorRate.max/);
  });
});

describe("decide: synthetic probes", () => {
  it("rolls back on consecutive probe failures, even mid-bake", () => {
    const d = decide({ policy, stageElapsedMs: 1 * MIN, probes: [ok, ok, fail, fail, fail] });
    expect(d.action).toBe("rollback");
    expect(d.reasons[0]).toMatch(/3 consecutive failed probes/);
  });

  it("rolls back on a flapping failure ratio above the window limit", () => {
    const probes = [ok, fail, ok, fail, ok, fail, ok, ok, fail, ok];
    const d = decide({ policy, stageElapsedMs: 1 * MIN, probes });
    expect(d.action).toBe("rollback");
    expect(d.reasons[0]).toMatch(/4\/10 recent probes failed/);
  });

  it("tolerates an isolated blip", () => {
    const probes = [ok, ok, ok, ok, fail, ok, ok, ok, ok, ok];
    expect(decide({ policy, stageElapsedMs: 11 * MIN, probes }).action).toBe("advance");
  });

  it("never advances without minimum synthetic evidence", () => {
    const d = decide({ policy, stageElapsedMs: 60 * MIN, probes: [ok, ok] });
    expect(d.action).toBe("wait");
  });
});

describe("decide: bake time", () => {
  it("waits until the stage has baked", () => {
    expect(decide({ policy, stageElapsedMs: 9 * MIN, probes: healthyProbes }).action).toBe("wait");
    expect(decide({ policy, stageElapsedMs: 10 * MIN, probes: healthyProbes }).action).toBe(
      "advance"
    );
  });
});

describe("decide: error rate", () => {
  it("rolls back when the canary error rate exceeds the absolute and relative limits", () => {
    const canary = { requests: 400, errors: 20, webVitals: vitals(1800, 120, 0.02) }; // 5%
    const d = decide({
      policy,
      stageElapsedMs: 2 * MIN,
      probes: healthyProbes,
      canary,
      baseline: production,
    });
    expect(d.action).toBe("rollback");
    expect(d.reasons[0]).toMatch(
      /error rate: canary 5\.00% over 400 requests > 2\.00% and > 2× production \(0\.20%\)/
    );
  });

  it("does not blame the canary for an error rate production already has", () => {
    const canary = { requests: 400, errors: 12, webVitals: vitals(1800, 120, 0.02) }; // 3%
    const baseline = { ...production, errors: 150 }; // 3%
    const d = decide({ policy, stageElapsedMs: 11 * MIN, probes: healthyProbes, canary, baseline });
    expect(d.action).toBe("advance");
  });

  it("ignores the error rate until enough requests have been seen", () => {
    const canary = { requests: 20, errors: 5 };
    const d = decide({
      policy,
      stageElapsedMs: 11 * MIN,
      probes: healthyProbes,
      canary,
      baseline: production,
    });
    expect(d.action).toBe("advance");
    expect(d.notes).toContain("error rate: insufficient data (20/200 requests)");
  });

  it("uses the absolute limit alone when production has no data", () => {
    const canary = { requests: 400, errors: 20 };
    const d = decide({
      policy,
      stageElapsedMs: 2 * MIN,
      probes: healthyProbes,
      canary,
      baseline: null,
    });
    expect(d.action).toBe("rollback");
  });
});

describe("decide: Core Web Vitals", () => {
  const base = { requests: 400, errors: 0 };

  it("rolls back when a p75 vital enters the poor range", () => {
    const canary = { ...base, webVitals: vitals(4200, 120, 0.02) };
    const d = decide({
      policy,
      stageElapsedMs: 2 * MIN,
      probes: healthyProbes,
      canary,
      baseline: production,
    });
    expect(d.action).toBe("rollback");
    expect(d.reasons[0]).toMatch(/LCP p75 4200 ms is in the "poor" range/);
  });

  it("rolls back on a large relative regression once outside the good range", () => {
    const canary = { ...base, webVitals: vitals(1800, 260, 0.02) }; // INP 120 → 260
    const d = decide({
      policy,
      stageElapsedMs: 2 * MIN,
      probes: healthyProbes,
      canary,
      baseline: production,
    });
    expect(d.action).toBe("rollback");
    expect(d.reasons[0]).toMatch(/INP p75 260 ms regressed > 1.25× production \(120 ms\)/);
  });

  it("ignores a relative change that stays inside the good range", () => {
    const canary = { ...base, webVitals: vitals(1800, 180, 0.02) }; // 1.5× but < 200 ms
    const d = decide({
      policy,
      stageElapsedMs: 11 * MIN,
      probes: healthyProbes,
      canary,
      baseline: production,
    });
    expect(d.action).toBe("advance");
  });

  it("skips vitals below the minimum sample size", () => {
    const canary = { ...base, webVitals: vitals(9000, 900, 0.9, 10) };
    const d = decide({
      policy,
      stageElapsedMs: 11 * MIN,
      probes: healthyProbes,
      canary,
      baseline: production,
    });
    expect(d.action).toBe("advance");
    expect(d.notes).toContain("LCP: insufficient data (10/50 samples)");
  });
});

describe("decide: no RUM configured", () => {
  it("decides on synthetic probes alone and says so", () => {
    const d = decide({ policy, stageElapsedMs: 11 * MIN, probes: healthyProbes, canary: null });
    expect(d.action).toBe("advance");
    expect(d.notes).toContain("RUM signals unavailable; deciding on synthetic probes only");
  });
});
