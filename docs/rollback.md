# Automated rollback

Implements [#171](https://github.com/Synapse-bridgez/synapse-web/issues/171): an
automated, fast rollback trigger that does not depend on a human noticing a
regression, plus the manual overrides and anti-flap guards that make such a
mechanism safe to leave running unattended.

| File                                                                                  | Role                                                                    |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| [`.github/workflows/rollback.yml`](../.github/workflows/rollback.yml)                 | The workflow: three entry points, state persistence, the alias move.    |
| [`scripts/deploy/rollback-policy.mjs`](../scripts/deploy/rollback-policy.mjs)         | The decision function. Pure, no I/O, unit tested.                       |
| [`scripts/deploy/rollback-policy.test.ts`](../scripts/deploy/rollback-policy.test.ts) | 31 tests covering thresholds and the anti-flap guards.                  |
| [`scripts/deploy/record-promotion.mjs`](../scripts/deploy/record-promotion.mjs)       | Records a promotion so there is something to evaluate and roll back to. |

## What a rollback is

Synapse Core is a stateless frontend. Rolling back means **serve the previous
build**: move the production alias back to the last known-good immutable artifact.
There is no database to migrate, no queue to drain and no state to unwind, so a
rollback is a single idempotent alias move that is safe to repeat.

The workflow cannot itself move the alias — it has no opinion about which platform
hosts the app. It POSTs to a deploy hook you configure, and fails loudly with
instructions if that hook is not set.

## Configuration you must provide

None of these have sensible universal defaults, so the workflow refuses to guess
and names the missing one in its error output. All are repository **Settings →
Secrets and variables → Actions**.

### Secrets

| Secret                         | Purpose                                                                    |
| ------------------------------ | -------------------------------------------------------------------------- |
| `SYNAPSE_HEALTH_SIGNALS_TOKEN` | Bearer token for the health-signal endpoint. Omit if the endpoint is open. |
| `SYNAPSE_ROLLBACK_HOOK_TOKEN`  | Bearer token for the deploy platform's rollback/promote hook.              |

### Variables

| Variable                              | Default | Meaning                                                                                                   |
| ------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------- |
| `SYNAPSE_HEALTH_SIGNALS_URL`          | —       | GET endpoint returning the health-signal JSON below. **Required** unless every run passes `signals_json`. |
| `SYNAPSE_ROLLBACK_HOOK_URL`           | —       | POST endpoint that points production at a previously deployed build. **Required for rollback to work.**   |
| `SYNAPSE_OBSERVATION_WINDOW_MINUTES`  | `15`    | Do not judge a promotion before it is this old.                                                           |
| `SYNAPSE_ROLLBACK_COOLDOWN_MINUTES`   | `30`    | After a rollback, no further _automatic_ rollback for this long.                                          |
| `SYNAPSE_MAX_CONSECUTIVE_ROLLBACKS`   | `2`     | Automatic rollback stops entirely after this many in a row.                                               |
| `SYNAPSE_MAX_ERROR_RATE`              | `0.01`  | Fraction (0–1) of failed requests that counts as degraded.                                                |
| `SYNAPSE_MAX_SYNTHETIC_FAILURE_RATIO` | `0.25`  | Fraction (0–1) of failed synthetic checks that counts as degraded.                                        |
| `SYNAPSE_MIN_REQUESTS`                | `50`    | Below this many requests, the error rate is too noisy to act on.                                          |
| `SYNAPSE_MIN_SYNTHETIC_SAMPLES`       | `3`     | Below this many synthetic checks, the ratio is too noisy to act on.                                       |

### The health-signal payload

```jsonc
{
  "windowMinutes": 10, // informational only
  "requests": 5120, // total requests in the window
  "errorRate": 0.0042, // 0–1, fraction that 5xx'd or threw
  "synthetic": { "total": 8, "failed": 0 }, // synthetic-monitoring checks in the window
}
```

Both `errorRate` and `synthetic` are independent triggers — either one breaching
its threshold is enough to roll back. Any field that is missing, or present but
computed from fewer than `SYNAPSE_MIN_*` samples, makes the workflow **hold** with
`insufficient-data` rather than act. Rolling back on five requests is how an
automation earns a reputation for being wrong.

This is an intentionally small, platform-neutral contract. If the wave's synthetic
monitoring emits a different shape, the cheapest fix is a one-line transform in
`Collect health signals` or in the `jq` that builds the request — not a rewrite of
the policy.

### The rollback hook contract

`POST $SYNAPSE_ROLLBACK_HOOK_URL` with `Authorization: Bearer $SYNAPSE_ROLLBACK_HOOK_TOKEN`
and a JSON body:

```json
{
  "toRef": "sha-or-deployment-id-of-the-last-good-build",
  "reason": "error rate 18.40% exceeds 1.00%"
}
```

Any 2xx is accepted. `toRef` is whatever your platform's promote API takes — a git
SHA, a build id, a deployment id. Most platforms expose this as a "promote this
deployment" call; the workflow does not care which.

### Persisted state

The cooldown and the circuit breaker need to remember what happened across runs, and
GitHub Actions has no key/value store. State lives in a single `state.json` on a
dedicated branch, `ops/production-deploy-state`, created on first run.

- That branch must **not** be branch-protected (the workflow pushes to it with the
  default `GITHUB_TOKEN` and `contents: write`).
- Add it to the repo's branch-list deny list for ordinary pushes if you use one, so
  nobody edits state by hand.

## Wiring it to your deploy pipeline

After a deploy finishes and the new build starts serving production, fire one
`repository_dispatch`. No token from the deploy job is required beyond
`contents: write`, which it already has.

```bash
curl -X POST \
  -H "Accept: application/vnd.github+json" \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  https://api.github.com/repos/Synapse-bridgez/synapse-web/dispatches \
  -d '{"event_type":"deploy_completed","client_payload":{
        "ref":"'"$GITHUB_SHA"'",
        "previous_ref":"'"$PREVIOUS_SHA"'"}}'
```

That records the promotion, starts the observation window, and sets
`lastKnownGoodRef` to the ref that was live immediately before — the build a
rollback would restore.

The `*/5` schedule sweep picks the deployment up once the observation window closes,
so a regression is judged within five minutes of the window opening. **If your
pipeline never dispatches, every sweep returns `no-promotion` and nothing will ever
roll back** — the workflow will say so in the job summary.

## Manual overrides

Always available, via **Actions → Rollback → Run workflow**:

| `mode`  | Effect                                                                                                                                                                             |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auto`  | Evaluate the health signals and roll back if they breach, subject to every guard. The default.                                                                                     |
| `force` | Roll back **now**, bypassing the observation window, the cooldown and the open circuit breaker. Re-clears the breaker's memory, because a human is now driving.                    |
| `never` | Evaluate and report, but never roll back. Sets a hold for `SYNAPSE_ROLLBACK_COOLDOWN_MINUTES` so the next scheduled sweep does not undo the operator's decision behind their back. |

`never` is checked before the health-signal source, so a deliberate "do not roll
back" still works when the monitoring integration is misconfigured.

## The anti-flap circuit breaker

The failure this prevents: deploy A is judged bad, we roll back, the next deploy
re-promotes the same bad artifact, we roll back again, and CI flaps until people
stop reading it. Three stages, all in `decide()` and all unit tested:

1. **Observation window.** A promotion is never judged before it is
   `observationWindowMinutes` old, so a cold-start error spike cannot roll back a
   build that was about to settle.
2. **Cooldown.** After a rollback, further _automatic_ rollbacks are refused for
   `cooldownMinutes`. A promotion that lands _inside_ that window is recognised as
   the rejected artifact being re-promoted and trips stage 3 immediately.
3. **Circuit breaker.** After `maxConsecutiveRollbacks` in a row — or on a
   re-promotion inside the cooldown — the breaker latches, automatic rollback stops
   entirely, and the run fails with `Automatic rollback suspended`. Only an operator
   (`mode: force` or `mode: never`) can clear it. A deploy never clears it: the
   automated pipeline is the thing most likely to re-trip it.

`concurrency: production-rollback` on the workflow serialises whole runs, so two
evaluations can never race each other to the alias.

## What is not verified here

The threshold values, the signal payload and the two hooks are all configuration
for a deploy platform and a monitoring account that this repository does not have.
The decision logic — thresholds, sample-size floors, the window, the cooldown, the
breaker, both manual overrides — is covered by
`rollback-policy.test.ts`. The loop that _drives_ it — dispatch → observe → decide
→ move the alias — has not been run against a real deployment, so the
"verified via a deliberate-regression test deployment triggering correct, fast
automated rollback" definition of done still needs a staging environment. See the
PR description for the exact steps to run that verification.
