# ci: run a staging smoke suite post-deploy and gate promotion on it

Closes #169

A deploy that builds cleanly still tells you nothing about the _running_
application. A production bundle can ship with a missing chunk, a broken
hydration, or an unreachable Testnet RPC, and every one of those passes
`npm run build`. This adds a narrow Playwright suite run against the
**already-deployed** staging URL immediately after the deploy, plus the gate that
stops a broken staging deploy being promoted to production.

## What this adds

**`e2e/smoke.spec.ts`** — five golden-path tests, none of which need credentials,
a funded account, or a mock:

| Test                                  | What it proves                                                                                                                                                           |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `serves the dashboard`                | 200, right title, header + all four tabs + footer render. Catches an error boundary or blank shell.                                                                      |
| `ships every asset the page asks for` | No same-origin response ≥ 400, no failed request. Catches a stale build id or a partially-copied `_next/static`, which the page otherwise renders straight through.      |
| `hydrates the client bundle`          | No uncaught exception, no console error, and a tab click actually flips `aria-selected`. The click is the point — React only attaches handlers once hydration completes. |
| `reaches the live Stellar RPC`        | The deployed bundle really calls Soroban RPC and the footer leaves `connecting`.                                                                                         |
| `opens the wallet picker`             | The wallets-kit modal opens, proving the kit initialised and the handler ran.                                                                                            |

**`playwright.config.ts`** — no `webServer` block, deliberately. A smoke test that
builds and starts its own copy cannot catch a bad deploy, which is the only thing
it is for. `SMOKE_BASE_URL` is required with **no default**, and the config
throws before any browser starts rather than silently pointing at `localhost` and
passing.

**`.github/workflows/smoke.yml`** — the missing pipeline integration. Two jobs:

- `smoke` — runs the suite against a URL resolved from (in order) a
  `workflow_dispatch` input, a `repository_dispatch` `staging-deployed`
  payload, or the `SMOKE_BASE_URL` secret. `timeout-minutes: 15` so a hung test
  cannot sit on the gate forever. Uploads the Playwright report **on success
  too** — it is the evidence staging was actually exercised.
- `promote-gate` — `needs: smoke`, so it only reports success when every test
  passed.

**`docs/staging-smoke-tests.md`** — coverage, the retry strategy, and the gate
wiring. Plus a README section and the new `test:e2e` / `test:e2e:smoke` scripts.

## Verification: proven to pass, and proven to fail

The issue asks for verification that the suite fails against a deliberately
broken staging deploy. Both directions were run.

**Passes against a real build.** `npm run build`, `next start`, then:

```
✓  serves the dashboard (605ms)
✓  ships every asset the page asks for (2.5s)
✓  hydrates the client bundle without uncaught exceptions (730ms)
✓  reaches the live Stellar RPC (2.5s)
✓  opens the wallet picker (819ms)
5 passed (8.1s)
```

**Fails against a deliberately broken deploy.** A single JS chunk was deleted
from `.next/static/chunks/` — a build that succeeds and a deploy that ships:

```
✓  serves the dashboard (639ms)
✘  ships every asset the page asks for (1.2s)
✘  hydrates the client bundle without uncaught exceptions (5.9s)
✘  reaches the live Stellar RPC (30.7s)
✘  opens the wallet picker (5.8s)
4 failed, 1 passed (48.4s)
```

With diagnostics that name the actual problem rather than "assertion failed":

- `same-origin responses >= 400:` followed by the failing URL
- `locator resolved to <button role="tab" aria-selected="false">` — 63 polls,
  hydration never completed
- `unexpected value "SYNAPSE CORE · v0.1.0 · TESTNET⬡ SOROBAN RPC: connecting"` —
  stuck at `connecting` for the full 30s
- the wallets-kit modal never appeared

Worth noting: **`serves the dashboard` still passed.** That is the point of the
whole suite — it catches the class of failure where the build is green and the
first response is a 200, which is exactly the gap the issue describes.

## Retry strategy

Resilient to transient Testnet flakiness without being lenient enough to miss
real breakage:

- **2 retries in CI, 0 locally.** Bounded, so a genuinely broken deploy exhausts
  the budget and fails the gate rather than quietly passing.
- **No blanket leniency.** No `test.fixme`, no swallowed assertions, no
  retry-until-green.
- **The RPC test tolerates a wrong contract, not a dead request.** A
  configured-but-wrong contract reads `error: …` and passes; being stuck on
  `connecting` means the request never returned, and fails.
- **One worker** against one shared deployment, so a health signal does not turn
  into a load test.

## Three defects found in the pre-existing draft

The branch had an uncommitted implementation of the suite. Completing it surfaced
three problems that would each have shipped:

**1. It would have failed CI's unit-test step.** Vitest's default
`**/*.spec.ts` glob collected `e2e/smoke.spec.ts`, which then died with _"Playwright
Test did not expect test.describe() to be called here"_. `npm test` went from
31 passing to `1 failed | 5 passed` as soon as the file existed. `vitest.config.ts`
now excludes `e2e/**` (plus the report dirs); Vitest owns the unit tests,
Playwright owns `e2e/`, and each is reached by its own script. Verified both ways
afterwards: 5 files / 31 tests pass under Vitest, and `playwright test --list`
still finds all 5.

**2. No pipeline integration at all.** The draft was `playwright.config.ts` plus
the spec — nothing ran it, so "runs automatically after every staging deploy"
and "failing smoke tests block promotion", both explicit acceptance criteria,
were unmet. Added `smoke.yml` with the `promote-gate` job.

**3. 2.2 MB of Playwright artifacts were about to be committed.**
`playwright-report/` and `test-results/` were sitting untracked in the working
tree and matched nothing in `.gitignore`, so the usual `git add -A` would have
committed a build report. Both are now ignored, confirmed with
`git check-ignore -v`.

Also removed a stray `PR_DESCRIPTION_168.md` left in the tree — issue #168
already has its own PR (#233), so it does not belong to this branch.

## Note on the promotion gate

A workflow file cannot make its own job a required status check, so `promote-gate`
is the job to mark as required rather than something this PR can enforce alone.
The wiring is a one-time repository setting, documented in
`docs/staging-smoke-tests.md`:

> Settings → Environments → _production_ → Deployment protection rules →
> Required status checks → **`Promotion gate`**

With that in place a failed smoke test means promotion is blocked, which is the
behaviour the issue asks for. The hourly `schedule` trigger additionally catches
a deploy that rotted _after_ promotion.

## Files

| File                          | Change                                            |
| ----------------------------- | ------------------------------------------------- |
| `e2e/smoke.spec.ts`           | New — the five smoke tests                        |
| `playwright.config.ts`        | New — deployed-URL-only config, retries, 1 worker |
| `.github/workflows/smoke.yml` | New — post-deploy run + `promote-gate`            |
| `docs/staging-smoke-tests.md` | New — coverage, retry strategy, gate wiring       |
| `vitest.config.ts`            | Exclude `e2e/` so the runners do not collide      |
| `package.json`                | Add `test:e2e` and `test:e2e:smoke`               |
| `.gitignore`                  | Ignore Playwright report and test-results         |
| `README.md`                   | Scripts, smoke test section, file tree            |

## Verification

```
npx eslint            clean
npx tsc --noEmit      clean
npx vitest run        5 files, 31 tests passed (e2e/ correctly excluded)
npm run build         compiled successfully
playwright --list     5 tests in 1 file
smoke vs good build   5 passed
smoke vs broken build 4 failed, 1 passed — with diagnostic messages
npx prettier --check .  only the 3 warnings that already exist on main
```

---

closes #169
