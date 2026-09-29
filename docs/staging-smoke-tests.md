# Staging smoke tests

A deploy that builds cleanly still tells you nothing about the _running_
application. A production bundle can ship with a missing chunk, a broken
hydration, or an unreachable Testnet RPC, and every one of those passes
`npm run build`. These smoke tests close that gap: a narrow Playwright suite run
against the already-deployed staging URL, immediately after the deploy, before
anything is promoted toward production.

Run against a deployed URL, never a locally booted copy. A smoke test that
builds and starts its own copy cannot catch a bad deploy, which is the only
thing it is for.

## What it covers

`e2e/smoke.spec.ts` — the highest-value golden paths, all of which can be
verified without credentials, a funded account, or a mock:

| Test                                  | What it proves                                                                                                                                                                                                            |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `serves the dashboard`                | The page returns 200, has the right title, and the header, all four tabs, and the footer render. Catches an error boundary or a blank shell.                                                                              |
| `ships every asset the page asks for` | No same-origin response ≥ 400 and no failed request. Catches a stale build id or a partially-copied `_next/static` directory, which the page otherwise renders straight through.                                          |
| `hydrates the client bundle`          | No uncaught exception and no console error, and a tab click actually flips `aria-selected`. The click is the point: React only attaches handlers once hydration completes, so a DOM change is proof the bundle took over. |
| `reaches the live Stellar RPC`        | The deployed bundle really calls Soroban RPC and the footer leaves `connecting`.                                                                                                                                          |
| `opens the wallet picker`             | The wallets-kit modal opens, proving the kit initialised and the click handler ran.                                                                                                                                       |

Deliberately **not** covered: completing a wallet connection, submitting a
transaction, or asserting on contract data. All of those need credentials this
gate must not have, and `NEXT_PUBLIC_CONTRACT_ID` may legitimately be unset on
the target.

## Running it

```bash
SMOKE_BASE_URL="https://staging.example.com" npm run test:e2e:smoke
```

`SMOKE_BASE_URL` is required and has no default. `playwright.config.ts` throws in
the config, before any browser starts, with a message saying how to fix it —
a smoke test silently pointed at `localhost` is worse than none, because it
passes.

## Retry strategy

The tension the issue calls out: resilient to transient Testnet RPC flakiness,
without being so lenient that genuine breakage slips through.

The position taken here:

- **2 retries in CI, 0 locally.** A failure that is merely slow to arrive gets a
  second chance; a genuinely broken deploy exhausts the budget and fails the
  gate rather than quietly passing.
- **No blanket leniency.** There is no `test.fixme`, no swallowed assertion, and
  no "retry until green" loop. Retries are bounded, and every test still fails
  on a real problem.
- **The RPC test tolerates a wrong contract, not a dead request.** A
  configured-but-wrong contract reads `error: …` in the footer, which is
  information, not a broken deploy, and passes. Being stuck on `connecting`
  means the request never came back — that is the failure worth catching — and
  fails.
- **A failing test is loud, not silent.** Assertions carry the collected
  detail: bad URLs, console output, and uncaught exceptions are interpolated
  into the failure message rather than swallowed into a generic retry.

One worker against one shared deployment (`workers: 1` in CI). More would have
the tests fighting over the same instance and turn a health signal into a load
test.

## How it gates promotion

`smoke.yml` defines two jobs:

- **`smoke`** — runs the suite. `timeout-minutes: 15` so a hung test can never
  sit on the gate forever.
- **`promote-gate`** — `needs: smoke`, so it only runs when every test passed.
  This job is the required status check.

The gate is a repository/environment setting rather than something a workflow
file can enforce, so configure it once:

> Settings → Environments → _production_ → Deployment protection rules →
> Required status checks → **`Promotion gate`**

With that in place, a failed smoke test means `promote-gate` never reports
success, and production is not deployable until staging genuinely works.

## Triggers

| Trigger               | Purpose                                                                                            |
| --------------------- | -------------------------------------------------------------------------------------------------- |
| `repository_dispatch` | `staging-deployed` — how a deploy pipeline fires this post-deploy.                                 |
| `workflow_dispatch`   | Manual re-verification, or a local rehearsal against a known-good URL.                             |
| `schedule` (hourly)   | Catches a deploy that rotted _after_ promotion — expired cert, drained pool, a Testnet RPC change. |

Concurrent runs are serialised (`concurrency` with `cancel-in-progress: false`),
so a queued deploy's smoke run never cancels an in-flight one.

## Required secret

`SMOKE_BASE_URL` — a repository secret holding the staging URL. The workflow
also accepts a `base_url` input or a `client_payload.base_url`, so a deploy
pipeline can target a per-deploy URL without rotating a secret.

The workflow refuses any non-HTTPS target except `localhost`/`127.0.0.1`. The
suite is unauthenticated, and unauthenticated traffic aimed at a public host is
not something to send by accident.
