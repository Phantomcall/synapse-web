feat(ops): add synthetic uptime and RPC-connectivity monitoring

`CI` proves the code builds. Nothing watched the _deployed_ site, so an RPC
provider outage, a DNS failure, or a hosting incident surfaced as users
reporting a broken dashboard rather than as an alert.

## The health endpoint

`GET /api/health` performs a real `getHealth` call to the configured Soroban
endpoint and reports two independent states:

```json
{
  "status": "degraded",
  "app": { "reachable": true },
  "rpc": { "reachable": false, "endpoint": "...", "error": "..." },
  "checkedAt": "..."
}
```

**It returns 200 whenever the app is serving, even when the RPC is down.** This is
the central design decision. Folding RPC health into the status code would mean
an upstream provider outage reports the dashboard as down and sends someone to
the wrong incident — exactly the distinction the issue asks to preserve. Callers
read `rpc.reachable` to tell the two apart.

Three further decisions worth naming:

- `getHealth` rather than a transaction simulation: it needs no contract and no
  signature, so the check keeps working on a mock-data build with nothing
  deployed.
- The wait is bounded by an explicit timeout. An unbounded wait would make a
  _hung_ provider look identical to a healthy one.
- `cache-control: no-store`. A cached 200 would hide precisely the outage this
  exists to catch.

A missing `latestLedger` is treated as healthy, not as a failure — some providers
omit it on success, and failing there would report a healthy endpoint as down.

## The scheduled check

`.github/workflows/uptime-check.yml` runs every 10 minutes and on manual
dispatch, probes both the page and the health route, and escalates only after
**3 consecutive failures** — a single failure is usually a redeploy. The
consecutive-failure count is persisted on the tracking issue itself, so the
threshold survives between runs with no extra infrastructure.

The target is configurable via the `UPTIME_TARGET_URL` repository variable or the
dispatch input, which is how the staging outage test is run.

Alerting opens a single reviewable `uptime-alert` issue rather than paging
directly, so no third-party secrets are needed and the alert has a history.

## Documentation

`docs/uptime-monitoring.md` covers the response shape, which failure mode means
what, the label prerequisite, and the three-step staging outage test.

It also states plainly that the scheduled workflow is a **backstop, not a
heartbeat**: GitHub Actions schedules are frequently delayed under load and can
be skipped, so the doc specifies an external monitor (UptimeRobot, BetterStack,
or Checkly — all support a JSON body assertion, so no custom backend is needed)
as the primary signal, against `/api/health`, alerting on a non-200 status or
`rpc.reachable: false`.

## Verification

- `npx tsc --noEmit` — clean.
- `npm run lint` — 0 errors.
- `npm test` — **48 pass** (31 pre-existing + 17 new).
- `npm run build` — compiled successfully, and the route is registered as
  `ƒ /api/health` (dynamic, not prerendered).
- `npm run format:check` — clean for every file in this PR; the three files it
  still flags are pre-existing and untouched.

The 17 new tests:

- `lib/soroban/rpcHealth.test.ts` (12) — healthy endpoint, a **missing**
  `latestLedger` still healthy, latency recorded, a throwing endpoint, a **hung
  endpoint timing out**, long provider errors truncated to keep the alert payload
  bounded, and a non-`Error` throw. Plus `withTimeout` resolving, propagating a
  rejection, timing out, and not misfiring on a slow-but-successful call.
- `app/api/health/route.test.ts` (5) — the response contract, with the
  `RPC-down-but-still-200` case as the headline assertion, plus the no-store
  header, the timestamp, and the endpoint echo that makes a misconfiguration
  visible in an alert.

## Not verified, and why

The issue's DoD is "live monitoring configured against production, verified
alerting on a deliberate staging-environment outage test". Three things there
are outside a fork PR and are called out rather than claimed:

1. **The default target URL is a placeholder** (`https://synapse.example.com`).
   The real deployment URL is a maintainer setting — the workflow reads it from
   the `UPTIME_TARGET_URL` repository variable, which does not exist yet.
2. **The `uptime-alert` label does not exist yet**, so the first real failure
   would fail at `gh issue create`. The exact `gh label create` command is in the
   doc.
3. **The staging outage test was not performed**, as there is no staging
   deployment to disrupt. Both failure modes are covered by unit tests and the
   manual procedure is written out step by step.

GitHub-hosted CI on fork PRs also sits at `action_required` until a maintainer
approves the run, which is expected.

closes #161
