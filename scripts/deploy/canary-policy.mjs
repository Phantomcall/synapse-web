// Canary promote / rollback decision (#156). Pure: no I/O, no clock.
//
// The controller (canary-controller.mjs) calls `decide` once per poll with
// everything observed so far for the current stage and acts on the result:
//
//   rollback  a health signal crossed a rollback threshold; stop immediately
//   advance   the stage has baked long enough and every signal is healthy
//   wait      not enough time or evidence yet
//
// Two kinds of signal feed it:
//
//   synthetic  the controller's own HTTP probes of the canary deployment URL.
//              Always present, so a deploy is never promoted on zero evidence,
//              and fast: consecutive failures trigger a rollback within a
//              couple of probe intervals.
//   RUM        real-user error rate and Core Web Vitals (p75) for the canary
//              and the current production deployment, from the telemetry
//              signals endpoint. A RUM rule only applies once its sample size
//              is met. Below that, it is reported as "insufficient data" and
//              does not block promotion. Otherwise a low-traffic testnet
//              dashboard could never promote.
//
// Every threshold lives in .github/canary-policy.json and is documented in
// docs/deploy/canary-rollout.md.

/**
 * @typedef {{ ok: boolean, status?: number, error?: string, durationMs?: number }} Probe
 * @typedef {{ p75: number, samples: number }} Vital
 * @typedef {{ requests: number, errors: number, webVitals?: { lcp?: Vital, inp?: Vital, cls?: Vital } }} RumSignals
 * @typedef {{
 *   bakeMinutes: number,
 *   synthetic: { consecutiveFailures: number, window: number, minProbes: number, maxFailureRatio: number },
 *   errorRate: { max: number, maxRatioToBaseline: number, minRequests: number },
 *   webVitals: {
 *     minSamples: number,
 *     maxRegressionRatio: number,
 *     lcp: { goodMs: number, poorMs: number },
 *     inp: { goodMs: number, poorMs: number },
 *     cls: { good: number, poor: number },
 *   },
 * }} CanaryPolicy
 */

/**
 * @param {{
 *   policy: CanaryPolicy,
 *   stageElapsedMs: number,
 *   probes: Probe[],
 *   canary?: RumSignals | null,
 *   baseline?: RumSignals | null,
 * }} input
 * @returns {{ action: "rollback" | "advance" | "wait", reasons: string[], notes: string[] }}
 */
export function decide({ policy, stageElapsedMs, probes, canary, baseline }) {
  const reasons = [];
  const notes = [];

  // ── Synthetic probes ───────────────────────────────────────────────────────
  const { consecutiveFailures, window, minProbes, maxFailureRatio } = policy.synthetic;
  let streak = 0;
  for (let i = probes.length - 1; i >= 0 && !probes[i].ok; i--) streak++;
  if (streak >= consecutiveFailures) {
    const last = probes[probes.length - 1];
    reasons.push(
      `synthetic: ${streak} consecutive failed probes (limit ${consecutiveFailures}); last: ${describeProbe(last)}`
    );
  }
  const recent = probes.slice(-window);
  const failed = recent.filter((p) => !p.ok).length;
  if (
    recent.length >= minProbes &&
    failed / recent.length > maxFailureRatio &&
    streak < consecutiveFailures
  ) {
    reasons.push(
      `synthetic: ${failed}/${recent.length} recent probes failed (${pct(failed / recent.length)} > ${pct(maxFailureRatio)})`
    );
  }

  // ── Real-user error rate ─────────────────────────────────────────────────────
  if (canary) {
    const { max, maxRatioToBaseline, minRequests } = policy.errorRate;
    if (canary.requests < minRequests) {
      notes.push(`error rate: insufficient data (${canary.requests}/${minRequests} requests)`);
    } else {
      const rate = canary.errors / canary.requests;
      const baseRate =
        baseline && baseline.requests >= minRequests ? baseline.errors / baseline.requests : null;
      // Absolute ceiling AND relative to production. A canary that is as bad as
      // what's already serving users is not a regression this deploy caused.
      const overAbsolute = rate > max;
      const overRelative = baseRate === null || rate > baseRate * maxRatioToBaseline;
      if (overAbsolute && overRelative) {
        reasons.push(
          `error rate: canary ${pct(rate)} over ${canary.requests} requests > ${pct(max)}` +
            (baseRate === null ? "" : ` and > ${maxRatioToBaseline}× production (${pct(baseRate)})`)
        );
      } else {
        notes.push(
          `error rate: canary ${pct(rate)}${baseRate === null ? "" : `, production ${pct(baseRate)}`}`
        );
      }
    }

    // ── Core Web Vitals (p75) ──────────────────────────────────────────────────
    const wv = policy.webVitals;
    const vitals = /** @type {const} */ ([
      ["lcp", wv.lcp.goodMs, wv.lcp.poorMs, "ms"],
      ["inp", wv.inp.goodMs, wv.inp.poorMs, "ms"],
      ["cls", wv.cls.good, wv.cls.poor, ""],
    ]);
    for (const [name, good, poor, unit] of vitals) {
      const c = canary.webVitals?.[name];
      if (!c || c.samples < wv.minSamples) {
        notes.push(
          `${name.toUpperCase()}: insufficient data (${c?.samples ?? 0}/${wv.minSamples} samples)`
        );
        continue;
      }
      const b = baseline?.webVitals?.[name];
      const baseP75 = b && b.samples >= wv.minSamples ? b.p75 : null;
      const label = `${name.toUpperCase()} p75 ${fmt(c.p75, unit)}`;
      if (c.p75 > poor) {
        reasons.push(`${label} is in the "poor" range (> ${fmt(poor, unit)})`);
      } else if (baseP75 !== null && c.p75 > good && c.p75 > baseP75 * wv.maxRegressionRatio) {
        // Relative regressions only count once the canary leaves the "good"
        // range, so 40 ms → 60 ms INP does not roll back a deploy.
        reasons.push(
          `${label} regressed > ${wv.maxRegressionRatio}× production (${fmt(baseP75, unit)}) and is above "good" (${fmt(good, unit)})`
        );
      } else {
        notes.push(`${label}${baseP75 === null ? "" : ` (production ${fmt(baseP75, unit)})`}`);
      }
    }
  } else {
    notes.push("RUM signals unavailable; deciding on synthetic probes only");
  }

  if (reasons.length) return { action: "rollback", reasons, notes };

  const bakeMs = policy.bakeMinutes * 60_000;
  if (stageElapsedMs < bakeMs) {
    notes.push(`baking: ${Math.floor(stageElapsedMs / 60_000)}/${policy.bakeMinutes} min`);
    return { action: "wait", reasons, notes };
  }
  if (recent.length < minProbes) {
    notes.push(`waiting for synthetic evidence: ${recent.length}/${minProbes} probes`);
    return { action: "wait", reasons, notes };
  }
  return { action: "advance", reasons, notes };
}

/** @param {Probe | undefined} p */
function describeProbe(p) {
  if (!p) return "none";
  return p.error ?? `HTTP ${p.status}`;
}

const pct = (n) => `${(n * 100).toFixed(2)}%`;
const fmt = (n, unit) => (unit === "ms" ? `${Math.round(n)} ms` : n.toFixed(3));

/**
 * Validates a policy file so a typo fails the deploy before any traffic moves,
 * rather than silently disabling a rule.
 *
 * @param {any} p
 * @returns {CanaryPolicy}
 */
export function validatePolicy(p) {
  const problems = [];
  const num = (path, min = 0) => {
    const v = path.split(".").reduce((o, k) => o?.[k], p);
    if (typeof v !== "number" || !Number.isFinite(v) || v < min)
      problems.push(`${path} must be a number >= ${min}`);
  };
  num("bakeMinutes", 0);
  num("synthetic.consecutiveFailures", 1);
  num("synthetic.window", 1);
  num("synthetic.minProbes", 1);
  num("synthetic.maxFailureRatio");
  num("errorRate.max");
  num("errorRate.maxRatioToBaseline", 1);
  num("errorRate.minRequests", 1);
  num("webVitals.minSamples", 1);
  num("webVitals.maxRegressionRatio", 1);
  for (const k of ["lcp.goodMs", "lcp.poorMs", "inp.goodMs", "inp.poorMs", "cls.good", "cls.poor"])
    num(`webVitals.${k}`);
  if (problems.length) throw new Error(`Invalid canary policy:\n  ${problems.join("\n  ")}`);
  return p;
}
