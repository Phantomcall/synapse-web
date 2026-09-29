# Dependency vulnerability gate

Workflow: [`.github/workflows/dependency-audit.yml`](../../.github/workflows/dependency-audit.yml)
Gate logic: [`scripts/ci/audit-gate.mjs`](../../scripts/ci/audit-gate.mjs) (unit tests alongside)
Exceptions: [`.github/audit-allowlist.json`](../../.github/audit-allowlist.json)
Update PRs: [`.github/dependabot.yml`](../../.github/dependabot.yml)

## What blocks a merge

The gate runs `npm audit` twice, once for the production tree (`--omit=dev`) and
once for the full tree. Any advisory not in the production report counts as
dev-only.

| Scope                           | Fails at     | Why                                                                                                                                                                                             |
| ------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Production (`dependencies`)     | **high**+    | This code ships to users who connect wallets and sign transactions. Anything high or critical in the shipped tree has to be fixed or explicitly accepted.                                       |
| Dev-only (`devDependencies`)    | **critical** | Build and test tooling never reaches the browser. High advisories there are mostly ReDoS in CLI parsers, which would only add noise. Critical ones still block, because they can compromise CI. |
| Anything below those thresholds | never        | Still reported in the job summary, and Dependabot still opens PRs for them.                                                                                                                     |

The gate fails closed. If `npm audit` errors out (for example, the registry is
unreachable) or returns a report format it doesn't recognise, the job fails.

The workflow also runs daily on `main`, so an advisory published against code
that's already merged surfaces within a day. Otherwise it would sit unnoticed
until someone opened an unrelated PR.

## Making it required

In **Settings → Branches → `main` → Require status checks**, add
**`Dependency audit`**. In **Settings → Code security**, turn on **Dependabot
alerts** and **Dependabot security updates**. Security updates are the
mechanism that opens PRs for vulnerable _transitive_ dependencies.

## Exception process (no fix available yet)

Sometimes an advisory has no patched release, or the fix needs a larger upgrade
that deserves its own PR. In that case, add an entry to
`.github/audit-allowlist.json` in the same PR instead of disabling the gate:

```json
{
  "id": "GHSA-xxxx-xxxx-xxxx",
  "package": "some-package",
  "severity": "high",
  "reason": "Why this is acceptable for now, including whether the vulnerable code path is reachable.",
  "tracking": "https://github.com/Synapse-bridgez/synapse-web/issues/NNN",
  "expires": "YYYY-MM-DD"
}
```

Rules the gate enforces:

- `id`, `reason`, `tracking` and `expires` are required. A malformed entry
  fails the gate. It is never silently ignored.
- `package` is optional. When set, the exception covers the advisory only in
  that package.
- **Expiry is enforced.** Once `expires` passes, the entry stops applying and
  the build fails again, which forces a re-review instead of letting a
  permanent exception accumulate. Keep expiries to 30 days or less where
  practical.
- Exceptions that no longer match any advisory are listed as "unused" in the
  job summary. Delete them.
- The allowlist lives under `.github/`, so CODEOWNERS review applies to every
  change.

## Baseline exceptions

When the gate was introduced, `main` already carried 11 production advisories
at high or above. They are all allowlisted until **2026-10-31**:

| Package                              | Advisories                                | Resolution                                                                                                            |
| ------------------------------------ | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `next@16.2.6`                        | 2 critical, 4 high                        | Upgrade `next` and `eslint-config-next` to **>= 16.3.3**. This is a minor framework bump, so it should be its own PR. |
| `postcss`, `sharp` (inside `next`)   | 4 high                                    | Resolved by the same `next` upgrade.                                                                                  |
| `axios` (via `@stellar/stellar-sdk`) | 1 high (Node HTTP adapter proxy handling) | Wait for the upstream SDKs to ship a patched axios. The browser bundle uses the fetch/XHR adapter.                    |

The Next.js advisories cover the Image Optimization API, Server Actions,
rewrites, middleware, and custom or Windows-hosted servers. This app
prerenders statically and uses none of those, which is why a time-boxed
exception is acceptable here. The upgrade is still the fix.

## Verifying the gate

Unit tests (`npm run test`) cover threshold, scope, expiry and malformed-entry
behaviour. To reproduce the deliberate-regression check by hand:

```bash
npm install lodash@4.17.11 --package-lock-only
npm audit --omit=dev --json > prod.json; npm audit --json > full.json
node scripts/ci/audit-gate.mjs --prod prod.json --full full.json
# → fails: GHSA-jf85-cpcp-j695 (critical) and 3 high advisories in lodash
git checkout package.json package-lock.json
```
