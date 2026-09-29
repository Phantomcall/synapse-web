# feat(telemetry): version-controlled alert rules with unit-tested threshold evaluation (#162)

## The problem

This issue asks for an alerting pipeline so regressions do not sit unnoticed in a dashboard nobody is actively watching. The hard part is not "page someone" — Sentry does that — it is **picking thresholds that do not page on normal traffic variance**, and making that choice reviewable.

There is a specific failure mode that almost always sinks these issues. Somebody writes a sensible-looking threshold like "error rate > 1%", ships it, and three weeks later the on-call rotation starts ignoring the channel because it fires nightly. That rule was never wrong arithmetically; it was wrong because 1% of 20 requests is one request. The reason nobody catches this is that alert configuration lives in dashboard UI, where it is invisible to code review and impossible to unit test.

So the contribution that actually moves this forward is not more YAML — it is making the threshold decision a **reviewable, testable artefact** and being explicit about the part that genuinely needs a Sentry org.

## What I built

Three files, no new dependencies, no changes to any existing file.

| File                               | Purpose                                                                                      |
| ---------------------------------- | -------------------------------------------------------------------------------------------- |
| `lib/telemetry/alertRules.ts`      | The thresholds, the evaluation logic, the notification payload, and the rule registry.       |
| `lib/telemetry/alertRules.test.ts` | Unit tests for the evaluation, plus a reconciliation test that fails if the manifest drifts. |
| `lib/telemetry/README.md`          | Threshold rationale and the manual Sentry setup steps.                                       |
| `.sentry-alerts.yml`               | The manifest of rules to create, with per-rule field mapping and the payload contract.       |

### The evaluation module is the deliverable

`alertRules.ts` is a **pure function from `(threshold, sample) -> decision`**. No timers, no state, no I/O, no network. That is deliberate — it is not an alerting engine (explicitly out of scope), it is the specification of what Sentry's rules should do, written in a language a test can exercise.

```ts
evaluateErrorRate(threshold, sample) -> AlertDecision
evaluateWebVitals(threshold, sample) -> AlertDecision
buildAlertPayload(decision, options) -> AlertPayload | null
```

The parts I think matter most:

**The volume floor is checked before the ratio.** Every rule carries a minimum absolute count (20–50 error events, 100 page views). The ordering is the whole point: 1 error out of 1 request is a 100% error rate, and if you check the ratio first you page on it. There is a test named for exactly this case.

**Malformed data suppresses, and says why.** A non-finite count, a negative count, an error count exceeding its total, a NaN p75 — all produce `suppressedBy: "invalid-sample"` and no alert. Silently coercing garbage into a page _or_ into a silence both hide the fact that the ingestion pipeline is broken; suppressing with an explicit reason keeps it debuggable. The reason is on the `AlertDecision` so it can be logged.

**Two independent checks per Web Vitals rule.** Absolute budget (p75 over the Core Web Vitals threshold) _or_ relative regression against the same route's own history. Absolute-only misses a release that is 20% slower than normal while still comfortably under budget — which is the regression class people actually care about. Relative-only would page on a route that was always slow. A missing baseline reports `no-baseline` and is skipped: absence of information is not a signal.

**Thresholds are strictly greater-than.** A value sitting exactly on the limit is within tolerance. This is tested directly (`50/1000` errors stays quiet at a 5% rule) because the inclusive alternative makes a steady-state ratio sitting on the limit flap on every scrape.

### The manifest is reconciled against the registry by a test

`.sentry-alerts.yml` and `ALERT_THRESHOLDS` state the same eight rules in two places, which is normally a drift bug waiting to happen. `alertRules.test.ts` reads the manifest and compares every threshold field against the registry — names, order, severity, window, volume floor, and each threshold value — so editing a threshold in one file and not the other fails CI rather than failing silently in production.

I parsed the manifest with a small purpose-built reader rather than adding a YAML library. The manifest is a fixed-shape file, and adding a dependency to a PR about alerting to service one reconciliation test is a bad trade.

## Threshold rationale

| Rule                  | Window | Volume floor  | Condition                         |
| --------------------- | ------ | ------------- | --------------------------------- |
| `Error rate critical` | 15m    | 20 errors     | ratio > 5%, or > 100 errors       |
| `Error rate warning`  | 60m    | 50 errors     | ratio > 1%, or > 250 errors       |
| `LCP p75 critical`    | 30m    | 100 pageviews | p75 > 4000ms, or > baseline + 50% |
| `LCP p75 warning`     | 60m    | 100 pageviews | p75 > 2500ms, or > baseline + 25% |
| `INP p75 critical`    | 30m    | 100 pageviews | p75 > 500ms, or > baseline + 50%  |
| `INP p75 warning`     | 60m    | 100 pageviews | p75 > 200ms, or > baseline + 25%  |
| `CLS p75 warning`     | 60m    | 100 pageviews | p75 > 0.1, or > baseline + 25%    |
| `TTFB p75 critical`   | 30m    | 100 pageviews | p75 > 1800ms, or > baseline + 50% |

The two anti-fatigue controls, both in the module and both tested:

1. **Volume floors**, checked before any ratio or percentile.
2. **Asymmetric windows.** A critical rule uses a short window (15–30m) so a bad deploy is caught fast; the matching warning rule uses a 4× longer window and a higher floor, so it only fires on _sustained_ degradation. A transient burst trips critical, which is the ordering you want.

Web Vitals budgets follow the published Core Web Vitals good/poor boundaries. `CLS` is warning-only because it is unitless and has no "poor" line worth paging on for a single-page dashboard; a sustained drift past 0.1 is still a real regression worth mentioning. The relative bands are tighter on warning (25%) than critical (50%) so slow erosion becomes visible before it becomes an outage.

Full reasoning for every number, including boundary semantics and the zero/missing-baseline cases, is in `lib/telemetry/README.md`.

## Alert payload

`buildAlertPayload()` produces a provider-agnostic object that serialises to a Sentry webhook `action` payload with no transformation, so switching notification channel does not change rule configuration. It carries the three things the acceptance criteria call for — affected route, metric/error type, magnitude — plus the context to act without leaving the channel:

```jsonc
{
  "title": "[CRITICAL] LCP p75 critical — /transactions",
  "severity": "critical",
  "environment": "production",
  "route": "/transactions",
  "release": "synapse-web@1.4.0",
  "signal": "web-vitals LCP / p75-regression",
  "magnitude": "LCP p75 3000ms regressed from a baseline of 2000ms (1.5x)",
  "detail": { "observed": 3000, "limit": 2500, "multiple": 1.5, "windowMinutes": 60 },
  "dashboardUrl": "https://sentry.example.io/org/web-vitals/?route=%2Ftransactions",
}
```

`detail.multiple` lets a channel sort by severity of breach rather than arrival order. When the provider cannot attribute a sample to a route, `route` is `"(unattributed)"` rather than an empty string, because an unhandled rejection must still produce a readable title.

## Acceptance criteria

Scope, honestly split:

- [x] **Alert rules defined for error-rate spikes and Web Vitals regressions beyond defined thresholds** — eight rules with concrete thresholds in `ALERT_THRESHOLDS` and `.sentry-alerts.yml`, with per-rule field mapping to the Sentry metric-alert builder.
- [x] **Alert payloads include enough context (affected route, error type/metric, magnitude)** — `AlertPayload` in `lib/telemetry/alertRules.ts`, asserted in tests for each breach type (ratio, absolute count, p75 absolute, p75 regression, unattributed route, CLS unitless formatting).
- [x] **Thresholds tuned to avoid alert fatigue, with the chosen thresholds and rationale documented** — volume floors plus asymmetric windows, both implemented in the module and both tested; rationale in `lib/telemetry/README.md` and inline per-rule in `.sentry-alerts.yml`.
- [x] **Threshold-evaluation logic has real unit tests** — 42 tests in `lib/telemetry/alertRules.test.ts`, no stubs, no assertions that do not run.
- [x] **Out of scope: custom alerting engine** — not built. The module is a pure function with no timers, no state, no I/O.
- [ ] **Alert rules live in the Sentry UI and fire against a deliberate staging test trigger.** Cannot be done from a contributor branch — it needs a Sentry org, a Slack/SMTP integration, and a staging deployment. This is the piece I cannot verify and am not claiming.
- [ ] **Alerting fires correctly against a deliberately triggered test error spike in staging.** Same reason. The manifest carries a concrete rehearsal procedure (`staging_rehearsal:`) including the specific anti-fatigue assertion — force an unhandled error and reload five times, expect _exactly one_ `Error rate critical` and nothing from the warning tier; if the warning tier also fires, the volume floors are wired up wrong.
- [ ] **Delivery via a configured notification channel (Slack/email/webhook).** The channel actions are declared in `.sentry-alerts.yml` and the webhook payload contract is implemented and tested, but pointing them at a real Slack channel requires org credentials.

### What the team needs to do to finish this

1. Create the eight rules in Sentry → org → Alerts → Create Alert Rule → Metric Alert. `lib/telemetry/README.md` has the step-by-step with the field-by-field mapping, and `.sentry-alerts.yml` has per-rule values.
2. Set "Insufficient Data" to resolve as _inconclusive_ — this is how the volume floors are actually implemented in Sentry.
3. Attach the actions, pointing the webhook at a receiver that renders `AlertPayload`.
4. Create the same rules in `staging` with 5m/15m windows and run the rehearsal.
5. Reconcile by name against `ALERT_RULE_NAMES`; the test already fails on drift.

## Verification

Run in this branch, against `upstream/main` @ `48cdca3`:

```
npm run test        # 31 baseline + 42 new = 73 tests pass across 6 files
npm run lint        # clean
npx tsc --noEmit    # clean
npm run build       # succeeds
```

The new test file is isolated — no existing test, component, or config file is modified — so the baseline 31 tests are unchanged. `.sentry-alerts.yml` and the README are not code and are not linted or typechecked; I validated the YAML parses cleanly (8 rules, 3 actions, all action references resolve) with a standalone parser.

## Notes for review

- **No new dependencies.** Deliberate — this is a plumbing issue and the value is in correctness and explicitness, not in a new framework.
- **No existing file touched.** This PR is entirely additive, so it should merge without conflict even though several other issues in this wave touch `package.json` and `ci.yml`.
- **The thresholds are a starting point, not a measured baseline.** They are the industry-standard boundaries and they are defensible on day one, but the right long-term move is to revisit them after a few weeks of real production traffic and tune against observed variance. I would rather ship defensible default numbers with that caveat stated than pretend the numbers are empirically calibrated when the telemetry they depend on does not exist yet.
- **The module does not emit anything.** It does not import Sentry, does not open sockets, and is not wired into the app. That is intentional: the telemetry SDK integration and the alert _transport_ are separate concerns, and the issue that owns the SDK is landing separately in this wave. `evaluateAlerts()` is the seam where a future collector feeds provider samples in.

Related: #163 (Lighthouse CI) catches performance regressions pre-merge; these rules cover production reality. The Web Vitals budgets above are intentionally aligned with Lighthouse's so the two do not disagree.

closes #162
