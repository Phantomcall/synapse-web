import { describe, it, expect } from "vitest";
import {
  DEFAULT_THRESHOLDS,
  applyDecision,
  decide,
  emptyState,
  evaluateSignals,
  parseState,
  recordPromotion,
} from "./rollback-policy.mjs";

const NOW = "2026-03-04T12:00:00.000Z";
const minutes = (n: number) => new Date(Date.parse(NOW) - n * 60_000).toISOString();

const HEALTHY = { requests: 5_000, errorRate: 0.0004, synthetic: { total: 10, failed: 0 } };
const ERROR_RATE_BROKEN = {
  requests: 5_000,
  errorRate: 0.184,
  synthetic: { total: 10, failed: 0 },
};
const SYNTHETIC_BROKEN = {
  requests: 5_000,
  errorRate: 0.0004,
  synthetic: { total: 10, failed: 6 },
};

/** A state where a promotion landed `ageMinutes` ago and is otherwise clean. */
function promoted(ageMinutes: number, extra: Record<string, unknown> = {}) {
  return parseState({
    version: 1,
    lastPromotedAt: minutes(ageMinutes),
    currentRef: "sha-newbuild",
    lastKnownGoodRef: "sha-prevgood",
    consecutiveRollbacks: 0,
    breakerOpen: false,
    history: [],
    ...extra,
  });
}

describe("evaluateSignals (health-signal thresholds)", () => {
  it("passes when both signals are inside their thresholds", () => {
    const result = evaluateSignals(HEALTHY, DEFAULT_THRESHOLDS);
    expect(result.degraded).toBe(false);
    expect(result.tooFewSamples).toBe(false);
    expect(result.breaches).toEqual([]);
  });

  it("flags an error rate over the threshold", () => {
    const result = evaluateSignals(ERROR_RATE_BROKEN, DEFAULT_THRESHOLDS);
    expect(result.degraded).toBe(true);
    expect(result.breaches.map((b) => b.signal)).toEqual(["error-rate"]);
    expect(result.breaches[0]?.observed).toBe(0.184);
    expect(result.breaches[0]?.threshold).toBe(DEFAULT_THRESHOLDS.maxErrorRate);
  });

  it("flags a synthetic-monitoring failure ratio over the threshold", () => {
    const result = evaluateSignals(SYNTHETIC_BROKEN, DEFAULT_THRESHOLDS);
    expect(result.degraded).toBe(true);
    expect(result.breaches.map((b) => b.signal)).toEqual(["synthetic"]);
    expect(result.breaches[0]?.observed).toBeCloseTo(0.6);
  });

  it("reports both breaches when both signals are bad", () => {
    const result = evaluateSignals(
      { requests: 5_000, errorRate: 0.5, synthetic: { total: 4, failed: 4 } },
      DEFAULT_THRESHOLDS
    );
    expect(result.breaches.map((b) => b.signal)).toEqual(["error-rate", "synthetic"]);
  });

  it("does not act on an error rate computed from too few requests", () => {
    // 1 of 3 requests failing is a 33% error rate but is pure noise.
    const result = evaluateSignals(
      { requests: 3, errorRate: 0.333, synthetic: { total: 10, failed: 0 } },
      DEFAULT_THRESHOLDS
    );
    expect(result.degraded).toBe(false);
    expect(result.tooFewSamples).toBe(true);
  });

  it("does not act on too few synthetic checks", () => {
    const result = evaluateSignals(
      { requests: 5_000, errorRate: 0, synthetic: { total: 1, failed: 1 } },
      DEFAULT_THRESHOLDS
    );
    expect(result.degraded).toBe(false);
    expect(result.tooFewSamples).toBe(true);
  });

  it("treats a missing payload as too few samples rather than healthy", () => {
    const result = evaluateSignals(null, DEFAULT_THRESHOLDS);
    expect(result.degraded).toBe(false);
    expect(result.tooFewSamples).toBe(true);
  });

  it("respects threshold overrides", () => {
    const relaxed = { ...DEFAULT_THRESHOLDS, maxErrorRate: 0.5 };
    expect(evaluateSignals(ERROR_RATE_BROKEN, relaxed).degraded).toBe(false);
  });
});

describe("decide (automated rollback)", () => {
  it("rolls back to the previous build when the error rate breaches", () => {
    const decision = decide({
      state: promoted(20),
      signals: ERROR_RATE_BROKEN,
      now: NOW,
    });
    expect(decision.action).toBe("rollback");
    expect(decision.code).toBe("degraded");
    expect(decision.rollbackTo).toBe("sha-prevgood");
    expect(decision.reason).toContain("error rate");
  });

  it("rolls back when synthetic monitoring fails", () => {
    const decision = decide({ state: promoted(20), signals: SYNTHETIC_BROKEN, now: NOW });
    expect(decision.action).toBe("rollback");
    expect(decision.rollbackTo).toBe("sha-prevgood");
  });

  it("holds while the build is healthy", () => {
    const decision = decide({ state: promoted(20), signals: HEALTHY, now: NOW });
    expect(decision.action).toBe("hold");
    expect(decision.code).toBe("healthy");
  });

  it("holds when there is no promotion to evaluate", () => {
    const decision = decide({ state: emptyState(), signals: ERROR_RATE_BROKEN, now: NOW });
    expect(decision.action).toBe("hold");
    expect(decision.code).toBe("no-promotion");
  });

  it("refuses to roll back with no signal data rather than guessing", () => {
    const decision = decide({ state: promoted(20), signals: null, now: NOW });
    expect(decision.action).toBe("hold");
    expect(decision.code).toBe("no-signals");
  });

  it("never rolls back a promotion that is inside the observation window", () => {
    const decision = decide({ state: promoted(2), signals: ERROR_RATE_BROKEN, now: NOW });
    expect(decision.action).toBe("hold");
    expect(decision.code).toBe("observation-window");
    // ...unless the operator forces it.
    expect(
      decide({ state: promoted(2), signals: ERROR_RATE_BROKEN, now: NOW, mode: "force" }).action
    ).toBe("rollback");
  });
});

describe("flapping protection (#171 edge case)", () => {
  const rolledBackState = () => {
    const base = promoted(60, {
      lastRollbackAt: minutes(5),
      consecutiveRollbacks: 1,
    });
    return base;
  };

  it("refuses a second automatic rollback inside the cooldown window", () => {
    const decision = decide({ state: rolledBackState(), signals: ERROR_RATE_BROKEN, now: NOW });
    expect(decision.action).toBe("hold");
    expect(decision.code).toBe("cooldown");
    expect(decision.reason).toContain("flapping");
  });

  it("allows a rollback again once the cooldown has elapsed", () => {
    const state = promoted(90, { lastRollbackAt: minutes(45), consecutiveRollbacks: 1 });
    const decision = decide({ state, signals: ERROR_RATE_BROKEN, now: NOW });
    expect(decision.action).toBe("rollback");
  });

  it("opens the circuit breaker when the rejected artifact is re-promoted inside the cooldown", () => {
    // Rolled back 10m ago, and then a *new* promotion landed 5m ago.
    const state = promoted(5, { lastRollbackAt: minutes(10), consecutiveRollbacks: 1 });
    const decision = decide({ state, signals: ERROR_RATE_BROKEN, now: NOW });
    expect(decision.action).toBe("hold");
    expect(decision.code).toBe("breaker-open");
    expect(decision.openBreaker).toBe(true);
    expect(decision.reason).toContain("re-promoted");
  });

  it("refuses to roll back at all once the breaker is open, even on a fresh signal", () => {
    const state = promoted(20, { breakerOpen: true, consecutiveRollbacks: 3 });
    const decision = decide({ state, signals: ERROR_RATE_BROKEN, now: NOW });
    expect(decision.action).toBe("hold");
    expect(decision.code).toBe("breaker-open");
    expect(decision.reason).toContain("mode=force");
  });

  it("force overrides every guard, including an open breaker", () => {
    const state = promoted(20, {
      breakerOpen: true,
      consecutiveRollbacks: 3,
      lastRollbackAt: minutes(1),
    });
    const decision = decide({
      state,
      signals: ERROR_RATE_BROKEN,
      now: NOW,
      mode: "force",
      reason: "operator sees the incident on the dashboard",
    });
    expect(decision.action).toBe("rollback");
    expect(decision.rollbackTo).toBe("sha-prevgood");
  });

  it("an operator hold suppresses automatic rollbacks until it lapses", () => {
    const state = promoted(20, { manualHoldUntil: minutes(-10) });
    const decision = decide({ state, signals: ERROR_RATE_BROKEN, now: NOW });
    expect(decision.action).toBe("hold");
    expect(decision.code).toBe("manual-hold");
  });
});

describe("manual overrides", () => {
  it("mode=never prevents a rollback that would otherwise fire", () => {
    const decision = decide({
      state: promoted(20),
      signals: ERROR_RATE_BROKEN,
      now: NOW,
      mode: "never",
      reason: "known SDK bug, fix lands tomorrow",
    });
    expect(decision.action).toBe("hold");
    expect(decision.code).toBe("manual-hold");
    expect(decision.manualHoldUntil).toBeDefined();
    expect(Date.parse(decision.manualHoldUntil!)).toBeGreaterThan(Date.parse(NOW));
  });

  it("mode=never works even when there is no state at all", () => {
    const decision = decide({ state: emptyState(), signals: null, now: NOW, mode: "never" });
    expect(decision.action).toBe("hold");
    expect(decision.code).toBe("manual-hold");
  });
});

describe("state transitions", () => {
  it("treats the previously-live ref as the rollback target", () => {
    const state = recordPromotion(parseState({}), {
      ref: "sha-b",
      previousRef: "sha-a",
      at: minutes(1),
    });
    expect(state.currentRef).toBe("sha-b");
    expect(state.lastKnownGoodRef).toBe("sha-a");
  });

  it("does not let a deploy clear the breaker's memory", () => {
    let state = promoted(20, { breakerOpen: true, consecutiveRollbacks: 3 });
    state = recordPromotion(state, { ref: "sha-c", previousRef: "sha-b", at: minutes(1) });
    expect(state.breakerOpen).toBe(true);
    expect(state.consecutiveRollbacks).toBe(3);
  });

  it("counts consecutive rollbacks and opens the breaker past the max", () => {
    // Three separate incidents, each spaced far enough apart to clear the
    // observation window and the cooldown, each rolling back for real.
    const at = (offsetMinutes: number) =>
      new Date(Date.parse(NOW) + offsetMinutes * 60_000).toISOString();
    const deploy = (state: ReturnType<typeof parseState>, atIso: string, ref: string) =>
      recordPromotion(state, { ref, at: atIso });
    const run = (state: ReturnType<typeof parseState>, now: string) => {
      const decision = decide({ state, signals: ERROR_RATE_BROKEN, now });
      expect(decision.action).toBe("rollback");
      return applyDecision(state, decision, now);
    };

    let state = deploy(parseState({}), at(-30), "sha-b");
    state = run(state, at(0));
    expect(state.consecutiveRollbacks).toBe(1);
    expect(state.breakerOpen).toBe(false);

    state = deploy(state, at(30), "sha-c");
    state = run(state, at(60));
    expect(state.consecutiveRollbacks).toBe(2);
    expect(state.breakerOpen).toBe(false);

    state = deploy(state, at(90), "sha-d");
    state = run(state, at(120));
    expect(state.consecutiveRollbacks).toBe(3);
    // maxConsecutiveRollbacks is 2, so the third consecutive rollback trips it.
    expect(state.breakerOpen).toBe(true);
  });

  it("a healthy verdict resets the consecutive-rollback counter", () => {
    const state = promoted(20, { lastRollbackAt: minutes(120), consecutiveRollbacks: 2 });
    const next = applyDecision(state, decide({ state, signals: HEALTHY, now: NOW }), NOW);
    expect(next.consecutiveRollbacks).toBe(0);
  });

  it("a hold never advances the rollback counter", () => {
    const state = promoted(2, { consecutiveRollbacks: 1 });
    const decision = decide({ state, signals: ERROR_RATE_BROKEN, now: NOW });
    const next = applyDecision(state, decision, NOW);
    expect(decision.code).toBe("observation-window");
    expect(next.consecutiveRollbacks).toBe(1);
    expect(next.lastRollbackAt).toBeNull();
  });

  it("a forced rollback clears the breaker, because a human has taken over", () => {
    const state = promoted(20, { breakerOpen: true, consecutiveRollbacks: 3 });
    const next = applyDecision(
      state,
      decide({ state, signals: ERROR_RATE_BROKEN, now: NOW, mode: "force" }),
      NOW
    );
    expect(next.breakerOpen).toBe(false);
    expect(next.consecutiveRollbacks).toBe(0);
    expect(next.history.at(-1)?.action).toBe("forced-rollback");
  });

  it("keeps history bounded", () => {
    let state = parseState({ version: 1, history: [] });
    for (let i = 0; i < 40; i += 1) {
      state = recordPromotion(state, { ref: `sha-${i}`, previousRef: `sha-${i - 1}`, at: NOW });
    }
    expect(state.history.length).toBeLessThanOrEqual(20);
  });

  it("falls back to a clean state for corrupt input rather than throwing", () => {
    expect(parseState(null).breakerOpen).toBe(false);
    expect(parseState("nope").currentRef).toBeNull();
    expect(parseState({ version: 0, lastPromotedAt: "garbage" }).lastPromotedAt).toBeNull();
    expect(parseState({ version: 1, consecutiveRollbacks: -4 }).consecutiveRollbacks).toBe(0);
  });

  it("refuses a promotion timestamped in the future", () => {
    const state = parseState({
      version: 1,
      lastPromotedAt: new Date(Date.parse(NOW) + 60_000).toISOString(),
      currentRef: "sha-x",
    });
    expect(decide({ state, signals: ERROR_RATE_BROKEN, now: NOW }).code).toBe("clock-skew");
  });
});
