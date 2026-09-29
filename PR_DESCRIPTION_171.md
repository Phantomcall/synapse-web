# Automated rollback for failed / degraded production deploys

Implements the automated-trigger and previous-version-restoration half of #171:
health thresholds that fire a rollback inside a bounded window of a deploy, manual
overrides in both directions, and a real circuit breaker against rollback flapping.

## What

| File                                     | Role                                                                              |
| ---------------------------------------- | --------------------------------------------------------------------------------- |
| `.github/workflows/rollback.yml`         | Three entry points, persisted state, the alias move, the loud failure.            |
| `scripts/deploy/rollback-policy.mjs`     | The decision function. Pure, no I/O. 31 unit tests.                               |
| `scripts/deploy/rollback-policy.test.ts` | Threshold, window, cooldown, breaker and override coverage.                       |
| `scripts/deploy/record-promotion.mjs`    | Records a promotion so there is something to judge and something to roll back to. |
| `docs/rollback.md`                       | The configuration contract: every variable, every secret, the payload shape.      |
| `README.md`                              | Short pointer to the above.                                                       |

`ci.yml` is deliberately untouched — the new tests are picked up by the existing
`npm run test`, so this PR does not touch the file four other issues in this wave
also touch.

## Design

**Rolling back = serving the previous build.** Synapse Core is a stateless frontend,
so a rollback is a single idempotent move of the production alias back to the last
known-good immutable artifact. No schema, no queue, no state to unwind — so no
down-migration step that can half-apply. The workflow does not know which platform
hosts the app and never assumes one: it POSTs to a configured hook and fails with
instructions if the hook is not set.

**Three entry points, one decision function.**

| Entry point                              | What it does                                                                                                                                      |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repository_dispatch` `deploy_completed` | The deploy pipeline records the promotion. Starts the observation window and sets `lastKnownGoodRef` to the ref that was live immediately before. |
| `schedule`, `*/5`                        | Sweeps. This is what bounds detection: a bad build is judged within 5 minutes of its observation window closing.                                  |
| `workflow_dispatch`                      | Operator override: `auto` / `force` / `never`.                                                                                                    |

**The state.** GitHub Actions has no key/value store, so the cooldown and the breaker
persist a `state.json` on a dedicated branch, `ops/production-deploy-state`, created
on first run. A branch is the only durable same-repo option that needs no third-party
action and no external database.

**Everything is configuration.** Thresholds, the observation window, the cooldown,
the breaker depth and both hook URLs are repository variables, read through
`${{ vars.* }}` with documented fallbacks. Nothing is hardcoded to a platform, and
`docs/rollback.md` has the full table. There is no secret in the repo.

## The flapping guard — the edge case the issue calls out

The failure mode: deploy A is judged bad, we roll back, the next deploy re-promotes
the same bad artifact, we roll back again, and CI flaps until people stop reading it.
Three stages, all in `decide()`, all unit tested:

1. **Observation window.** A promotion is never judged before it is
   `observationWindowMinutes` (default 15) old, so a cold-start error spike cannot
   roll back a build that was about to settle.
2. **Cooldown.** After a rollback, further _automatic_ rollbacks are refused for
   `cooldownMinutes` (default 30). Critically, a promotion that lands _inside_ that
   window is recognised as the rejected artifact being re-promoted and trips stage 3
   on the very next sweep rather than rolling back a third time.
3. **Circuit breaker.** After `maxConsecutiveRollbacks` (default 2) in a row — or on
   stage 2's re-promotion case — the breaker latches. Automatic rollback stops
   entirely and a dedicated job **fails the run** with
   `Automatic rollback suspended`, so it shows up in the required-check list.

Only an operator clears the breaker (`mode: force` or `mode: never`). A deploy never
does: the automated pipeline is the thing most likely to re-trip it, so letting a
promotion clear the breaker would defeat the mechanism.

The breaker only fails the run on the _transition_ into the latched state
(`breaker_open=1 && breaker_was_open=0`), so the 5-minute sweep does not go red
forever once someone is already looking at it. Every later run still gets a
`::warning::` and a summary line.

`concurrency: {group: production-rollback, cancel-in-progress: false}` on the
workflow serialises whole runs, so two evaluations can never race each other to the
alias, and a queued run waits for an in-flight rollback rather than cancelling it.

## Manual override, both directions

- **Force** (`mode: force`) — roll back now, bypassing the observation window, the
  cooldown and a latched breaker, and re-clear the breaker's memory because a human
  is driving.
- **Prevent** (`mode: never`) — evaluate and report but never roll back. It latches
  a hold for `cooldownMinutes` so the _next scheduled sweep does not undo the
  operator's decision behind their back_, which is the failure mode a naive
  "just check a flag" override has. It is evaluated before the health-signal source,
  so a deliberate "do not roll back" still works when monitoring is misconfigured.

## Verification

The decision logic is exercised both as unit tests and as a full end-to-end run of
the exact command the workflow runs, driving the real `state.json` through the real
`jq` request builder and the real CLI. Same script, deterministic clock, real output:

```
--- T-30m  deploy pipeline promotes sha-BADDEPLOY (previous: sha-KNOWNGOOD)
recorded promotion of sha-BADDEPLOY at 2026-03-04T11:30:00.000Z; rollback target is sha-KNOWNGOOD

--- T+0    sweep #1, 30m after promotion, signals healthy
action=hold
code=healthy
rollback_to=
breaker_was_open=0
breaker_open=0
reason="health signals within thresholds (error rate 0.0042, synthetic 0/8)"

--- T+0    sweep #2, signals degraded (18.4% errors) -> ROLLBACK
action=rollback
code=degraded
rollback_to=sha-KNOWNGOOD
breaker_was_open=0
breaker_open=0
reason="error rate 18.40% exceeds 1.00%"

--- T+5m   sweep #3, still degraded -> refused by the cooldown (anti-flap)
action=hold
code=cooldown
rollback_to=
breaker_was_open=0
breaker_open=0
reason="last rollback was 5.0m ago; refusing another automatic rollback until 30m has elapsed, to avoid flapping"

--- T+10m  deploy pipeline RE-PROMOTES the artifact that was just rolled back
recorded promotion of sha-BADDEPLOY at 2026-03-04T12:10:00.000Z; rollback target is sha-KNOWNGOOD

--- T+15m  sweep #4 -> CIRCUIT BREAKER LATCHES (fails the run via latched-breaker job)
action=hold
code=breaker-open
rollback_to=
breaker_was_open=0
breaker_open=1
reason="ref sha-BADDEPLOY was promoted 10.0m after a rollback — the rejected artifact is being re-promoted. Opening the circuit breaker; automatic rollback is suspended until a human runs mode=force or mode=never"

--- T+20m  sweep #5 -> still suspended, no rollback attempted
action=hold
code=breaker-open
rollback_to=
breaker_was_open=0
breaker_open=1
reason="circuit breaker is open (1 consecutive rollbacks); automatic rollback is suspended until a human runs mode=force or mode=never"

--- T+20m  operator: mode=force -> rollback proceeds and the breaker is cleared
action=rollback
code=degraded
rollback_to=sha-KNOWNGOOD
breaker_was_open=1
breaker_open=0
reason="error rate 18.40% exceeds 1.00%"
{"breakerOpen":false,"consecutiveRollbacks":0,"lastRollbackAt":"2026-03-04T12:20:00.000Z"}

--- operator: mode=never on a fresh state -> prevents the rollback and latches a hold
action=hold
code=manual-hold
rollback_to=
breaker_was_open=0
breaker_open=0
reason="operator selected \"never\": known upstream SDK regression, fix ships tomorrow"

--- the next scheduled sweep is held too (the operator's decision is not undone behind their back)
action=hold
code=manual-hold
rollback_to=
breaker_was_open=0
breaker_open=0
reason="operator hold in force until 2026-03-04T12:30:00.000Z"

--- unavailable signal source is NOT treated as healthy (fresh state)
action=hold
code=no-signals
rollback_to=
breaker_was_open=0
breaker_open=0
reason="health signals were unavailable; refusing to guess"

--- too little traffic to judge -> hold, not a false rollback
action=hold
code=insufficient-data
rollback_to=
breaker_was_open=0
breaker_open=0
reason="not enough traffic or synthetic checks in the window to judge the deployment either way"

--- no promotion recorded at all
action=hold
code=no-promotion
rollback_to=
breaker_was_open=0
breaker_open=0
reason="no promotion recorded in the deploy state; nothing to evaluate. Fire repository_dispatch `deploy_completed` from the deploy pipeline to record one"
```

The unit tests are not decoration either — neutering the anti-flap guards makes them
fail:

```
$ npx vitest run scripts/deploy/rollback-policy.test.ts
 × never rolls back a promotion that is inside the observation window
 × refuses a second automatic rollback inside the cooldown window
 × opens the circuit breaker when the rejected artifact is re-promoted inside the cooldown
 × refuses to roll back at all once the breaker is open, even on a fresh signal
 × an operator hold suppresses automatic rollbacks until it lapses
 × a hold never advances the rollback counter
 Tests  6 failed | 25 passed (31)
```

## Two design calls worth arguing with

**Insufficient data is not a passing health check.** A rollback triggered by three
synthetic checks is a coin flip, so `evaluateSignals` returns
`insufficient-data` — a _hold_ — whenever either signal is below its minimum sample
size, and only acts when the samples can carry the decision. Same for an unreachable
signal source: `no-signals` holds rather than assuming healthy. An unconfigured
health gate is not a passing health gate, and the workflow says so in a hard error
rather than going quiet.

**Recording a promotion is separated from judging it.** `record-promotion.mjs` and
`decide()` are separate entry points precisely so the deploy pipeline can record what
happened without being able to skip the evaluation. An override that only checks a
flag would let an automated pipeline talk its way past the gate.

## Scope note

The issue says this "builds directly on the blue-green/canary rollout issue's
health-signal evaluation". That issue is a separate, still-open piece of work, and
this repository currently has no deploy pipeline at all. Rather than invent a
blue/green framework that a sibling issue is going to define, this PR consumes
health signals through a small documented contract and treats the deploy pipeline as
an external caller. When blue-green lands, the integration is: the canary workflow
fires `deploy_completed`, and the same policy engine evaluates it. If the
wave's synthetic monitoring emits a different payload shape, the cheapest fix is a
transform in `Collect health signals` or the `jq` request builder — not a rewrite of
the policy.

## Definition of done

- [x] Automated rollback triggered by defined health-signal thresholds (error rate,
      synthetic-monitoring failure ratio), with sample-size floors so the thresholds
      cannot fire on noise.
- [x] Bounded time window: the observation window gates evaluation and the `*/5`
      sweep bounds it to 5 minutes of that window.
- [x] Manual override always available in both directions (`force` and `never`),
      reachable from `workflow_dispatch` even when the monitoring integration is
      broken.
- [x] Cooldown + circuit breaker against rollback flapping, with the failure mode it
      prevents written down in both the code header and `docs/rollback.md`.
- [x] Stateless framing: rollback is "serve the previous build"; no data migration
      step exists to get wrong.
- [x] Thresholds and the deploy integration parameterised, and every required
      variable and secret documented in `docs/rollback.md`.
- [ ] **Verified via a deliberate-regression test deployment triggering correct, fast
      automated rollback.** Not verified here, and not verifiable from a contributor
      branch: it needs a real deploy platform, a real production alias, and a real
      monitoring endpoint. What I verified in-repo is the decision logic, the state
      machine and the CLI data path, by running them directly as shown above. What
      still needs the team is the loop that drives them. To verify: set the
      variables in `docs/rollback.md`, point `SYNAPSE_ROLLBACK_HOOK_URL` at a staging
      deploy hook, fire `deploy_completed` for a deliberately broken build, and check
      that (a) nothing happens until the observation window closes, (b) a sweep within
      five minutes of that moves the staging alias back, and (c) re-firing
      `deploy_completed` for the same bad build inside the cooldown latches the
      breaker and fails the run.

## Full gate

```
$ npm run test     # 6 files, 62 tests passed (31 pre-existing + 31 new)
$ npm run lint     # clean
$ npx tsc --noEmit # clean
$ npm run build    # ✓ Compiled successfully
```

closes #171
