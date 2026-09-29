# Uptime and RPC-connectivity monitoring

The `CI` workflow proves the code builds. It says nothing about whether the
**deployed** site is serving right now, or whether the Soroban RPC provider it
depends on is reachable. This is the synthetic check for those two things.

## What is checked, and why the two are separate

`GET /api/health` performs a real `getHealth` call to the configured Soroban
endpoint and reports two independent states:

```json
{
  "status": "degraded",
  "app": { "reachable": true },
  "rpc": {
    "reachable": false,
    "endpoint": "https://soroban-testnet.stellar.org",
    "error": "RPC did not respond within 5000ms"
  },
  "checkedAt": "2026-01-01T00:00:00.000Z"
}
```

They are separate because they need **different responses**:

| State                  | Meaning                                | Who should look              |
| ---------------------- | -------------------------------------- | ---------------------------- |
| `app.reachable: false` | the deployment is not serving          | hosting / DNS / deploy       |
| `rpc.reachable: false` | the app is up, the RPC provider is not | provider, or a config change |

**The endpoint returns 200 whenever the app itself is serving**, even when the
RPC is unreachable. Folding RPC health into the status code would mean an upstream
provider outage reports the dashboard as down and sends someone to the wrong
incident. Consumers read `rpc.reachable` to tell the two apart.

`getHealth` is used rather than a transaction simulation because it needs no
contract and no signature, so the check keeps working on a mock-data build with
nothing deployed.

The response is sent with `cache-control: no-store`. A cached `200` would hide
precisely the outage this exists to catch.

## Scheduled check

`.github/workflows/uptime-check.yml` runs every 10 minutes and on manual
dispatch. It probes the page and the health route, then escalates only after
**3 consecutive failures**, because a single failure is usually a redeploy rather
than an outage. The consecutive-failure count is persisted on the tracking issue
itself, so the threshold survives between runs with no extra infrastructure.

Set the repository variable `UPTIME_TARGET_URL` to check a different deployment.
Dispatching manually with a `url` input overrides it, which is how the staging
outage test below is run.

To dispatch:

```bash
gh workflow run uptime-check.yml --repo Synapse-bridgez/synapse-web -f url=https://staging.example.com
```

## Alerting

The workflow opens (and comments on) a single GitHub issue labelled
`uptime-alert` rather than paging anyone directly. That is deliberate: it is
reviewable, has a history, and needs no secrets wired into a third party.

To get paged, point the real alerting at that issue or at the endpoint from an
external monitor — see below.

> **One-time setup:** the `uptime-alert` label has to exist in the repository
> before the first failure, or `gh issue create` fails. Create it with:
> `gh label create uptime-alert --color B60205 --description "Automated dashboard uptime alerts"`

## Recommended: an external monitor as the primary signal

The issue's guidance is right that the alerting belongs to a synthetic-monitoring
service rather than a bespoke backend. The GitHub-scheduled job above is a
useful backstop, but GitHub Actions schedules are frequently delayed under load
and can be skipped entirely, so they are not a reliable heartbeat for page-worthy
outages.

Configure the service of your choice against:

- **URL:** `https://<deployment>/api/health`
- **Interval:** 5 minutes
- **Alert when:** HTTP status is not 200 (the app is down), **or** the JSON body's
  `rpc.reachable` is `false` (the provider is down)
- **Alert after:** 2 consecutive failures, to sit alongside the workflow's 3

UptimeRobot, BetterStack, and Checkly all support a JSON body assertion of this
shape, so no custom backend is needed.

## Verifying a deliberate outage

Both failure modes are covered by unit tests, and the staging test is a manual
step:

1. **App down** — point the endpoint at a stopped deployment, or block the host.
   Expect `app.reachable: false` and no `200` from the route.
2. **RPC down** — deploy with a deliberately unreachable endpoint, for example
   `NEXT_PUBLIC_SOROBAN_RPC_URL=https://127.0.0.1:1`, or point the host at a
   network that blackholes the provider. Expect `200` with
   `rpc.reachable: false` and `status: "degraded"`. This is the case that must
   _not_ read as "the site is down".
3. **Recovery** — restore the endpoint and confirm the next check reports
   `status: "ok"`.

The unit tests for the timeout path cover a hung endpoint, which is the case
that matters most: an unbounded wait would make a hung provider look identical
to a healthy one.

## What this does not do

- It does not replace a real provider SLA or an on-call rotation. It tells you
  something is wrong and which of the two things it is.
- It does not check the dashboard's _correctness_, only that it loads and can
  reach RPC. Rendering regressions are what the visual regression pipeline
  (issue #158) is for.
