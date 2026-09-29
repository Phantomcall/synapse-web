import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ALERT_RULE_NAMES,
  ALERT_THRESHOLDS,
  MIN_EVENTS_PERCENTILE,
  buildAlertPayload,
  evaluateAlerts,
  evaluateErrorRate,
  evaluateWebVitals,
  firedAlerts,
  type AlertScope,
  type ErrorRateThreshold,
  type WebVitalsThreshold,
} from "./alertRules";

const REPO_ROOT = join(__dirname, "..", "..");

const SCOPE: AlertScope = {
  environment: "production",
  route: "/",
  release: "synapse-web@1.4.0",
};

const CRITICAL_ERROR_RATE: ErrorRateThreshold = {
  kind: "error-rate",
  severity: "critical",
  name: "Error rate critical",
  windowMinutes: 15,
  minEvents: 20,
  maxErrorRatio: 0.05,
  maxErrorCount: 100,
};

const LCP_WARNING: WebVitalsThreshold = {
  kind: "web-vitals",
  severity: "warning",
  name: "LCP p75 warning",
  metric: "LCP",
  windowMinutes: 60,
  minSamples: 100,
  maxP75: 2500,
  maxRegressionRatio: 0.25,
};

describe("evaluateErrorRate — volume floor", () => {
  it("suppresses a 100% error rate that is below the minimum event count", () => {
    // The core anti-alert-fatigue case: 1 error out of 1 event is a 100% ratio,
    // which would page on any single unlucky request during a quiet period.
    const decision = evaluateErrorRate(CRITICAL_ERROR_RATE, {
      scope: SCOPE,
      totalEvents: 1,
      errorEvents: 1,
    });

    expect(decision.fired).toBe(false);
    expect(decision.suppressedBy).toBe("not-enough-events");
    expect(decision.breach).toBeNull();
  });

  it("evaluates the ratio only once the window has enough errors", () => {
    // The floor is on *errors*, not on total events. 19 errors out of 200 is a
    // 9.5% ratio — well over the 5% limit — and must still be suppressed,
    // because 19 requests' worth of data is not a signal.
    const justUnderFloor = evaluateErrorRate(CRITICAL_ERROR_RATE, {
      scope: SCOPE,
      totalEvents: 200,
      errorEvents: 19,
    });
    expect(justUnderFloor.suppressedBy).toBe("not-enough-events");

    const onTheFloor = evaluateErrorRate(CRITICAL_ERROR_RATE, {
      scope: SCOPE,
      totalEvents: 200,
      errorEvents: 20,
    });
    expect(onTheFloor.fired).toBe(true);
    expect(onTheFloor.breach?.check).toBe("error-ratio");
  });
});

describe("evaluateErrorRate — ratio and count thresholds", () => {
  it("does not fire when the ratio sits exactly on the limit", () => {
    // 5% of 1000 is exactly 0.05; the rule is "strictly greater than".
    const decision = evaluateErrorRate(CRITICAL_ERROR_RATE, {
      scope: SCOPE,
      totalEvents: 1000,
      errorEvents: 50,
    });

    expect(decision.fired).toBe(false);
    expect(decision.suppressedBy).toBe("within-threshold");
  });

  it("fires once the ratio exceeds the limit and reports the magnitude", () => {
    const decision = evaluateErrorRate(CRITICAL_ERROR_RATE, {
      scope: SCOPE,
      totalEvents: 1000,
      errorEvents: 74,
    });

    expect(decision.fired).toBe(true);
    expect(decision.breach).toEqual({
      check: "error-ratio",
      observed: 0.074,
      limit: 0.05,
      multiple: 1.48,
      relativeToBaseline: false,
      baseline: null,
    });
  });

  it("fires on absolute error count when the ratio is low but the volume is high", () => {
    // 1% ratio, but 400 errors in 15 minutes is a real incident on a small
    // deployment where the ratio alone would look benign.
    const decision = evaluateErrorRate(CRITICAL_ERROR_RATE, {
      scope: SCOPE,
      totalEvents: 40000,
      errorEvents: 400,
    });

    expect(decision.fired).toBe(true);
    expect(decision.breach).toEqual({
      check: "error-count",
      observed: 400,
      limit: 100,
      multiple: 4,
      relativeToBaseline: false,
      baseline: null,
    });
  });

  it("does not fire when both the ratio and the count are within limits", () => {
    const decision = evaluateErrorRate(CRITICAL_ERROR_RATE, {
      scope: SCOPE,
      totalEvents: 10000,
      errorEvents: 100,
    });

    expect(decision.fired).toBe(false);
    expect(decision.suppressedBy).toBe("within-threshold");
  });

  it("treats a zero-event window as zero errors rather than dividing by zero", () => {
    const decision = evaluateErrorRate(CRITICAL_ERROR_RATE, {
      scope: SCOPE,
      totalEvents: 0,
      errorEvents: 0,
    });

    expect(decision.fired).toBe(false);
    expect(decision.suppressedBy).toBe("not-enough-events");
  });
});

describe("evaluateErrorRate — malformed samples", () => {
  it("suppresses a sample whose error count exceeds its total", () => {
    const decision = evaluateErrorRate(CRITICAL_ERROR_RATE, {
      scope: SCOPE,
      totalEvents: 100,
      errorEvents: 101,
    });

    expect(decision.fired).toBe(false);
    expect(decision.suppressedBy).toBe("invalid-sample");
  });

  it("suppresses non-finite and negative counts instead of alerting on them", () => {
    const nan = evaluateErrorRate(CRITICAL_ERROR_RATE, {
      scope: SCOPE,
      totalEvents: Number.NaN,
      errorEvents: 50,
    });
    expect(nan.suppressedBy).toBe("invalid-sample");

    const negative = evaluateErrorRate(CRITICAL_ERROR_RATE, {
      scope: SCOPE,
      totalEvents: 1000,
      errorEvents: -5,
    });
    expect(negative.suppressedBy).toBe("invalid-sample");
    expect(negative.fired).toBe(false);

    const infinite = evaluateErrorRate(CRITICAL_ERROR_RATE, {
      scope: SCOPE,
      totalEvents: Number.POSITIVE_INFINITY,
      errorEvents: 10,
    });
    expect(infinite.suppressedBy).toBe("invalid-sample");
  });
});

describe("evaluateWebVitals — sample floor", () => {
  it("suppresses a p75 computed from too few page views", () => {
    const decision = evaluateWebVitals(LCP_WARNING, {
      scope: SCOPE,
      metric: "LCP",
      sampleCount: MIN_EVENTS_PERCENTILE - 1,
      p75: 9000,
      baselineP75: 2000,
    });

    expect(decision.fired).toBe(false);
    expect(decision.suppressedBy).toBe("not-enough-samples");
  });

  it("evaluates at exactly the minimum sample count", () => {
    const decision = evaluateWebVitals(LCP_WARNING, {
      scope: SCOPE,
      metric: "LCP",
      sampleCount: MIN_EVENTS_PERCENTILE,
      p75: 9000,
      baselineP75: 2000,
    });

    expect(decision.fired).toBe(true);
    expect(decision.breach?.check).toBe("p75-absolute");
  });
});

describe("evaluateWebVitals — absolute budget and relative regression", () => {
  it("does not fire when p75 sits exactly on both the absolute and regression limits", () => {
    // baseline 2000 + 25% = 2500, which is exactly maxP75. Sitting on both
    // limits is within tolerance.
    const decision = evaluateWebVitals(LCP_WARNING, {
      scope: SCOPE,
      metric: "LCP",
      sampleCount: 500,
      p75: 2500,
      baselineP75: 2000,
    });

    expect(decision.fired).toBe(false);
    expect(decision.suppressedBy).toBe("within-threshold");
  });

  it("fires on the absolute budget before considering the baseline", () => {
    const decision = evaluateWebVitals(LCP_WARNING, {
      scope: SCOPE,
      metric: "LCP",
      sampleCount: 500,
      p75: 5000,
      baselineP75: 4500,
    });

    expect(decision.fired).toBe(true);
    expect(decision.breach).toEqual({
      check: "p75-absolute",
      observed: 5000,
      limit: 2500,
      multiple: 2,
      relativeToBaseline: false,
      baseline: null,
    });
  });

  it("fires on relative regression while still inside the absolute budget", () => {
    // 3000ms is 50% over a 2000ms baseline but comfortably under a 4000ms
    // absolute budget, so only the relative check can be responsible.
    const regressionOnly: WebVitalsThreshold = { ...LCP_WARNING, maxP75: 4000 };
    const decision = evaluateWebVitals(regressionOnly, {
      scope: SCOPE,
      metric: "LCP",
      sampleCount: 500,
      p75: 3000,
      baselineP75: 2000,
    });

    expect(decision.fired).toBe(true);
    expect(decision.breach).toEqual({
      check: "p75-regression",
      observed: 3000,
      limit: 2500,
      multiple: 1.5,
      relativeToBaseline: true,
      baseline: 2000,
    });
  });

  it("does not fire on regression when the baseline is missing", () => {
    const decision = evaluateWebVitals(LCP_WARNING, {
      scope: SCOPE,
      metric: "LCP",
      sampleCount: 500,
      p75: 2000,
      baselineP75: null,
    });

    expect(decision.fired).toBe(false);
    expect(decision.suppressedBy).toBe("no-baseline");
  });

  it("skips the relative check entirely when maxRegressionRatio is null", () => {
    const absoluteOnly: WebVitalsThreshold = { ...LCP_WARNING, maxRegressionRatio: null };
    const decision = evaluateWebVitals(absoluteOnly, {
      scope: SCOPE,
      metric: "LCP",
      sampleCount: 500,
      p75: 2000,
      baselineP75: 100,
    });

    expect(decision.fired).toBe(false);
    expect(decision.suppressedBy).toBe("within-threshold");
  });

  it("handles a zero baseline without producing a misleading multiple", () => {
    // A route with no recorded history can report baselineP75 = 0. Any
    // non-zero p75 is then an infinite regression; the limit is 0 and the
    // multiple must be Infinity rather than a division-by-zero NaN.
    const regressionOnly: WebVitalsThreshold = { ...LCP_WARNING, maxP75: 4000 };
    const decision = evaluateWebVitals(regressionOnly, {
      scope: SCOPE,
      metric: "LCP",
      sampleCount: 500,
      p75: 3000,
      baselineP75: 0,
    });

    expect(decision.fired).toBe(true);
    expect(decision.breach?.check).toBe("p75-regression");
    expect(decision.breach?.limit).toBe(0);
    expect(decision.breach?.multiple).toBe(Number.POSITIVE_INFINITY);
    expect(decision.breach?.baseline).toBe(0);
  });
});

describe("evaluateWebVitals — malformed samples", () => {
  it("suppresses NaN, negative and mismatched-baseline samples", () => {
    const nan = evaluateWebVitals(LCP_WARNING, {
      scope: SCOPE,
      metric: "LCP",
      sampleCount: 500,
      p75: Number.NaN,
      baselineP75: 2000,
    });
    expect(nan.suppressedBy).toBe("invalid-sample");

    const negativeP75 = evaluateWebVitals(LCP_WARNING, {
      scope: SCOPE,
      metric: "LCP",
      sampleCount: 500,
      p75: -1,
      baselineP75: 2000,
    });
    expect(negativeP75.suppressedBy).toBe("invalid-sample");

    const negativeBaseline = evaluateWebVitals(LCP_WARNING, {
      scope: SCOPE,
      metric: "LCP",
      sampleCount: 500,
      p75: 2000,
      baselineP75: -10,
    });
    expect(negativeBaseline.suppressedBy).toBe("invalid-sample");

    const negativeCount = evaluateWebVitals(LCP_WARNING, {
      scope: SCOPE,
      metric: "LCP",
      sampleCount: -3,
      p75: 2000,
      baselineP75: 2000,
    });
    expect(negativeCount.suppressedBy).toBe("invalid-sample");
  });
});

describe("evaluateAlerts", () => {
  it("routes each Web Vitals sample only to the rules for its own metric", () => {
    const decisions = evaluateAlerts(ALERT_THRESHOLDS, {
      errorRate: [],
      webVitals: [
        {
          scope: SCOPE,
          metric: "CLS",
          sampleCount: 400,
          p75: 0.4,
          baselineP75: 0.05,
        },
      ],
    });

    // Only the CLS rule is metric-matched; LCP/INP/TTFB rules are not evaluated
    // against a CLS sample, which would otherwise report cross-metric noise.
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.threshold).toMatchObject({ kind: "web-vitals", metric: "CLS" });
    expect(decisions[0]?.fired).toBe(true);
  });

  it("fans one error-rate sample out across every error-rate rule", () => {
    const decisions = evaluateAlerts(ALERT_THRESHOLDS, {
      errorRate: [{ scope: SCOPE, totalEvents: 1000, errorEvents: 60 }],
      webVitals: [],
    });

    const errorRules = decisions.filter((d) => d.threshold.kind === "error-rate");
    expect(errorRules).toHaveLength(2);
    // 6% clears both the 1% warning and the 5% critical ratio.
    expect(firedAlerts(errorRules).map((d) => d.threshold.name)).toEqual([
      "Error rate critical",
      "Error rate warning",
    ]);
  });

  it("fires neither error-rate rule when the window is under both volume floors", () => {
    // 30 errors out of 1000 is a 3% ratio: over the 1% warning line, but under
    // the warning rule's 50-error floor and the critical rule's 5% line. This
    // is the anti-fatigue behaviour at its most visible — a percentage breach
    // that must not become a page.
    const decisions = evaluateAlerts(ALERT_THRESHOLDS, {
      errorRate: [{ scope: SCOPE, totalEvents: 1000, errorEvents: 30 }],
      webVitals: [],
    });

    expect(firedAlerts(decisions)).toEqual([]);
    expect(decisions.map((d) => d.suppressedBy)).toEqual(["within-threshold", "not-enough-events"]);
  });

  it("returns no decisions when no samples are supplied", () => {
    expect(evaluateAlerts(ALERT_THRESHOLDS, {})).toEqual([]);
  });

  it("firedAlerts filters to the breaching decisions only", () => {
    const decisions = evaluateAlerts(ALERT_THRESHOLDS, {
      errorRate: [
        { scope: SCOPE, totalEvents: 1000, errorEvents: 500 },
        { scope: SCOPE, totalEvents: 1000, errorEvents: 0 },
      ],
    });

    const fired = firedAlerts(decisions);
    expect(fired).toHaveLength(2);
    expect(fired.every((d) => d.fired)).toBe(true);
    expect(ALERT_THRESHOLDS).toHaveLength(8);
  });
});

describe("buildAlertPayload", () => {
  it("returns null for a decision that did not fire", () => {
    const decision = evaluateErrorRate(CRITICAL_ERROR_RATE, {
      scope: SCOPE,
      totalEvents: 1000,
      errorEvents: 1,
    });

    expect(buildAlertPayload(decision)).toBeNull();
  });

  it("includes route, magnitude, release and window in a ratio breach", () => {
    const decision = evaluateErrorRate(CRITICAL_ERROR_RATE, {
      scope: SCOPE,
      totalEvents: 1000,
      errorEvents: 74,
    });

    const payload = buildAlertPayload(decision, {
      dashboardBaseUrl: "https://sentry.example.io/org",
    });

    expect(payload).toEqual({
      title: "[CRITICAL] Error rate critical — /",
      severity: "critical",
      status: "firing",
      environment: "production",
      route: "/",
      release: "synapse-web@1.4.0",
      signal: "error-rate / error-ratio",
      magnitude: "error rate 7.4% exceeds 5.0% (1.48x)",
      detail: {
        observed: 0.074,
        limit: 0.05,
        multiple: 1.48,
        windowMinutes: 15,
        relativeToBaseline: false,
      },
      dashboardUrl: "https://sentry.example.io/org/issues/?query=route%3A%22%2F%22",
      runbookUrl: null,
    });
  });

  it("builds a count-breach magnitude line", () => {
    const decision = evaluateErrorRate(CRITICAL_ERROR_RATE, {
      scope: SCOPE,
      totalEvents: 40000,
      errorEvents: 400,
    });

    const payload = buildAlertPayload(decision);
    expect(payload?.magnitude).toBe("error count 400 exceeds 100 (4x)");
    expect(payload?.signal).toBe("error-rate / error-count");
  });

  it("labels an unattributed route instead of emitting a blank field", () => {
    const decision = evaluateErrorRate(CRITICAL_ERROR_RATE, {
      scope: { ...SCOPE, route: null },
      totalEvents: 1000,
      errorEvents: 90,
    });

    const payload = buildAlertPayload(decision, {
      dashboardBaseUrl: "https://sentry.example.io/org",
    });

    expect(payload?.route).toBe("(unattributed)");
    expect(payload?.title).toContain("(unattributed)");
    // With no route there is nothing to filter on, so it links to the bare view.
    expect(payload?.dashboardUrl).toBe("https://sentry.example.io/org/issues/");
  });

  it("builds a Web Vitals regression magnitude line and routes the dashboard link", () => {
    const regressionOnly: WebVitalsThreshold = { ...LCP_WARNING, maxP75: 4000 };
    const decision = evaluateWebVitals(regressionOnly, {
      scope: { ...SCOPE, route: "/transactions" },
      metric: "LCP",
      sampleCount: 500,
      p75: 3000,
      baselineP75: 2000,
    });

    const payload = buildAlertPayload(decision, {
      dashboardBaseUrl: "https://sentry.example.io/org/",
      runbookBaseUrl: "https://docs.example.io",
    });

    expect(payload?.signal).toBe("web-vitals LCP / p75-regression");
    expect(payload?.magnitude).toBe("LCP p75 3000ms regressed from a baseline of 2000ms (1.5x)");
    expect(payload?.route).toBe("/transactions");
    expect(payload?.detail.relativeToBaseline).toBe(true);
    expect(payload?.detail.windowMinutes).toBe(60);
    expect(payload?.dashboardUrl).toBe(
      "https://sentry.example.io/org/web-vitals/?route=%2Ftransactions"
    );
    expect(payload?.runbookUrl).toBe(
      "https://docs.example.io/telemetry-alerting#warning-web-vitals"
    );
  });

  it("formats the CLS unitless threshold without milliseconds", () => {
    const clsRule = ALERT_THRESHOLDS.find(
      (t): t is WebVitalsThreshold => t.kind === "web-vitals" && t.metric === "CLS"
    );
    expect(clsRule).toBeDefined();

    const decision = evaluateWebVitals(clsRule!, {
      scope: SCOPE,
      metric: "CLS",
      sampleCount: 500,
      p75: 0.25,
      baselineP75: 0.05,
    });

    const payload = buildAlertPayload(decision);
    expect(payload?.magnitude).toBe("CLS p75 0.250 exceeds 0.100 (2.5x)");
  });

  it("prefers an explicitly supplied release over the scope release", () => {
    const decision = evaluateErrorRate(CRITICAL_ERROR_RATE, {
      scope: { ...SCOPE, release: null },
      totalEvents: 1000,
      errorEvents: 200,
    });

    expect(buildAlertPayload(decision, { release: "synapse-web@1.5.0" })?.release).toBe(
      "synapse-web@1.5.0"
    );
    expect(buildAlertPayload(decision)?.release).toBe("unknown");
  });

  it("treats an explicitly null release as 'fall back to the scope'", () => {
    const decision = evaluateErrorRate(CRITICAL_ERROR_RATE, {
      scope: SCOPE,
      totalEvents: 1000,
      errorEvents: 200,
    });

    expect(buildAlertPayload(decision, { release: null })?.release).toBe(SCOPE.release);
  });

  it("does not blank the release field when a bad env var yields an empty string", () => {
    const decision = evaluateErrorRate(CRITICAL_ERROR_RATE, {
      scope: SCOPE,
      totalEvents: 1000,
      errorEvents: 200,
    });

    // An empty string is a real (broken) value, so it must not silently win
    // over the scope's release — the field exists so on-call can bisect.
    expect(buildAlertPayload(decision, { release: "" })?.release).toBe("");
    expect(buildAlertPayload(decision)?.release).toBe(SCOPE.release);
  });
});

describe("registry reconciliation with .sentry-alerts.yml", () => {
  // The manifest is the thing a human transcribes into the Sentry UI; the
  // registry is the thing the unit tests exercise. Nothing stops the two from
  // drifting except a test, so read the manifest and compare the thresholds
  // field-for-field.
  //
  // Deliberately parsed with a small purpose-built reader rather than a YAML
  // library: the manifest is a fixed-shape file, and adding a YAML dependency
  // to a PR about alerting would be a poor trade for one reconciliation test.
  const manifest = readFileSync(join(REPO_ROOT, ".sentry-alerts.yml"), "utf8");

  /** Splits the `rules:` block into one flat key/value map per `- name:` entry. */
  function manifestRules(): Array<Record<string, string>> {
    const start = manifest.indexOf("\nrules:\n");
    expect(start).toBeGreaterThan(-1);

    const body = manifest.slice(start).split("\n");
    const rules: Array<Record<string, string>> = [];
    let current: Record<string, string> | null = null;
    let inRules = false;

    for (const line of body) {
      if (!inRules) {
        if (line === "rules:") inRules = true;
        continue;
      }
      // A new top-level key ends the rules block.
      if (/^[a-z_]+:/.test(line)) break;
      // A list item starts a new rule; deeper list items are recorded under
      // their own key so action references can be checked.
      const item = line.match(/^  - name: (.+)$/);
      if (item) {
        current = { name: item[1]!.trim() };
        rules.push(current);
        continue;
      }
      if (!current) continue;
      // Field names may contain digits (`maxP75`), so the character class has
      // to allow them — an `[A-Za-z]+` class silently drops that field and the
      // reconciliation below would compare against `undefined`.
      const field = line.match(/^ {4}([A-Za-z][A-Za-z0-9]*): (.+)$/);
      if (field) current[field[1]!] = field[2]!.trim();
    }

    return rules;
  }

  /** Reads the list item under a scalar key, e.g. `actions:`. */
  function manifestList(rule: Record<string, string>, key: string): string[] {
    const start = manifest.indexOf(`    ${key}: [`, manifest.indexOf(`  - name: ${rule.name}`));
    if (start === -1) return [];
    const open = manifest.indexOf("[", start);
    const close = manifest.indexOf("]", open);
    return manifest
      .slice(open + 1, close)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  it("parses every rule in the manifest", () => {
    const parsed = manifestRules();
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed.every((r) => r.name && r.severity && r.kind && r.windowMinutes)).toBe(true);
  });

  it("lists exactly the same rules, in the same order, as the registry", () => {
    expect(manifestRules().map((r) => r.name)).toEqual([...ALERT_RULE_NAMES]);
  });

  it("keeps every manifest threshold field identical to the registry", () => {
    const byName = new Map(manifestRules().map((r) => [r.name, r]));

    for (const rule of ALERT_THRESHOLDS) {
      const entry = byName.get(rule.name);
      expect(entry, `manifest is missing ${rule.name}`).toBeDefined();

      expect(entry!.severity, rule.name).toBe(rule.severity);
      expect(entry!.kind, rule.name).toBe(rule.kind);
      expect(String(entry!.windowMinutes), rule.name).toBe(String(rule.windowMinutes));

      if (rule.kind === "error-rate") {
        expect(String(entry!.minEvents), rule.name).toBe(String(rule.minEvents));
        expect(String(entry!.maxErrorRatio), rule.name).toBe(String(rule.maxErrorRatio));
        expect(String(entry!.maxErrorCount), rule.name).toBe(String(rule.maxErrorCount));
      } else {
        expect(entry!.metric, rule.name).toBe(rule.metric);
        expect(String(entry!.minSamples), rule.name).toBe(String(rule.minSamples));
        expect(String(entry!.maxP75), rule.name).toBe(String(rule.maxP75));
        expect(String(entry!.maxRegressionRatio), rule.name).toBe(String(rule.maxRegressionRatio));
      }
    }
  });

  it("gives every rule at least one notification action", () => {
    for (const rule of manifestRules()) {
      expect(manifestList(rule, "actions").length, rule.name).toBeGreaterThan(0);
    }
  });

  it("only references action ids that the manifest declares", () => {
    const declared = new Set([...manifest.matchAll(/^ {4}id: (.+)$/gm)].map((m) => m[1]!.trim()));
    expect(declared.size).toBeGreaterThan(0);

    for (const rule of manifestRules()) {
      for (const id of manifestList(rule, "actions")) {
        expect(declared.has(id), `${rule.name} -> ${id}`).toBe(true);
      }
    }
  });

  it("pins the documented anti-fatigue defaults", () => {
    // These are the controls that keep the rules from paging on normal
    // variance; a silent edit here would reintroduce alert fatigue.
    expect(manifest).toContain("insufficient_data_resolution: inconclusive");
    expect(manifest).toContain("consecutive_breaches: 2");
    expect(manifest).toContain("no_data_period: 24h");
  });
});

describe("ALERT_THRESHOLDS registry", () => {
  it("exposes a unique name per rule so Sentry rules can be reconciled by name", () => {
    expect(new Set(ALERT_RULE_NAMES).size).toBe(ALERT_RULE_NAMES.length);
  });

  it("keeps every volume floor at or above the documented minimum", () => {
    for (const rule of ALERT_THRESHOLDS) {
      const floor = rule.kind === "error-rate" ? rule.minEvents : rule.minSamples;
      expect(floor).toBeGreaterThanOrEqual(rule.kind === "web-vitals" ? MIN_EVENTS_PERCENTILE : 20);
    }
  });

  it("uses a strictly shorter window for critical rules than for warning rules", () => {
    const byName = new Map(ALERT_THRESHOLDS.map((r) => [r.name, r]));
    for (const metric of ["LCP", "INP"] as const) {
      const critical = byName.get(`${metric} p75 critical`)!;
      const warning = byName.get(`${metric} p75 warning`)!;
      expect(critical.windowMinutes).toBeLessThan(warning.windowMinutes);
    }
  });

  it("keeps every warning threshold looser than its matching critical threshold", () => {
    const byName = new Map(ALERT_THRESHOLDS.map((r) => [r.name, r]));
    const errorCritical = byName.get("Error rate critical") as ErrorRateThreshold;
    const errorWarning = byName.get("Error rate warning") as ErrorRateThreshold;

    expect(errorWarning.maxErrorRatio).toBeLessThan(errorCritical.maxErrorRatio);
    expect(errorWarning.windowMinutes).toBeGreaterThan(errorCritical.windowMinutes);
    expect(errorWarning.minEvents).toBeGreaterThan(errorCritical.minEvents);

    for (const metric of ["LCP", "INP"] as const) {
      const critical = byName.get(`${metric} p75 critical`) as WebVitalsThreshold;
      const warning = byName.get(`${metric} p75 warning`) as WebVitalsThreshold;
      expect(warning.maxP75).toBeLessThan(critical.maxP75);
    }
  });
});
