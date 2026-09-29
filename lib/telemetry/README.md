# Telemetry alerting

Alert **thresholds**, their **rationale**, and a **reference implementation** of
the evaluation that decides whether a telemetry window should raise an alert.

## What is in the repo, and what is not

| Piece                                                           | Where           | Status                                        |
| --------------------------------------------------------------- | --------------- | --------------------------------------------- |
| Thresholds + rationale                                          | this file       | **in repo**                                   |
| Deterministic threshold-evaluation logic                        | `alertRules.ts` | **in repo**, unit-tested                      |
| Notification payload shape (route / metric / magnitude / links) | `AlertPayload`  | **in repo**                                   |
| The alert rules as configured in Sentry                         | Sentry UI       | **not in repo** — requires an org with Sentry |
| A firing alert on a real channel                                | Sentry / Slack  | **not in repo** — requires a staging deploy   |

The rule _configuration_ lives in the telemetry provider because that is the only
place that can actually page someone. This directory exists so that:

1. the numbers are reviewable in a pull request rather than living in a
   dashboard nobody reads;
2. the anti-fatigue behaviour (volume floors, regression guards) is unit-tested
   instead of being un-inspectable UI state;
3. a cold-started maintainer can rebuild the whole setup from this file.

The manifest of rules to create is [`.sentry-alerts.yml`](../../.sentry-alerts.yml)
at the repo root.

## Why not build an alerting engine

The issue explicitly puts "building a custom alerting engine" out of scope, and
that is the right call. Re-implementing windowing, aggregation, scheduling and
notification fan-out on top of a static Next.js app with no backend would be a
large permanent maintenance surface for a problem Sentry already solves. The
module here is deliberately **not** an engine: it has no timers, no state, no I/O.
It is a pure function from `(threshold, sample) -> decision`, which is what makes
it testable and is also what the provider replicates when the rule is created in
its UI.

## Thresholds and rationale

The two controls that keep these rules from producing alert fatigue:

- **Volume floors.** A percentage threshold alone pages on a single unlucky
  event during a quiet period: 1 error out of 1 request is a 100% error rate and
  means nothing. Every rule requires a minimum absolute count (20–50 error
  events, 100 page views) _before_ the ratio or percentile is even considered.
  Ordering matters and is tested: the floor is checked first, so a low-volume
  window is reported as suppressed, not as a page.
- **Asymmetric windows and severities.** A critical rule uses a short window
  (15–30m) so a bad deploy is caught quickly; the matching warning rule uses a
  4× longer window and a higher volume floor, so it only fires on _sustained_
  degradation. A transient burst trips critical, which is the ordering you want.

| Rule                  | Window | Volume floor  | Condition                         | Why                                                                                                                                                        |
| --------------------- | ------ | ------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Error rate critical` | 15m    | 20 errors     | ratio > 5%, or > 100 errors       | 5% is the conventional "visibly broken" line. The absolute ceiling catches a real incident during a low-traffic period where the ratio alone looks benign. |
| `Error rate warning`  | 60m    | 50 errors     | ratio > 1%, or > 250 errors       | 1% is the "degraded" line. Longer window + higher floor means it only fires on sustained problems.                                                         |
| `LCP p75 critical`    | 30m    | 100 pageviews | p75 > 4000ms, or > baseline + 50% | 4000ms is the Core Web Vitals "poor" boundary.                                                                                                             |
| `LCP p75 warning`     | 60m    | 100 pageviews | p75 > 2500ms, or > baseline + 25% | 2500ms is the "needs improvement" boundary; tighter band catches slow erosion.                                                                             |
| `INP p75 critical`    | 30m    | 100 pageviews | p75 > 500ms, or > baseline + 50%  | 500ms is the "poor" boundary.                                                                                                                              |
| `INP p75 warning`     | 60m    | 100 pageviews | p75 > 200ms, or > baseline + 25%  | 200ms is the "needs improvement" boundary.                                                                                                                 |
| `CLS p75 warning`     | 60m    | 100 pageviews | p75 > 0.1, or > baseline + 25%    | 0.1 is the "good" boundary. Warning-only: CLS has no "poor" line worth paging on.                                                                          |
| `TTFB p75 critical`   | 30m    | 100 pageviews | p75 > 1800ms, or > baseline + 50% | 1800ms is the "poor" boundary. Here a spike usually means an upstream Soroban RPC problem, not our code.                                                   |

### Two checks per Web Vitals rule, on purpose

A Web Vitals rule fires on **either** an absolute budget or a relative regression
against the same route's own history. Absolute-only misses a release that is
20% slower than normal while still comfortably under budget — which is exactly
the regression class people care about. Relative-only would page on a route that
was always slow.

When a route has no history yet (first release, brand-new path), the relative
check reports `no-baseline` and is skipped rather than treated as breached. A
missing baseline is an absence of information, not a signal.

### Boundary semantics

Thresholds are **strict**: a value sitting exactly on the limit is within
tolerance and does not fire. `50/1000` errors is 5.0% and the critical rule stays
quiet. This is tested directly, because the alternative (inclusive) makes a
steady-state ratio sitting on the limit flap between states on every scrape.

### Malformed data suppresses rather than alerts

If a sample arrives with a non-finite count, a negative count, an error count
exceeding its total, or a NaN p75, the rule reports `invalid-sample` and does not
fire. Converting garbage into either a page or a silence hides the fact that the
ingestion pipeline is broken; suppressing with an explicit reason keeps it
debuggable. Both outcomes get the same treatment, and the reason is surfaced in
`AlertDecision.suppressedBy` so it can be logged.

## Payload

`buildAlertPayload()` produces a provider-agnostic object that serialises to a
Sentry webhook `action` payload with no transformation. It carries the three
things the acceptance criteria call for — **affected route**, **error type or
metric**, and **magnitude** — plus the context needed to act without leaving
Slack:

```jsonc
{
  "title": "[CRITICAL] LCP p75 critical — /transactions",
  "severity": "critical",
  "status": "firing",
  "environment": "production",
  "route": "/transactions",
  "release": "synapse-web@1.4.0",
  "signal": "web-vitals LCP / p75-regression",
  "magnitude": "LCP p75 3000ms regressed from a baseline of 2000ms (1.5x)",
  "detail": {
    "observed": 3000,
    "limit": 2500,
    "multiple": 1.5,
    "windowMinutes": 60,
    "relativeToBaseline": true,
  },
  "dashboardUrl": "https://sentry.example.io/org/web-vitals/?route=%2Ftransactions",
  "runbookUrl": "https://docs.example.io/telemetry-alerting#critical-web-vitals",
}
```

`detail.multiple` exists so a channel can sort by severity of breach rather than
by arrival order. `route` is `"(unattributed)"` rather than an empty string when
the provider could not scope a sample, because an unhandled rejection must still
produce a readable title.

## Setting the rules up in Sentry

Not automatable from this repo — Sentry has no supported import path for alert
rules. Steps:

1. **Create the project-scoped rules.** Sentry → org → _Alerts_ → _Create Alert
   Rule_ → _Metric Alert_. Create one rule per entry in `rules[]` in
   `.sentry-alerts.yml`; the file carries the field-by-field mapping to the
   builder UI.
2. **Set the window** from `windowMinutes`.
3. **Set the volume floor.** In the builder this is the "Insufficient Data"
   behaviour — set it to resolve as _inconclusive_ rather than fire. This is what
   implements the volume floor.
4. **Add the two conditions** from `maxErrorRatio`/`maxErrorCount` (error rules)
   or `maxP75`/`maxRegressionRatio` (Web Vitals rules) combined with **OR**.
5. **Attach the actions** from the `actions` list on each rule, with the webhook
   pointed at the relay that renders `AlertPayload`.
6. **Set the shared defaults** from the `defaults:` block — two consecutive
   breaches before firing, and a 24h no-data period so a dead pipeline cannot
   leave a rule permanently firing in a channel.
7. **Reconcile by name.** `ALERT_RULE_NAMES` in `alertRules.ts` lists the
   expected names; a test asserts the registry matches, so drift in either
   direction fails CI.

## Verifying the rules actually fire

Requires a staging deploy — cannot be done from a contributor branch.

- Create the rules in a `staging` environment with shortened windows (5m / 15m)
  so a spike can be observed without waiting an hour.
- Trigger: load the app and force an unhandled error, reload five times inside
  the shortened window. Expect **exactly one** `Error rate critical` and nothing
  from the warning tier — if the warning tier also fires, the volume floors are
  not wired up correctly.
- Then confirm the same 5-error window stays quiet in production's config, which
  is the anti-fatigue assertion.

## Tests

`alertRules.test.ts` covers the volume floors, the strictly-greater boundary
semantics, the absolute-vs-relative Web Vitals split, zero and missing baselines,
malformed samples, payload construction for each breach type, and the registry
invariants (unique names, critical strictly tighter than warning).

```bash
npm run test -- lib/telemetry/alertRules.test.ts
```

## Related issues

- Depends on the error-telemetry (Sentry SDK) and Core Web Vitals issues from the
  same wave — those own event emission; this owns the response.
- Issue #163 (Lighthouse CI) covers performance regressions caught pre-merge.
  These rules cover production reality. The Web Vitals thresholds above are
  intentionally aligned with Lighthouse's budgets so the two do not disagree.
