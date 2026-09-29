# Canary rollout with automated rollback

| Piece                                                                                      | Role                                                     |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| [`.github/workflows/deploy-production.yml`](../../.github/workflows/deploy-production.yml) | Build → upload with no traffic → start rollout → watch   |
| [`scripts/deploy/canary-controller.mjs`](../../scripts/deploy/canary-controller.mjs)       | Polls signals and drives Vercel's Rolling Releases API   |
| [`scripts/deploy/canary-policy.mjs`](../../scripts/deploy/canary-policy.mjs)               | Pure promote / wait / rollback decision (unit-tested)    |
| [`.github/canary-policy.json`](../../.github/canary-policy.json)                           | Every threshold, reviewed like code                      |
| [`.github/workflows/canary-override.yml`](../../.github/workflows/canary-override.yml)     | Manual "roll back now" / "promote now"                   |
| [`vercel.json`](../../vercel.json)                                                         | Stops Vercel's Git integration deploying `main` directly |

## How a deploy flows

```
push to main ──► CI passes ──► Deploy production
                                 │  vercel build --prod
                                 │  vercel deploy --prebuilt --prod --skip-domain   (0% traffic)
                                 │  POST rolling-release/start                      (5% traffic)
                                 ▼
                        ┌─ canary controller, every 30 s ─────────────────────────┐
                        │ probe canary URL · fetch RUM for canary + production    │
                        │ decide(): rollback │ wait │ advance                     │
                        └──────────┬───────────────┬───────────────┬──────────────┘
                                   │               │               │
             POST rollback/{previous deployment}   │   approve-stage → 25%, then
             (100% back to production)             │   complete → 100%
                                                 wait
```

Traffic splitting is **Vercel Rolling Releases**, the platform's native
feature, so there is no custom routing layer. Vercel buckets visitors by a
sticky cookie, so a given user stays on one version for the whole stage.

## Rollback triggers

The controller rolls back as soon as **any** rule fires, at any stage,
including during the bake period. It doesn't wait for the stage to finish.

### Synthetic probes (always on)

The controller requests each `probe.paths` entry on the canary's own deployment
URL every poll. A probe fails on HTTP ≥ 400, a network error, or a response
slower than 10 s.

| Rule                                                                              | Value | Time to rollback                 |
| --------------------------------------------------------------------------------- | ----: | -------------------------------- |
| Consecutive failed probes (`synthetic.consecutiveFailures`)                       |     3 | **≤ 60 s** (3 polls, 30 s apart) |
| Failure ratio over the last 10 probes (`synthetic.maxFailureRatio`, min 5 probes) | > 20% | ≤ 5 min                          |

Because probes always run, a deploy is never promoted on zero evidence, even
with no real traffic.

### Real-user error rate (when the signals endpoint is configured)

| Rule                                                                               | Value                             |
| ---------------------------------------------------------------------------------- | --------------------------------- |
| Canary error rate above (`errorRate.max`)                                          | 2%                                |
| …**and** above this multiple of production's rate (`errorRate.maxRatioToBaseline`) | 2×                                |
| Evaluated once the canary has served (`errorRate.minRequests`)                     | 200 requests in the current stage |

Both conditions must hold. A canary that is exactly as bad as the deployment
already serving users didn't cause the regression, and rolling back wouldn't
help.

### Core Web Vitals, p75 (when the signals endpoint is configured)

| Metric | Roll back if "poor" (absolute) | Or if above "good" **and** > 1.25× production |
| ------ | -----------------------------: | --------------------------------------------: |
| LCP    |                      > 4000 ms |                                     > 2500 ms |
| INP    |                       > 500 ms |                                      > 200 ms |
| CLS    |                         > 0.25 |                                         > 0.1 |

Each vital needs 50 samples (`webVitals.minSamples`) before it's evaluated. The
bands are Google's published Core Web Vitals boundaries. The relative rule only
counts once the canary leaves the "good" range, so noise inside that range
(say, INP going from 40 ms to 60 ms) can't roll back a deploy.

### Low traffic

A RUM rule that hasn't reached its sample size is reported in the log as
"insufficient data" and doesn't block promotion. The synthetic rules still
apply. Without this, a low-traffic testnet dashboard could never promote.

### No decision

If a stage runs for 30 minutes (`maxStageMinutes`) without the controller
deciding to advance, it rolls back.

## Promotion

A stage advances once it has baked for **10 minutes** (`bakeMinutes`), has at
least 5 probes, and no rule has fired. With the recommended stages (5% → 25% →
100%), a healthy deploy reaches 100% about 20 minutes after upload.

## Manual override

You can override at any time:

- **Actions → Canary override → Run workflow**
  - `rollback` immediately sends 100% of traffic back to the previous
    production deployment. Once a rollout has already completed, supply
    `to_deployment` (the previous `dpl_…` id, from the Vercel Deployments
    page).
  - `promote` skips the remaining stages.
- Or use **Abort** or **Instant Rollback** in the Vercel dashboard.

The override workflow deliberately sits outside the rollout's concurrency
group, so it never waits behind the rollout it's cancelling. The controller
notices the release is no longer `ACTIVE` on its next poll and stops. If the
deploy job itself fails or is cancelled mid-rollout, its last step rolls back,
so a partial split is never left running unattended.

## Health signals endpoint

RUM data comes from the error-telemetry (#91) and Core Web Vitals (#141, #162)
work. The controller consumes one HTTP contract, so it doesn't depend on which
vendor those issues pick:

```
GET $CANARY_SIGNALS_URL?deploymentId=dpl_…&since=2026-09-29T00:00:00.000Z
Authorization: Bearer $CANARY_SIGNALS_TOKEN

200 {
  "requests": 1234,              // page views / sessions since `since`
  "errors": 5,                   // of those, how many reported an error
  "webVitals": {
    "lcp": { "p75": 1850, "samples": 400 },
    "inp": { "p75": 140,  "samples": 380 },
    "cls": { "p75": 0.03, "samples": 400 }
  }
}
```

The controller calls it for the canary and for the current production
deployment each poll. For that to work, telemetry events must carry the Vercel
deployment id (`VERCEL_DEPLOYMENT_ID` / `NEXT_DEPLOYMENT_ID`), as Vercel's
Rolling Releases docs recommend for external observability. If the endpoint is
unset or unreachable, the controller logs it and decides on synthetic probes
alone.

## Setup

1. **Vercel project → Settings → Build & Deployment → Rolling Releases**:
   enable it, choose **manual approval**, and set stages to **5%, 25%, 100%**.
   Also enable **Skew Protection**, which Vercel recommends alongside Rolling
   Releases. Rolling Releases requires a Pro or Enterprise plan.
2. Repository secrets: `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`
   (both ids are in `.vercel/project.json` after `vercel link`). Optional:
   `CANARY_SIGNALS_TOKEN`, `VERCEL_AUTOMATION_BYPASS_SECRET`.
3. Repository variable (optional): `CANARY_SIGNALS_URL`.
4. Create a `production` GitHub environment to scope the secrets. Don't add
   required reviewers to it, or the emergency override will wait for an
   approval.
5. `vercel.json` stops Vercel's Git integration from deploying `main` directly,
   because that would bypass the canary. Preview deployments for other
   branches are unaffected.

## Verifying rollback (deliberate-regression drill)

**Automated, on every PR.** `scripts/deploy/canary-controller.test.ts` runs the
real controller against an in-memory Rolling Releases simulator:

- A healthy canary is approved to 25% and then completed.
- A canary whose error rate jumps to 8% at the 25% stage is rolled back to the
  previous deployment on the first poll of that stage.
- **Drill mode** probes a path that 404s. The canary is rolled back after 3
  probes, 60 s of simulated time.
- An operator abort is respected, and the RUM endpoint being down doesn't block
  a decision.

**Against the real platform.** Run **Actions → Deploy production → Run
workflow** with **drill = true**. The deploy is real, but the controller probes
`/__canary-drill__/intentionally-missing`. That path 404s on any build, so the
synthetic rule has to fire, and Vercel has to move 100% of traffic back to the
previous deployment within about 60 s. Users only ever see the healthy build:
the drill fails the probes, not the app. Afterwards, check the job summary and
the Vercel Deployments page, which should show the rollback with its
description.
