/**
 * Rollback decision policy.
 *
 * This module is the whole decision surface for `.github/workflows/rollback.yml`.
 * It is deliberately a plain ES module with no I/O so the interesting parts — the
 * health-signal thresholds, the observation window, and the flapping circuit
 * breaker — can be unit tested in CI without a deploy platform, a production
 * alias, or a monitoring account.
 *
 * The workflow also drives it as a CLI:
 *
 *     node scripts/deploy/rollback-policy.mjs --input request.json
 *
 * which prints GitHub Actions `key=value` output lines on stdout.
 *
 * ── Framing: what a "rollback" is ────────────────────────────────────────────────
 * Synapse Core is a stateless frontend. Rolling back means *serve the previous
 * immutable build* — re-point the production alias at whatever artifact
 * `lastKnownGoodRef` points at. There is no schema to migrate, no queue to drain
 * and no state to unwind, so a rollback is a single idempotent alias move.
 *
 * ── Why the breaker exists ─────────────────────────────────────────────────────
 * The failure mode is a flip-flop loop: deploy A is judged bad, we roll back, the
 * next deploy promotes the same bad artifact again, we roll back again, and CI
 * spends its life flapping until people stop reading it. Three independent guards
 * stop that, and each is separately tested in `rollback-policy.test.ts`:
 *
 *   1. observation window — never judge a promotion before it has had
 *      `observationWindowMinutes` to fail, so a cold-start error spike cannot
 *      trigger a rollback of a build that was about to be fine;
 *   2. cooldown — after a rollback, refuse further *automatic* rollbacks for
 *      `cooldownMinutes`, and treat a promotion that lands inside that window as
 *      a flapping signal rather than a fresh incident;
 *   3. circuit breaker — after `maxConsecutiveRollbacks` in a row, or on a
 *      promotion inside the post-rollback cooldown, the breaker opens, automatic
 *      rollback stops entirely and the workflow fails loudly for a human.
 *
 * The breaker is cleared only by an operator (`mode: "force"` or `mode: "never"`),
 * never by a deploy — otherwise the very thing it exists to stop, an automated
 * deploy pipeline, would clear it.
 *
 * `mode: "force"` and `mode: "never"` bypass guards 1–3, which is what makes them
 * usable as a recovery hatch when the automation is itself the problem.
 */

/** Bumped when the on-disk state.json shape changes incompatibly. */
export const STATE_VERSION = 1;

/** Maximum entries retained in `state.history` so the state branch cannot grow forever. */
export const HISTORY_LIMIT = 20;

export const DEFAULT_THRESHOLDS = {
  /** Do not judge a promotion until it is at least this old. */
  observationWindowMinutes: 15,
  /** After a rollback, no further *automatic* rollback for this long. */
  cooldownMinutes: 30,
  /** Automatic rollback stops entirely once this many rollbacks happen in a row. */
  maxConsecutiveRollbacks: 2,
  /** Fraction of failed requests (0–1) that counts as degraded. */
  maxErrorRate: 0.01,
  /** Fraction of failed synthetic checks (0–1) that counts as degraded. */
  maxSyntheticFailureRatio: 0.25,
  /** Below this many synthetic checks the signal is too noisy to act on. */
  minSyntheticSamples: 3,
  /** Below this many requests the error rate is too noisy to act on. */
  minRequests: 50,
};

const MINUTE_MS = 60_000;

/**
 * @typedef {object} Decision
 * @property {"rollback"|"hold"} action
 * @property {string} code
 * @property {string} reason
 * @property {string|null} rollbackTo
 * @property {"auto"|"force"|"never"} [mode]
 * @property {boolean} [openBreaker]
 * @property {string} [manualHoldUntil]
 * @property {Array<{signal: string, observed: number, threshold: number, message: string}>} [breaches]
 */

/** @returns {ReturnType<typeof emptyState>} */
export function emptyState() {
  return {
    version: STATE_VERSION,
    lastPromotedAt: null,
    currentRef: null,
    lastKnownGoodRef: null,
    lastRollbackAt: null,
    lastAction: null,
    lastReason: null,
    consecutiveRollbacks: 0,
    breakerOpen: false,
    /** Set by `mode: "never"`; suppresses automatic rollbacks until it lapses. */
    manualHoldUntil: null,
    history: [],
  };
}

/**
 * Tolerant parser. Anything missing, unrecognised or from an older shape falls back
 * to the default rather than throwing: a corrupt state file must not be able to
 * wedge the rollback path entirely.
 *
 * @param {unknown} raw
 * @returns {ReturnType<typeof emptyState>}
 */
export function parseState(raw) {
  const state = emptyState();
  if (typeof raw !== "object" || raw === null) return state;

  const iso = (value) =>
    typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null;

  if (raw.version === STATE_VERSION) {
    state.lastPromotedAt = iso(raw.lastPromotedAt);
    state.lastRollbackAt = iso(raw.lastRollbackAt);
    state.manualHoldUntil = iso(raw.manualHoldUntil);
  }
  if (typeof raw.currentRef === "string") state.currentRef = raw.currentRef;
  if (typeof raw.lastKnownGoodRef === "string") state.lastKnownGoodRef = raw.lastKnownGoodRef;
  if (typeof raw.lastAction === "string") state.lastAction = raw.lastAction;
  if (typeof raw.lastReason === "string") state.lastReason = raw.lastReason;
  if (Number.isInteger(raw.consecutiveRollbacks)) {
    state.consecutiveRollbacks = Math.max(0, raw.consecutiveRollbacks);
  }
  state.breakerOpen = raw.breakerOpen === true;
  state.history = Array.isArray(raw.history)
    ? raw.history.filter((entry) => entry && typeof entry === "object").slice(-HISTORY_LIMIT)
    : [];
  return state;
}

function minutesBetween(fromIso, toIso) {
  return (Date.parse(toIso) - Date.parse(fromIso)) / MINUTE_MS;
}

function pushHistory(history, entry) {
  return [...history, entry].slice(-HISTORY_LIMIT);
}

/**
 * Record that `ref` is now live in production.
 *
 * `previousRef` becomes the rollback target: it is the artifact that was serving
 * successfully immediately before this promotion, which is exactly what a stateless
 * rollback should re-serve.
 *
 * Deliberately does *not* touch `consecutiveRollbacks` or `breakerOpen` — see the
 * note at the top of this file.
 *
 * @param {ReturnType<typeof emptyState>} state
 * @param {{ ref?: string, previousRef?: string, at: string, reason?: string }} promotion
 * @returns {ReturnType<typeof emptyState>}
 */
export function recordPromotion(state, { ref, previousRef, at, reason }) {
  if (!ref) return { ...state };
  const next = { ...state };
  const replacedADifferentRef = Boolean(state.currentRef) && state.currentRef !== ref;
  next.currentRef = ref;
  next.lastPromotedAt = at;
  if (replacedADifferentRef) {
    next.lastKnownGoodRef = previousRef ?? state.currentRef;
  } else if (previousRef && previousRef !== ref) {
    next.lastKnownGoodRef = previousRef;
  }
  next.history = pushHistory(state.history, { at, action: "promote", ref, reason });
  return next;
}

/**
 * Compare health signals against the configured thresholds.
 *
 * Returns the individual breaches so the operator sees *which* signal fired, not
 * just "something broke". Insufficient sample size is deliberately a different
 * outcome from a clean bill of health: acting on five requests is how you earn a
 * false rollback.
 *
 * @param {any} signals
 * @param {Partial<typeof DEFAULT_THRESHOLDS>} [thresholds]
 */
export function evaluateSignals(signals, thresholds) {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const breaches = [];
  let tooFewSamples = false;

  const requests = Number(signals?.requests ?? NaN);
  const errorRate = Number(signals?.errorRate ?? NaN);
  if (Number.isFinite(requests) && Number.isFinite(errorRate)) {
    if (requests < t.minRequests) {
      tooFewSamples = true;
    } else if (errorRate > t.maxErrorRate) {
      breaches.push({
        signal: "error-rate",
        observed: errorRate,
        threshold: t.maxErrorRate,
        message: `error rate ${(errorRate * 100).toFixed(2)}% exceeds ${(t.maxErrorRate * 100).toFixed(2)}%`,
      });
    }
  } else {
    tooFewSamples = true;
  }

  const synthetic = signals?.synthetic ?? {};
  const syntheticTotal = Number(synthetic.total ?? NaN);
  const syntheticFailed = Number(synthetic.failed ?? NaN);
  if (Number.isFinite(syntheticTotal) && Number.isFinite(syntheticFailed)) {
    if (syntheticTotal < t.minSyntheticSamples) {
      tooFewSamples = true;
    } else {
      const ratio = syntheticTotal === 0 ? 0 : syntheticFailed / syntheticTotal;
      if (ratio > t.maxSyntheticFailureRatio) {
        breaches.push({
          signal: "synthetic",
          observed: ratio,
          threshold: t.maxSyntheticFailureRatio,
          message: `synthetic failures ${syntheticFailed}/${syntheticTotal} (${(ratio * 100).toFixed(0)}%) exceeds ${(t.maxSyntheticFailureRatio * 100).toFixed(0)}%`,
        });
      }
    }
  } else {
    tooFewSamples = true;
  }

  if (breaches.length > 0) return { degraded: true, tooFewSamples: false, breaches };
  return { degraded: false, tooFewSamples, breaches: [] };
}

/**
 * @param {string} code
 * @param {string} reason
 * @param {Partial<Decision>} [extra]
 * @returns {Decision}
 */
const hold = (code, reason, extra = {}) => ({
  action: "hold",
  code,
  reason,
  rollbackTo: null,
  ...extra,
});

/**
 * The single decision function.
 *
 * @param {object} input
 * @param {ReturnType<typeof parseState>} input.state
 * @param {object|null} input.signals   health-signal payload, or null if unavailable
 * @param {string} input.now            ISO timestamp the decision is made at
 * @param {object} [input.thresholds]   overrides for DEFAULT_THRESHOLDS
 * @param {"auto"|"force"|"never"} [input.mode]  manual override
 * @param {string} [input.reason]       operator note, recorded in state
 * @returns {Decision}
 */
export function decide({ state, signals, now, thresholds, mode = "auto", reason = "" }) {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };

  // ── Manual override: prevent ───────────────────────────────────────────────────
  // Checked first so an operator can always suppress a rollback, even when the
  // health-signal source is unconfigured and everything below would error out.
  if (mode === "never") {
    return hold("manual-hold", `operator selected "never": ${reason || "no reason given"}`, {
      mode,
      manualHoldUntil: new Date(Date.parse(now) + t.cooldownMinutes * MINUTE_MS).toISOString(),
    });
  }

  // ── Is there a promotion to evaluate? ──────────────────────────────────────────
  if (!state.lastPromotedAt || !state.currentRef) {
    return hold(
      "no-promotion",
      "no promotion recorded in the deploy state; nothing to evaluate. Fire repository_dispatch `deploy_completed` from the deploy pipeline to record one"
    );
  }

  const ageMinutes = minutesBetween(state.lastPromotedAt, now);
  if (ageMinutes < 0) {
    return hold(
      "clock-skew",
      `recorded promotion at ${state.lastPromotedAt} is in the future relative to ${now}`
    );
  }

  // ── Flapping guards 2 + 3 ──────────────────────────────────────────────────────
  // Evaluated before the health signals on purpose. If we have already rolled back
  // recently, more data is not the missing ingredient — a human is. Reading the
  // signals here would also let a *re-promotion of the artifact we just rejected*
  // immediately roll back again, which is the exact loop being prevented.
  if (mode !== "force") {
    if (state.manualHoldUntil && Date.parse(now) < Date.parse(state.manualHoldUntil)) {
      return hold("manual-hold", `operator hold in force until ${state.manualHoldUntil}`);
    }

    if (state.breakerOpen) {
      return hold(
        "breaker-open",
        `circuit breaker is open (${state.consecutiveRollbacks} consecutive rollbacks); automatic rollback is suspended until a human runs mode=force or mode=never`
      );
    }

    if (state.lastRollbackAt) {
      const sinceRollback = minutesBetween(state.lastRollbackAt, now);
      const promotionAfterRollback =
        state.lastPromotedAt && minutesBetween(state.lastRollbackAt, state.lastPromotedAt) >= 0
          ? minutesBetween(state.lastRollbackAt, state.lastPromotedAt)
          : null;

      // A promotion inside the post-rollback cooldown means the deploy pipeline
      // re-promoted the artifact we just rejected. Latch the breaker instead of
      // rolling back a third time.
      if (promotionAfterRollback !== null && promotionAfterRollback < t.cooldownMinutes) {
        return {
          action: "hold",
          code: "breaker-open",
          reason:
            `ref ${state.currentRef} was promoted ${promotionAfterRollback.toFixed(1)}m after a rollback — ` +
            `the rejected artifact is being re-promoted. Opening the circuit breaker; automatic rollback ` +
            `is suspended until a human runs mode=force or mode=never`,
          rollbackTo: null,
          mode,
          openBreaker: true,
        };
      }

      if (sinceRollback < t.cooldownMinutes) {
        return hold(
          "cooldown",
          `last rollback was ${sinceRollback.toFixed(1)}m ago; refusing another automatic rollback until ${t.cooldownMinutes}m has elapsed, to avoid flapping`
        );
      }
    }
  }

  // ── Flapping guard 1: the observation window ───────────────────────────────────
  if (mode !== "force" && ageMinutes < t.observationWindowMinutes) {
    return hold(
      "observation-window",
      `ref ${state.currentRef} is ${ageMinutes.toFixed(1)}m old; holding until the ${t.observationWindowMinutes}m observation window closes`
    );
  }

  // ── Health signals ────────────────────────────────────────────────────────────
  if (!signals) {
    return hold("no-signals", "health signals were unavailable; refusing to guess");
  }

  const health = evaluateSignals(signals, t);
  if (health.degraded) {
    return {
      action: "rollback",
      code: "degraded",
      reason: health.breaches.map((breach) => breach.message).join("; "),
      rollbackTo: state.lastKnownGoodRef,
      breaches: health.breaches,
      mode,
    };
  }

  return hold(
    health.tooFewSamples ? "insufficient-data" : "healthy",
    health.tooFewSamples
      ? "not enough traffic or synthetic checks in the window to judge the deployment either way"
      : `health signals within thresholds (error rate ${Number(signals.errorRate).toFixed(4)}, synthetic ${signals.synthetic?.failed ?? 0}/${signals.synthetic?.total ?? 0})`,
    { mode }
  );
}

/**
 * Fold a decision back into the state so the next run can see what happened.
 *
 * Only decisions that actually ran are recorded; a `hold` never advances the
 * rollback counter, which is what keeps the breaker from latching on mere
 * observation. A `healthy` verdict *does* reset the counter, because a build that
 * has been healthy since the last rollback is evidence the incident is over.
 *
 * @param {ReturnType<typeof emptyState>} state
 * @param {Decision} decision
 * @param {string} now
 * @param {Partial<typeof DEFAULT_THRESHOLDS>} [thresholds]
 * @returns {ReturnType<typeof emptyState>}
 */
export function applyDecision(state, decision, now, thresholds) {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const next = { ...state, lastAction: decision.action, lastReason: decision.reason };

  // An operator taking over clears the automation's memory: the human has looked.
  if (decision.mode === "force" || decision.mode === "never") {
    next.consecutiveRollbacks = 0;
    next.breakerOpen = false;
  }

  if (decision.manualHoldUntil) next.manualHoldUntil = decision.manualHoldUntil;

  if (decision.action === "rollback") {
    next.lastRollbackAt = now;
    if (decision.mode === "force") {
      // An operator-driven rollback is not evidence that the automation is
      // misfiring, so it must not count towards the breaker or re-latch it.
      next.consecutiveRollbacks = 0;
      next.breakerOpen = false;
    } else {
      next.consecutiveRollbacks = (state.consecutiveRollbacks ?? 0) + 1;
      next.breakerOpen = next.consecutiveRollbacks > t.maxConsecutiveRollbacks;
    }
    if (decision.rollbackTo) next.lastKnownGoodRef = decision.rollbackTo;
    next.history = pushHistory(state.history, {
      at: now,
      action: decision.mode === "force" ? "forced-rollback" : "rollback",
      ref: state.currentRef,
      toRef: decision.rollbackTo,
      reason: decision.reason,
    });
    return next;
  }

  if (decision.openBreaker) next.breakerOpen = true;

  if (decision.code === "healthy") next.consecutiveRollbacks = 0;

  next.history = pushHistory(state.history, {
    at: now,
    action: decision.code,
    ref: state.currentRef,
    reason: decision.reason,
  });
  return next;
}

// ── CLI ─────────────────────────────────────────────────────────────────────────
// Prints GitHub Actions `key=value` output lines and, with --state-out, writes the
// post-decision state back to disk. Used by rollback.yml; the workflow reads
// `action`, `rollback_to` and the breaker flags from $GITHUB_OUTPUT.

async function readJson(path) {
  const { readFile } = await import("node:fs/promises");
  return JSON.parse(await readFile(path, "utf8"));
}

async function main(argv) {
  const flag = (name) => {
    const index = argv.indexOf(name);
    return index === -1 ? undefined : argv[index + 1];
  };

  const input = flag("--input") ? await readJson(flag("--input")) : {};
  const now = input.now ?? new Date().toISOString();
  const state = parseState(input.state);
  const decision = decide({
    state,
    signals: input.signals ?? null,
    now,
    thresholds: input.thresholds,
    mode: input.mode,
    reason: input.reason,
  });
  const nextState =
    input.dryRun === true ? state : applyDecision(state, decision, now, input.thresholds);

  const stateOut = flag("--state-out");
  if (stateOut) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(stateOut, `${JSON.stringify(nextState, null, 2)}\n`);
  }

  process.stdout.write(
    [
      `action=${decision.action}`,
      `code=${decision.code}`,
      `rollback_to=${decision.rollbackTo ?? ""}`,
      `breaker_was_open=${state.breakerOpen ? 1 : 0}`,
      `breaker_open=${nextState.breakerOpen ? 1 : 0}`,
      // JSON-encoded so the value survives being appended to $GITHUB_OUTPUT.
      `reason=${JSON.stringify(decision.reason)}`,
      "",
    ].join("\n")
  );
}

if (process.argv[1]?.endsWith("rollback-policy.mjs")) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`rollback-policy: ${error?.message ?? error}\n`);
    process.exit(1);
  });
}
