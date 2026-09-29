/**
 * Telemetry alert rules — declarative thresholds plus the pure evaluation logic
 * used to decide whether a telemetry window should raise an alert.
 *
 * Scope note
 * ----------
 * The alerting *transport* lives in the telemetry provider's dashboard (Sentry),
 * which this repository cannot configure. What lives here is the part that can
 * be reviewed, version-controlled and unit-tested: the thresholds themselves,
 * their rationale, and a deterministic reference implementation of "does this
 * window breach a threshold?".
 *
 * Keeping the evaluation here means the numbers in `.sentry-alerts.yml` and the
 * numbers Sentry actually fires on cannot silently drift apart, and it gives us
 * a way to unit-test the anti-alert-fatigue behaviour (minimum-volume gates,
 * regression floors) that is otherwise untestable dashboard configuration.
 *
 * See `./README.md` for the threshold rationale and the manual Sentry setup steps.
 */

export type AlertSeverity = "warning" | "critical";

export type AlertKind = "error-rate" | "web-vitals";

/**
 * Web Vitals metrics tracked for alerting. Only metrics that degrade
 * measurably on real user traffic are worth alerting on; the registry below
 * carries the Google-recommended "good" thresholds as the alert boundary.
 */
export type WebVitalsMetric = "LCP" | "INP" | "CLS" | "FCP" | "TTFB";

/** Identifies which Sentry project / route a window of samples came from. */
export interface AlertScope {
  /** Deployment environment, e.g. "production". */
  readonly environment: string;
  /**
   * Best-effort route identifier. May be `null` when the provider could not
   * attribute the sample to a route (unhandled rejection, request without a
   * transaction, etc.) — alerts must still be evaluable in that case.
   */
  readonly route: string | null;
  /** Release/build identifier, so alerts can be tied to a specific deploy. */
  readonly release: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Thresholds
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A volume floor is the primary anti-alert-fatigue control.
 *
 * A percentage threshold alone will page on a single unlucky event during a
 * quiet period: 1 error out of 1 request is a 100% error rate and means
 * nothing. Every rule below therefore requires a minimum absolute event count
 * before the ratio is even considered.
 */
export const MIN_EVENTS_PERCENTILE = 100;

export interface ErrorRateThreshold {
  readonly kind: "error-rate";
  readonly severity: AlertSeverity;
  /** Human-readable name, mirrors the Sentry metric-alert name. */
  readonly name: string;
  /**
   * Inclusive lower bound on the rolling window, in minutes. Windows are
   * deliberately unequal between severities: a critical rule reacts fast on a
   * short window, a warning rule needs a longer window to avoid firing on
   * short-lived noise.
   */
  readonly windowMinutes: number;
  /**
   * Minimum number of error *events* in the window before the ratio is
   * evaluated. Below this, the rule is suppressed.
   */
  readonly minEvents: number;
  /**
   * Error events divided by total events, as a fraction in [0, 1].
   * The rule fires when the observed ratio is strictly greater than this.
   */
  readonly maxErrorRatio: number;
  /** Absolute error-count ceiling, evaluated alongside the ratio. */
  readonly maxErrorCount: number;
}

export interface WebVitalsThreshold {
  readonly kind: "web-vitals";
  readonly severity: AlertSeverity;
  readonly name: string;
  /** The metric being watched. */
  readonly metric: WebVitalsMetric;
  /** Rolling window in minutes. */
  readonly windowMinutes: number;
  /**
   * Minimum number of *page views* in the window before percentile evaluation.
   * A p75 off three page views is not a signal.
   */
  readonly minSamples: number;
  /**
   * Absolute p75 budget in milliseconds (CLS is unitless). The rule fires when
   * the observed p75 is strictly greater than this.
   */
  readonly maxP75: number;
  /**
   * Optional relative-regression rule, expressed as a fraction in [0, 1].
   * Fires when `p75 > baselineP75 * (1 + maxRegressionRatio)`.
   *
   * A `null` baseline disables the relative check for this window, so a fresh
   * release with no historical data degrades to the absolute check only rather
   * than alerting spuriously.
   */
  readonly maxRegressionRatio: number | null;
}

/** A rule is evaluated against one stream: either error rate or Web Vitals. */
export type AlertThreshold = ErrorRateThreshold | WebVitalsThreshold;

// ─────────────────────────────────────────────────────────────────────────────
// Evaluation inputs
// ─────────────────────────────────────────────────────────────────────────────

export interface ErrorRateSample {
  readonly scope: AlertScope;
  /** Total events (requests / page views) observed in the window. */
  readonly totalEvents: number;
  /** Error events observed in the window. Must be <= `totalEvents`. */
  readonly errorEvents: number;
}

export interface WebVitalsSample {
  readonly scope: AlertScope;
  readonly metric: WebVitalsMetric;
  /** Number of page views contributing to the percentile. */
  readonly sampleCount: number;
  /** Observed 75th percentile. Milliseconds for every metric except `CLS`. */
  readonly p75: number;
  /**
   * Historical p75 for the same route/metric, used by the relative-regression
   * check. `null` when no baseline exists yet.
   */
  readonly baselineP75: number | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Decisions
// ─────────────────────────────────────────────────────────────────────────────

/** Why a rule did not fire. Surfaced so suppressions can be debugged. */
export type SuppressionReason =
  | "not-enough-events"
  | "not-enough-samples"
  | "within-threshold"
  | "no-baseline"
  | "invalid-sample";

export interface AlertDecision {
  readonly threshold: AlertThreshold;
  readonly scope: AlertScope;
  readonly severity: AlertSeverity;
  /** `true` when the rule breached. */
  readonly fired: boolean;
  /**
   * `null` when the rule did not fire. When it did, this carries the measured
   * value, the limit, and which check tripped — the raw material for the
   * alert payload.
   */
  readonly breach: AlertBreach | null;
  /** Populated only when `fired === false` and a specific check suppressed it. */
  readonly suppressedBy: SuppressionReason | null;
}

export interface AlertBreach {
  /** The check that tripped. */
  readonly check: "error-ratio" | "error-count" | "p75-absolute" | "p75-regression";
  /** Measured value for the tripping check. */
  readonly observed: number;
  /** The configured limit that was crossed. */
  readonly limit: number;
  /** Observed / limit, rounded to 3dp. Makes "how bad" readable at a glance. */
  readonly multiple: number;
  /** `true` when the check is relative to a historical baseline. */
  readonly relativeToBaseline: boolean;
  /**
   * The historical p75 the relative check compared against. Carried explicitly
   * rather than reconstructed from `observed` and the ratio, so the payload can
   * quote the real baseline instead of an approximation of it.
   */
  readonly baseline: number | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Measurement window sanity
// ─────────────────────────────────────────────────────────────────────────────

function isFiniteNumber(value: number): boolean {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * A sample is only usable when its counts are finite, non-negative integers and
 * the error count does not exceed the total. Anything else means the provider
 * returned something we do not understand, and we must not convert that into
 * either a page or a silence — the safe answer is to suppress and let the
 * ingestion pipeline be debugged separately.
 */
function errorSampleIsUsable(sample: ErrorRateSample): boolean {
  if (!isFiniteNumber(sample.totalEvents) || !isFiniteNumber(sample.errorEvents)) return false;
  if (sample.totalEvents < 0 || sample.errorEvents < 0) return false;
  if (sample.errorEvents > sample.totalEvents) return false;
  return true;
}

function webVitalsSampleIsUsable(sample: WebVitalsSample): boolean {
  if (!isFiniteNumber(sample.sampleCount) || sample.sampleCount < 0) return false;
  if (!isFiniteNumber(sample.p75)) return false;
  // p75 is a magnitude; negative or NaN is never a real measurement.
  if (sample.p75 < 0) return false;
  if (
    sample.baselineP75 !== null &&
    (!isFiniteNumber(sample.baselineP75) || sample.baselineP75 < 0)
  ) {
    return false;
  }
  return true;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rule evaluation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Evaluates one error-rate rule against one window.
 *
 * Ordering matters: the volume floor is checked before the ratio so that a
 * 1-error-in-1-request window is reported as suppressed rather than as a 100%
 * error-rate page.
 */
export function evaluateErrorRate(
  threshold: ErrorRateThreshold,
  sample: ErrorRateSample
): AlertDecision {
  const base = {
    threshold,
    scope: sample.scope,
    severity: threshold.severity,
  } as const;

  if (!errorSampleIsUsable(sample)) {
    return { ...base, fired: false, breach: null, suppressedBy: "invalid-sample" };
  }

  if (sample.errorEvents < threshold.minEvents) {
    return { ...base, fired: false, breach: null, suppressedBy: "not-enough-events" };
  }

  const ratio = sample.totalEvents === 0 ? 0 : sample.errorEvents / sample.totalEvents;

  // Strictly greater: a ratio sitting exactly on the limit is within tolerance.
  if (ratio > threshold.maxErrorRatio) {
    return {
      ...base,
      fired: true,
      suppressedBy: null,
      breach: {
        check: "error-ratio",
        observed: round(ratio),
        limit: threshold.maxErrorRatio,
        multiple:
          threshold.maxErrorRatio === 0
            ? Number.POSITIVE_INFINITY
            : round(ratio / threshold.maxErrorRatio),
        relativeToBaseline: false,
        baseline: null,
      },
    };
  }

  if (sample.errorEvents > threshold.maxErrorCount) {
    return {
      ...base,
      fired: true,
      suppressedBy: null,
      breach: {
        check: "error-count",
        observed: sample.errorEvents,
        limit: threshold.maxErrorCount,
        multiple: round(sample.errorEvents / threshold.maxErrorCount),
        relativeToBaseline: false,
        baseline: null,
      },
    };
  }

  return { ...base, fired: false, breach: null, suppressedBy: "within-threshold" };
}

/**
 * Evaluates one Web Vitals rule against one window.
 *
 * Two independent checks: an absolute p75 budget (catches a release that is
 * slow on its own merits) and an optional relative regression against the
 * route's own history (catches a release that is slower than *this* app has
 * ever been, even while still under the absolute budget). Either one firing is
 * enough to raise an alert.
 */
export function evaluateWebVitals(
  threshold: WebVitalsThreshold,
  sample: WebVitalsSample
): AlertDecision {
  const base = {
    threshold,
    scope: sample.scope,
    severity: threshold.severity,
  } as const;

  if (!webVitalsSampleIsUsable(sample)) {
    return { ...base, fired: false, breach: null, suppressedBy: "invalid-sample" };
  }

  if (sample.sampleCount < threshold.minSamples) {
    return { ...base, fired: false, breach: null, suppressedBy: "not-enough-samples" };
  }

  if (sample.p75 > threshold.maxP75) {
    return {
      ...base,
      fired: true,
      suppressedBy: null,
      breach: {
        check: "p75-absolute",
        observed: sample.p75,
        limit: threshold.maxP75,
        multiple:
          threshold.maxP75 === 0 ? Number.POSITIVE_INFINITY : round(sample.p75 / threshold.maxP75),
        relativeToBaseline: false,
        baseline: null,
      },
    };
  }

  if (threshold.maxRegressionRatio !== null) {
    if (sample.baselineP75 === null) {
      // No history yet: the absolute budget above already ran, so the window
      // is within tolerance and the only thing missing is the relative check.
      return { ...base, fired: false, breach: null, suppressedBy: "no-baseline" };
    }
    const limit = round(sample.baselineP75 * (1 + threshold.maxRegressionRatio));
    if (sample.p75 > limit) {
      return {
        ...base,
        fired: true,
        suppressedBy: null,
        breach: {
          check: "p75-regression",
          observed: sample.p75,
          limit,
          multiple:
            sample.baselineP75 === 0
              ? Number.POSITIVE_INFINITY
              : round(sample.p75 / sample.baselineP75),
          relativeToBaseline: true,
          baseline: sample.baselineP75,
        },
      };
    }
  }

  return { ...base, fired: false, breach: null, suppressedBy: "within-threshold" };
}

/** Evaluates a whole threshold registry against a batch of samples. */
export function evaluateAlerts(
  thresholds: readonly AlertThreshold[],
  samples: {
    readonly errorRate?: readonly ErrorRateSample[];
    readonly webVitals?: readonly WebVitalsSample[];
  }
): AlertDecision[] {
  const decisions: AlertDecision[] = [];

  for (const sample of samples.errorRate ?? []) {
    for (const threshold of thresholds) {
      if (threshold.kind === "error-rate") {
        decisions.push(evaluateErrorRate(threshold, sample));
      }
    }
  }

  for (const sample of samples.webVitals ?? []) {
    for (const threshold of thresholds) {
      if (threshold.kind === "web-vitals" && threshold.metric === sample.metric) {
        decisions.push(evaluateWebVitals(threshold, sample));
      }
    }
  }

  return decisions;
}

/** Only the decisions that actually breached. */
export function firedAlerts(decisions: readonly AlertDecision[]): AlertDecision[] {
  return decisions.filter((d) => d.fired);
}

// ─────────────────────────────────────────────────────────────────────────────
// Alert payloads
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A provider-agnostic notification payload. The same object serialises to a
 * Sentry webhook action, a Slack Block Kit message, or a bare email body, so
 * changing the notification channel does not change the rule configuration.
 *
 * Field naming mirrors Sentry's webhook `action` payload so it can be posted
 * to a Sentry "Alert rule → Action → Webhook" endpoint with no transformation.
 */
export interface AlertPayload {
  readonly title: string;
  readonly severity: AlertSeverity;
  readonly status: "firing" | "resolved";
  readonly environment: string;
  readonly route: string;
  readonly release: string;
  /** Which stream tripped, and which specific check within it. */
  readonly signal: string;
  /** One-line magnitude summary, e.g. "error rate 7.4% exceeds 5.0% (1.48x)". */
  readonly magnitude: string;
  /** Observed / limit / multiple, machine-readable. */
  readonly detail: {
    readonly observed: number;
    readonly limit: number;
    readonly multiple: number;
    readonly windowMinutes: number;
    readonly relativeToBaseline: boolean;
  };
  /** Deep link into the provider dashboard scoped to the affected route. */
  readonly dashboardUrl: string | null;
  /** Documentation link for the rule, so an on-call engineer can act fast. */
  readonly runbookUrl: string | null;
}

export interface BuildPayloadOptions {
  /** Base URL of the telemetry dashboard, used to build `dashboardUrl`. */
  readonly dashboardBaseUrl?: string;
  /** Documentation site root, used to build `runbookUrl`. */
  readonly runbookBaseUrl?: string;
  /** Release the alert is being evaluated for; echoed into the payload. */
  readonly release?: string | null;
}

function formatRatio(value: number): string {
  return `${round(value * 100).toFixed(1)}%`;
}

function formatMs(value: number, metric: WebVitalsMetric): string {
  return metric === "CLS" ? round(value).toFixed(3) : `${Math.round(value)}ms`;
}

function dashboardUrlFor(
  base: string | undefined,
  threshold: AlertThreshold,
  scope: AlertScope
): string | null {
  if (!base) return null;
  const trimmed = base.replace(/\/+$/, "");
  // Sentry scopes its issues view by project; a single-project app just needs
  // the route filter appended when the provider gave us one.
  if (threshold.kind === "error-rate") {
    return scope.route
      ? `${trimmed}/issues/?query=${encodeURIComponent(`route:"${scope.route}"`)}`
      : `${trimmed}/issues/`;
  }
  return scope.route
    ? `${trimmed}/web-vitals/?route=${encodeURIComponent(scope.route)}`
    : `${trimmed}/web-vitals/`;
}

/**
 * Builds the notification payload for a firing decision.
 *
 * Returns `null` for a decision that did not fire, so callers can map over
 * decisions and filter in one pass.
 */
export function buildAlertPayload(
  decision: AlertDecision,
  options: BuildPayloadOptions = {}
): AlertPayload | null {
  if (!decision.fired || decision.breach === null) return null;
  const { threshold, scope, breach } = decision;
  const route = scope.route ?? "(unattributed)";
  // An explicitly supplied release wins, then the scope's, then a placeholder.
  // All three are `??` rather than a truthiness check so an empty string from a
  // bad CI env var cannot blank out the field an on-call engineer needs.
  const release = options.release ?? scope.release ?? "unknown";

  const signal =
    threshold.kind === "error-rate"
      ? `error-rate / ${breach.check}`
      : `web-vitals ${threshold.metric} / ${breach.check}`;

  const magnitude =
    threshold.kind === "error-rate" && breach.check === "error-ratio"
      ? `error rate ${formatRatio(breach.observed)} exceeds ${formatRatio(breach.limit)} (${breach.multiple}x)`
      : threshold.kind === "error-rate"
        ? `error count ${breach.observed} exceeds ${breach.limit} (${breach.multiple}x)`
        : breach.check === "p75-regression"
          ? `${threshold.metric} p75 ${formatMs(breach.observed, threshold.metric)} regressed from a baseline of ${formatMs(breach.baseline ?? 0, threshold.metric)} (${breach.multiple}x)`
          : `${threshold.metric} p75 ${formatMs(breach.observed, threshold.metric)} exceeds ${formatMs(breach.limit, threshold.metric)} (${breach.multiple}x)`;

  return {
    title: `[${decision.severity.toUpperCase()}] ${threshold.name} — ${route}`,
    severity: decision.severity,
    status: "firing",
    environment: scope.environment,
    route,
    release,
    signal,
    magnitude,
    detail: {
      observed: breach.observed,
      limit: breach.limit,
      multiple: breach.multiple,
      windowMinutes: threshold.windowMinutes,
      relativeToBaseline: breach.relativeToBaseline,
    },
    dashboardUrl: dashboardUrlFor(options.dashboardBaseUrl, threshold, scope),
    runbookUrl: options.runbookBaseUrl
      ? `${options.runbookBaseUrl.replace(/\/+$/, "")}/telemetry-alerting#${threshold.severity}-${threshold.kind}`
      : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Registry
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The rules that must be created in the Sentry UI. `.sentry-alerts.yml` is the
 * human-readable copy of this list; the two must stay in sync, and
 * `alertRules.test.ts` asserts the names/count so a divergence is a test failure
 * rather than a silent config drift.
 *
 * Rationale for every number is in `./README.md`.
 */
export const ALERT_THRESHOLDS: readonly AlertThreshold[] = [
  {
    kind: "error-rate",
    severity: "critical",
    name: "Error rate critical",
    windowMinutes: 15,
    minEvents: 20,
    maxErrorRatio: 0.05,
    maxErrorCount: 100,
  },
  {
    kind: "error-rate",
    severity: "warning",
    name: "Error rate warning",
    windowMinutes: 60,
    minEvents: 50,
    maxErrorRatio: 0.01,
    maxErrorCount: 250,
  },
  {
    kind: "web-vitals",
    severity: "critical",
    name: "LCP p75 critical",
    metric: "LCP",
    windowMinutes: 30,
    minSamples: MIN_EVENTS_PERCENTILE,
    maxP75: 4000,
    maxRegressionRatio: 0.5,
  },
  {
    kind: "web-vitals",
    severity: "warning",
    name: "LCP p75 warning",
    metric: "LCP",
    windowMinutes: 60,
    minSamples: MIN_EVENTS_PERCENTILE,
    maxP75: 2500,
    maxRegressionRatio: 0.25,
  },
  {
    kind: "web-vitals",
    severity: "critical",
    name: "INP p75 critical",
    metric: "INP",
    windowMinutes: 30,
    minSamples: MIN_EVENTS_PERCENTILE,
    maxP75: 500,
    maxRegressionRatio: 0.5,
  },
  {
    kind: "web-vitals",
    severity: "warning",
    name: "INP p75 warning",
    metric: "INP",
    windowMinutes: 60,
    minSamples: MIN_EVENTS_PERCENTILE,
    maxP75: 200,
    maxRegressionRatio: 0.25,
  },
  {
    kind: "web-vitals",
    severity: "warning",
    name: "CLS p75 warning",
    metric: "CLS",
    windowMinutes: 60,
    minSamples: MIN_EVENTS_PERCENTILE,
    maxP75: 0.1,
    maxRegressionRatio: 0.25,
  },
  {
    kind: "web-vitals",
    severity: "critical",
    name: "TTFB p75 critical",
    metric: "TTFB",
    windowMinutes: 30,
    minSamples: MIN_EVENTS_PERCENTILE,
    maxP75: 1800,
    maxRegressionRatio: 0.5,
  },
] as const;

/** Every rule name, for reconciliation against the provider configuration. */
export const ALERT_RULE_NAMES: readonly string[] = ALERT_THRESHOLDS.map((t) => t.name);
