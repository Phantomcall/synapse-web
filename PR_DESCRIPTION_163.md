# feat(ci): browsable per-PR Lighthouse reports with base-branch comparison (#163)

## The problem

A Lighthouse gate tells a reviewer _whether_ a threshold was crossed. It does not
tell them _what_ regressed. The acceptance criteria for this issue are
specifically about the second thing: a full browsable report covering all four
categories, linked from the PR, with a historical comparison against the base
branch.

There is also a trap in this particular repo that is worth calling out, because
the naive implementation of "per-route breakdowns for a multi-tab SPA-like app"
produces something that looks right and is worthless.

**The app had exactly one URL.** `components/Shell.tsx` kept the selected tab in
React state, so `/` served all four tabs. Auditing `/` four times and labelling
the four results "dashboard / transactions / admin / docs" is four _identical_
measurements wearing four different names. It would produce a report with
per-route rows, a per-route table, and a per-route base-branch delta — and every
number in it would be the same measurement of the dashboard. That is a hollow
deliverable that actively misleads, because it looks like coverage.

So this PR does two things: it builds the reporting pipeline, and it makes the
tabs genuinely addressable so the per-route numbers are real.

## What I built

| File                               | Purpose                                                                     |
| ---------------------------------- | --------------------------------------------------------------------------- |
| `lighthouserc.js`                  | `@lhci/cli` config: route list, run count, upload target, assertions.       |
| `.github/workflows/lighthouse.yml` | Matrix audit of PR + base, artifact upload, browsable report, PR comment.   |
| `scripts/lighthouse-report.mjs`    | Builds `index.html` (browsable), `summary.md` (the table), and the diff.    |
| `lib/tabs.ts` + `lib/tabs.test.ts` | Tab registry; each tab becomes a real static route segment.                 |
| `app/[tab]/page.tsx`               | Prerenders one static page per tab.                                         |
| `components/Shell.tsx`             | Derives the selected tab from the URL instead of duplicating it in state.   |
| `README.md`                        | Local reproduction steps; "adding a new tab" now points at the real source. |

### Per-route, not per-label

`app/[tab]/page.tsx` prerenders `/dashboard`, `/transactions`, `/admin` and
`/docs` as separate static pages, so each is a real document with its own HTML
and its own Lighthouse measurement.

I deliberately did **not** use a `?tab=` query parameter. `useSearchParams()` in
a statically prerendered page either fails the build without a Suspense boundary
or forces the page dynamic — and a dynamic page would add server round-trip
latency to the very first paint the budgets exist to protect. Route segments stay
static and hydrate cleanly.

`Shell` now derives the tab from `usePathname()` instead of copying it into
`useState`. That is smaller than the state version _and_ strictly better:
back/forward navigation works with no sync effect, a reload restores the tab, and
the server and client renders always agree because both read the same pathname.
I wrote the `useState` + `useEffect` sync version first; ESLint's
`react-hooks/set-state-in-effect` correctly flagged it, and dropping the state
turned out to be the better design rather than a workaround.

### Base-branch comparison

The `audit` job is a matrix over two refs: the PR merge commit and the base SHA.
Both are measured with the **same** `lighthouserc.js` — a comparison across
different configs is not a comparison. The base job therefore restores
`lighthouserc.js` and `scripts/lighthouse-report.mjs` from the PR head while
keeping the base branch's app source, because the base branch does not contain
those files (this PR introduces them) and, more importantly, because measuring
both sides with one config is the only way "before vs after" means anything.

`scripts/lighthouse-report.mjs` then diffs the two manifests and renders per
route, per category, in score points. It also flags the two failure modes a
naive diff gets wrong: a route that exists on the base but not in the build
(removed or renamed), and a route with no baseline (rendered as `new` rather
than a misleading delta).

### Why the artifact, not a public URL

`upload.target` is `filesystem` and the report ships as a workflow artifact. The
alternatives were rejected deliberately, and the migration path is written out in
`lighthouserc.js`:

- `temporary-public-storage` publishes reports to a public URL on a third party.
  These reports contain audited route names and build metadata; that is the
  team's call, not this file's.
- A self-hosted LHCI server gives cross-run history for free but needs
  infrastructure the repo does not own.

The honest limitation, stated plainly: **GitHub artifacts sit behind a login**,
so the PR comment is not a publicly browsable link. It inlines the comparison
table (so the useful part needs no click) and links to the run page where the
artifact is downloadable. The commented block in `lighthouserc.js` shows exactly
which three lines to change once the team has an LHCI server, and notes which
workflow steps to drop when the server's own history endpoint replaces the
base-branch job.

## Verification

I ran the real pipeline locally against a production build, because the bugs I
found in the first version would all have been invisible in a config file:

```bash
npm run build
npx next start --port 4111
CHROME_PATH=/usr/bin/google-chrome npx @lhci/cli@0.14.0 autorun --config=lighthouserc.js
node scripts/lighthouse-report.mjs .lighthouseci/manifest.json "" .lighthouseci/report
```

`autorun` completed cleanly: **12 Lighthouse runs (4 routes × 3 runs), exit 0**,
all assertions passing. Real per-route scores, which are the point of the whole
exercise — they are genuinely different numbers, not four copies:

| Route           | Performance | Accessibility | Best Practices | SEO |
| --------------- | ----------- | ------------- | -------------- | --- |
| `/dashboard`    | 96          | 96            | 100            | 100 |
| `/transactions` | 92          | 96            | 100            | 100 |
| `/admin`        | 94          | 96            | 100            | 100 |
| `/docs`         | 96          | 95            | 100            | 100 |

I also confirmed directly against the running server that each route serves
HTTP 200 with a distinct document and the _correct_ tab server-rendered
(`aria-selected="true"` on the right button for each of the five URLs, `/`
included), and that an unknown segment returns 404.

Then I tested the degraded paths, because a reporting job that only works on the
happy path is not useful:

- **Base branch 404s** (the real bootstrap case — the base has no `/[tab]`
  segment): `autorun` exits 1, writes **no manifest**, and the report script
  degrades to absolute scores with a "no baseline" note. This is precisely why
  the base job carries `continue-on-error: true`; without it, the PR that
  introduces tab routes would fail on its own baseline.
- **Deltas against a real-shaped baseline:** per-route per-category deltas
  render, colour red/green/grey, a route missing from the base renders as `new`,
  and a base-only route is called out as removed-or-renamed.
- **Failed run / malformed manifest:** surfaced as a named failure row and a
  non-zero exit, never as a row of confident zeroes.
- **Legacy manifest shape** (bare array, top-level scores): still handled.

The full suite on this branch:

```
npm run test        # 31 baseline + 13 new = 44 tests pass across 6 files
npm run lint        # clean
npx tsc --noEmit    # clean
npm run build       # succeeds; /[tab] prerenders 4 static pages
```

`lib/tabs.test.ts` includes a drift guard: it reads `lighthouserc.js` and fails
if the audited route list does not match `TAB_ROUTES`, so a new tab cannot ship
without being audited.

## Three bugs this found, which config review would not have

Recording these because they are the reason to actually run the thing.

1. **Scores were never read.** LHCI 0.14 puts category scores under `run.summary`,
   marks the representative run with `isRepresentativeRun` (not
   `isRepresentative`), and writes `htmlPath` as a bare path rather than a
   `file://` URL. My first version read `run.performance` and would have
   rendered a report full of em dashes — plausible, green, and empty.
2. **All four reports collapsed into one file.** I set
   `reportFilenamePattern: "%%SLUG%%-report.%%EXTENSION%%"`. There is no
   `%%SLUG%%` token; the supported ones are `%%HOSTNAME%%`, `%%PATHNAME%%`,
   `%%DATETIME%%`, `%%EXTENSION%%`. Every run resolved to `unknown-report.html`,
   so the per-route "open full report" links all pointed at the last run. The
   default pattern already does the right thing, so the line is now gone with a
   comment explaining why it must not come back.
3. **The config was silently a blocking gate.** I had
   `preset: "lighthouse:recommended"`, which reads as harmless but contributes
   many `error`-level assertions — the first real run failed on
   `max-potential-fid` with every score assertion set to `warn`. The preset is
   removed and every assertion is spelled out, because the gate is explicitly the
   other issue's scope.

Also worth noting: `lhr-runtime-error` is not a real audit id. LHCI rejects
unknown assertion names loudly rather than ignoring them, which is good, but it
means the guard list is short and explicit.

## Acceptance criteria

- [x] **Full Lighthouse report (all four categories) published as a browsable
      artifact per PR, not just a numeric gate.** `report/index.html` is a
      browsable index — one card per route, all four category scores, per-category
      deltas, and a link into that route's full Lighthouse HTML. Uploaded as the
      `lighthouse-report` artifact; verified locally end to end.
- [x] **Historical comparison against the base branch's score for the same
      route.** The `audit` matrix audits the base SHA with the identical config and
      the report script diffs the two manifests per route per category. Verified
      against a real-shaped baseline and against the real no-baseline path.
- [x] **Per-route breakdowns for a multi-tab SPA-like app, not a single
      aggregate score.** Each tab is a separately prerendered route and is audited
      and reported independently; the measured scores differ per route, proving the
      runs are distinct.
- [x] **Not just pass/fail.** Score assertions are `warn`, so they annotate
      without blocking. The only `error` assertion is `http-status-code`, which
      exists so a 404 route cannot post a plausible-looking score — not a gate.
- [x] **Out of scope: the pass/fail gating logic itself.** Not implemented; the
      `assert` block is warn-only by design and the comment says so.
- [ ] **Verified on a real PR showing a full linked report with base-branch
      comparison.** The workflow is unrun — it needs a real PR against
      `Synapse-bridgez/synapse-web` to trigger it. I verified every stage locally
      against a real production build (collect, upload, report generation, both
      degraded paths), but I have not observed the GitHub Actions run itself, the
      artifact upload, or the PR comment landing. Those need the team to merge and
      push a follow-up PR, or to let this one run.
- [ ] **A publicly browsable report link.** GitHub artifacts require a login, so
      the comment links to the run page and inlines the table. A public link
      requires a self-hosted LHCI server; the exact three-line change and the two
      workflow steps to drop are documented in `lighthouserc.js`.

### Notes for review

- **The one part of this diff that touches app behaviour is the tab deep
  linking.** I judged it in scope because the issue explicitly asks for per-tab
  breakdowns and there is no other honest way to produce them, but it is worth a
  reviewer's attention on its own merits. It is additive — `/` still works and
  still shows the dashboard — and the four pages are statically prerendered, so
  there is no SEO or TTFB regression. If you would rather keep this PR to
  plumbing, the tab routes and the `Shell` diff can be split out and the
  reporting pipeline still works against `/` alone, just without per-tab rows.
- **No new dependencies.** `@lhci/cli` is pinned via `npx @lhci/cli@0.14.0`
  rather than added to `package.json`, which keeps this out of
  `package-lock.json` and avoids conflicting with the other issues in this wave
  that touch it. Pinned rather than floating deliberately: an unpinned LHCI
  release can change scoring between two runs of the same commit, which would
  surface as a regression that never happened.
- **The first run after merge will have no baseline**, because the base branch
  will not have `/[tab]`. That is handled and labelled in the comment, not
  hidden. Subsequent PRs get real deltas.
- **Mobile/throttled auditing is not enabled.** It needs Lighthouse throttling,
  which makes each run roughly 4× slower; the config comment says which two
  settings to flip together if the team wants it.

Related: #161 (the Lighthouse CI gate) owns the blocking thresholds; this issue
is the reporting layer on top of it. #162 (alerting) sets Web Vitals thresholds
that are intentionally aligned with the budgets here so the two do not disagree.

closes #163
