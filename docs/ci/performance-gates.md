# Bundle-size and Lighthouse CI gates

Workflow: [`.github/workflows/performance.yml`](../../.github/workflows/performance.yml)
Bundle budget: [`bundle-budget.json`](../../bundle-budget.json), [`scripts/ci/bundle-budget.mjs`](../../scripts/ci/bundle-budget.mjs)
Lighthouse: [`lighthouserc.js`](../../lighthouserc.js)

## Bundle budget

After `next build`, the gate measures gzipped (level 9) sizes:

| Metric          | What it covers                                                        | Baseline | Budget |
| --------------- | --------------------------------------------------------------------- | -------: | -----: |
| `/` initial JS  | every `/_next/static/*.js` the prerendered `/` HTML loads up front    | 339.3 KB | 360 KB |
| `/` initial CSS | stylesheets the same HTML loads                                       |   2.7 KB |   8 KB |
| Total client JS | every chunk under `.next/static/chunks`, including lazily loaded ones | 356.9 KB | 380 KB |
| Largest chunk   | the single largest client chunk, which catches one heavy dependency   |  69.2 KB |  80 KB |

The gate reads the prerendered HTML rather than a build manifest, because
webpack and Turbopack (Next 16's default) write different manifest formats. To
budget a new static route, add it under `routes` in `bundle-budget.json`. The
gate fails if a budgeted route wasn't prerendered, so a typo can't silently
pass.

**Raising a budget** is a normal change to `bundle-budget.json` in the PR that
needs the headroom. Say in the PR description what was added and why.

## Lighthouse CI

`@lhci/cli` (pinned, run through `npx`) audits each key route **5 times** and
asserts against the **median run** (`aggregationMethod: "median-run"`). One
slow run on a noisy shared runner therefore can't fail the build.

| Category / metric        | Threshold | Baseline median |
| ------------------------ | --------: | --------------: |
| Performance              |    ≥ 0.90 |             100 |
| Accessibility            |    ≥ 0.95 |  96 (see below) |
| Best practices           |    ≥ 0.90 |             100 |
| SEO                      |    ≥ 0.95 |             100 |
| Largest Contentful Paint | ≤ 2500 ms |         ~620 ms |
| Total Blocking Time      |  ≤ 300 ms |            0 ms |
| Cumulative Layout Shift  |    ≤ 0.10 |               0 |

The baseline was measured with the desktop preset on a local production build
(`next start`). The metric ceilings are the Core Web Vitals "good" boundaries.
TBT stands in for INP, which a lab run can't measure. The one pre-existing
accessibility failure is `color-contrast`. Fixing baseline findings is out of
scope for #155 and tracked as follow-up.

### Which deployment is audited

| Job                         | Runs on                                           | Target                                                              |
| --------------------------- | ------------------------------------------------- | ------------------------------------------------------------------- |
| **Lighthouse CI**           | every PR and push to `main`                       | the PR's own production build, served by `next start` on the runner |
| **Lighthouse CI (preview)** | `deployment_status` = success, non-production env | the preview URL the hosting platform reports                        |

The preview job is how the gate runs "against the PR's preview deployment".
It works with any host that reports GitHub deployments, which Vercel's Git
integration does out of the box. Until preview deployments (#152) are live,
the local-build job enforces the same thresholds against the same code, so the
gate is useful from day one. If previews sit behind Vercel Deployment
Protection, add the `VERCEL_AUTOMATION_BYPASS_SECRET` repository secret.

Full HTML/JSON reports for every run are uploaded as the
`lighthouse-reports-<sha>` workflow artifact.

## Making it required

In **Settings → Branches → `main` → Require status checks**, add **`Bundle
budget`** and **`Lighthouse CI`**. Once #152 lands, also add **`Lighthouse CI
(preview)`**.

## Deliberate-regression verification

On a local branch, `components/Shell.tsx` was changed to import ~150 KB of
incompressible data and block the main thread for 600 ms at module load. After
a rebuild:

```
Bundle budget   ❌  / initial JS 489.0 KB > 360.0 KB, total JS 506.5 KB > 380.0 KB,
                    largest chunk 161.0 KB > 80.0 KB
Lighthouse CI   ❌  categories.performance 0.77 < 0.9 (all 3 runs),
                    total-blocking-time 541.5 ms > 300 ms
```

Reverting the change brought both gates back to passing.

Reproduce it locally:

```bash
npm run build && node scripts/ci/bundle-budget.mjs
CHROME_PATH=$(which google-chrome) npx @lhci/cli@0.15.1 autorun
```
