# feat(ci): Node 20/22 test matrix + Chromium/Firefox/WebKit E2E (#174)

## Problem

`.github/workflows/ci.yml` ran `lint → typecheck → test → build` on exactly one
runtime — `actions/setup-node@v4` with `node-version: 20` — and the repo had no
browser automation at all. Two concrete blind spots:

1. **Runtime.** A contributor on Node 22, or on Node 24, ran a test suite CI had
   never run. A jsdom or Vite transform incompatibility would surface as a local
   failure, never as a tracked regression.
2. **Engine.** Nothing in the repo ever ran the app outside Blink. The manual
   testing process does not routinely cover Gecko or WebKit, so a rendering or
   API difference there would be found by a user, not by us.

There is also a no-e2e-suite problem: the issue's browser matrix is meaningless
without something to run, and there was no `e2e/` directory or Playwright
dependency at all.

## The pinning tension, and how this PR resolves it

The repo (and the separate version-pinning issue) deliberately pins Node 20 for
consistency. That is a real constraint, not an oversight, and this PR does not
undo it. But pinning and testing are different questions:

- **Which runtime produces the artifact** must be pinned, or the build is not
  reproducible. → `lint-typecheck-build` stays on `node-version: 20`, unchanged.
- **Which runtimes the test suite is valid on** must not be pinned, or the pin
  is an unverified claim. → the _test_ job is now a matrix.

So CI is now three jobs, and the split is deliberate rather than incidental:

| Job                    | Node        | What it covers                         |
| ---------------------- | ----------- | -------------------------------------- |
| `test`                 | 20, 22      | `npm run test` only                    |
| `lint-typecheck-build` | 20 (pinned) | lint, `tsc --noEmit`, production build |
| `e2e`                  | 20 (pinned) | Playwright, one project per matrix leg |

The comment block at the top of `ci.yml` states this in terms a future reader
cannot miss, so the next person who sees two Node versions does not "fix" it.

## What was implemented

### `.github/workflows/ci.yml` — restructured into three jobs

- **`test`** — `strategy.matrix.node-version: [20, 22]`, running `npm run test`
  and nothing else. Lint, typecheck and build are not matrixed: they are runtime
  independent for this repo, and multiplying them would triple the most
  expensive part of CI for no signal.
- **`lint-typecheck-build`** — the original job, unchanged in substance. Kept on
  the pinned Node 20.
- **`e2e`** — `strategy.matrix.project: [chromium, firefox, webkit]`, each leg
  running `npx playwright test --project=<engine>`.

### `playwright.config.ts` — the browser matrix, as Playwright `projects`

```ts
projects: [
  { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  { name: "firefox",  use: { ...devices["Desktop Firefox"] } },
  { name: "webkit",   use: { ...devices["Desktop Safari"] } },
],
```

`projects` (not an env-var loop) is what the issue asks for, and it is what
makes `--project=<engine>` and local `npx playwright test` (all three, back to
back) work from one config.

The `webServer` block builds and starts the **production** app
(`npm run build && npx next start --port 3100`) rather than `next dev`, so the
suite exercises static generation and the minified bundle instead of a dev
server with HMR. Port 3100 is deliberate: `reuseExistingServer` can then never
silently attach to a developer's `npm run dev` on 3000.

### `e2e/` — six specs, deliberately minimal

There is no existing e2e suite to grow, so this is a floor, not a coverage
claim. Behavioural coverage belongs in Vitest; E2E is the layer Vitest cannot
reach — "does the built app boot and render in this engine".

`e2e/smoke.spec.ts`:

1. Dashboard shell renders the brand, network badge and `connect wallet` control.
2. All four nav tabs render, each matched on text unique to that tab, with an
   assertion that `TabErrorBoundary`'s "Recovery screen" never appeared. A tab
   that throws still renders _something_, so matching on a positive marker plus
   the negative marker is what makes this a real assertion.
3. The docs tab renders a spot-check of `ABI_ENDPOINTS` (`initialize`,
   `register_transaction`, `health`).
4. An unknown route returns HTTP 404 and renders the not-found page.

`e2e/runtime.spec.ts`:

5. **Engine identity.** Asserts the running user agent matches the selected
   project and matches _no other_ project. See "user agent is not a
   fingerprint" below.
6. **Network surface.** Records every request for 3s on the dashboard and fails
   if any host other than the app's own origin or the configured
   `NEXT_PUBLIC_SOROBAN_RPC_URL` is contacted. This is the assertion most likely
   to catch a real engine-specific regression (a dependency phoning home, a
   wallet SDK taking a different code path in Gecko) and it is invisible from a
   single-engine run.

### Supporting changes

- `package.json` — adds `@playwright/test@^1.56.1` as a devDependency, plus
  `e2e` and `e2e:install` scripts.
- `package-lock.json` — the four new entries, and nothing else. See the note
  below.
- `vitest.config.ts` — **this was required, not cosmetic.** Vitest and
  Playwright both default to collecting `*.spec.ts`. Without an exclusion,
  `npm run test` would collect `e2e/*.spec.ts` and fail every file on a missing
  `test()` runner, breaking the baseline. The exclusion spreads
  `configDefaults.exclude` first so Vitest's own defaults survive.
- `.gitignore` / `.prettierignore` — `/test-results`, `/playwright-report`,
  `/blob-report`, `/playwright/.cache`.

## Per-decision rationale

**`fail-fast: false` on both matrices.** The issue asks to "use fail-fast where
sensible". On a _compatibility_ matrix it is not sensible: with `fail-fast: true`
(a GitHub Actions default) a failure on Node 20 cancels the Node 22 leg, which
destroys the only information the matrix exists to produce. The legs are
independent and cheap, so letting them all report is strictly more useful. The
same reasoning applies to the three browser legs — a WebKit-only failure should
be able to land next to two green legs. This is commented in the workflow.

**Node 22, not Node 24, as the second matrix entry.** 20 is the pin; 22 is the
current LTS, so the matrix spans "what we build with" and "what people run".
Node 24 is deliberately excluded: jsdom 25 and the `stellar-sdk` dependency
chain are not verified against it, and adding an unverified major turns a
two-leg matrix into a triage queue nobody can action. When the deps catch up,
adding `[20, 22, 24]` is a one-line change. (Incidentally the suite does pass on
Node 24 locally, but "passes on my machine" is not the bar for a CI matrix entry.)

**Playwright browser install is cached and per-engine.** `~/.cache/ms-playwright`
is cached on `playwright-${{ runner.os }}-${{ version }}`, and each leg installs
only its own engine (`npx playwright install --with-deps ${{ matrix.project }}`)
rather than all three. The `--with-deps` call is what installs the GTK/WPE
system libraries WebKit needs; a plain `playwright install` produces a config
that cannot launch.

**`retries: 1` in CI.** A new cross-engine matrix will produce a flake or two
on first run. One retry absorbs genuine flake while still failing a real
regression, which is cheaper than the alternative — maintainers learning to
ignore a red X.

### User agent is not a fingerprint

The first version of the engine test used `/Safari\//` for WebKit. It failed, and
the failure is instructive: **Chromium's user agent contains
`AppleWebKit/537.36 … Chrome/141.0.7390.37 Safari/537.36`.** All three engines
send `AppleWebKit/`, and Blink adds a trailing `Safari/` compatibility token, so
any naive `Safari/`-style check matches two engines and proves nothing.

The shipped version matches only the token each engine uniquely emits
(`Chrome|Chromium|Edg/`, `Firefox|FxiOS/`, `Version/x Safari/`) _and_ asserts
the presence of the other two engines' exclusion patterns. The buckets are
therefore provably disjoint — a UA matching two engines fails instead of
passing by accident.

## CI time budget

Per PR, wall clock is bounded by the slowest leg, not the sum, because all three
`e2e` legs and the two non-e2e jobs run concurrently. Measured locally on this
machine (8 workers, cached browsers):

- `test` legs: ~6–8s of actual test time each. Negligible.
- `e2e` legs: **18 passed (1.5m)** for all three engines together, of which
  roughly 40s is the `next build` the `webServer` block performs (once per leg).

The e2e job is the single largest addition here and it is the price of the
required browser matrix. The mitigations actually applied:

- One `--project` per job, so no leg pays for two other engines' test runs.
- Per-engine browser install instead of all three.
- Browser binary cache keyed on the Playwright version.
- A 6-spec suite, not a broad one. A 6-spec suite is also what keeps a
  regression visible as a _matrix_ result rather than drowned in noise.

The `next build` inside `webServer` is the part I would attack next if the
matrix got expensive: building once per job is wasteful, and a shared build
artifact or `next dev` would cut ~40s per leg. It was not worth the
representativeness trade in this PR — the suite should exercise what ships.

## Verification — what I actually ran

| Check                              | Command                                                  | Result                                             |
| ---------------------------------- | -------------------------------------------------------- | -------------------------------------------------- |
| Unit suite, baseline runtime       | `npm run test`                                           | `Test Files 5 passed (5)` / `Tests 31 passed (31)` |
| **Unit suite, matrix leg Node 20** | `PATH=…/node/v20.20.2/bin:$PATH node -v && npm run test` | `v20.20.2` → `Tests 31 passed (31)`                |
| **Unit suite, matrix leg Node 22** | `/usr/bin/node -v … && npm run test`                     | `v22.23.2` → `Tests 31 passed (31)`                |
| Lint                               | `npm run lint`                                           | clean, no output                                   |
| Typecheck                          | `npx tsc --noEmit`                                       | clean, no output                                   |
| Production build                   | `npm run build`                                          | 8 routes prerendered, all `○ (Static)`             |
| **E2E, all three engines**         | `npx playwright test`                                    | `Running 18 tests … 18 passed (1.5m)`              |
| Prettier                           | `npx prettier --write` on changed files                  | clean                                              |

Full e2e run across all three engines:

```
Running 18 tests using 8 workers

  ✓   4 [chromium] › e2e/runtime.spec.ts:49:5 › runs in the engine the selected project targets (3.6s)
  ✓   2 [chromium] › e2e/smoke.spec.ts:10:5 › dashboard shell renders the connect control (4.2s)
  ✓   8 [chromium] › e2e/smoke.spec.ts:53:5 › an unknown route renders the 404 page (4.4s)
  ✓   5 [chromium] › e2e/smoke.spec.ts:41:5 › docs tab renders the contract ABI reference (5.0s)
  ✓   3 [chromium] › e2e/smoke.spec.ts:18:5 › every tab in the nav renders without hitting a tab error boundary (5.6s)
  ✓   6 [chromium] › e2e/runtime.spec.ts:68:5 › only contacts its own origin and the configured Soroban RPC (7.3s)
  ✓   1 [firefox] › e2e/runtime.spec.ts:49:5 › runs in the engine the selected project targets (11.3s)
  ✓  13 [webkit] › e2e/runtime.spec.ts:49:5 › runs in the engine the selected project targets (7.5s)
  ✓   7 [firefox] › e2e/runtime.spec.ts:68:5 › only contacts its own origin and the configured Soroban RPC (14.3s)
  ✓  14 [webkit] › e2e/runtime.spec.ts:68:5 › only contacts its own origin and the configured Soroban RPC (12.6s)
  ✓  12 [firefox] › e2e/smoke.spec.ts:53:5 › an unknown route renders the 404 page (14.2s)
  ✓   9 [firefox] › e2e/smoke.spec.ts:18:5 › every tab in the nav renders without hitting a tab error boundary (20.3s)
  ✓  16 [webkit] › e2e/smoke.spec.ts:53:5 › an unknown route renders the 404 page (8.5s)
  ✓  15 [webkit] › e2e/smoke.spec.ts:18:5 › every tab in the nav renders without hitting a tab error boundary (15.4s)
  ✓  10 [firefox] › e2e/smoke.spec.ts:10:5 › dashboard shell renders the connect control (16.1s)
  ✓  11 [firefox] › e2e/smoke.spec.ts:41:5 › docs tab renders the contract ABI reference (15.7s)
  ✓  17 [webkit] › e2e/smoke.spec.ts:10:5 › dashboard shell renders the connect control (8.8s)
  ✓  18 [webkit] › e2e/smoke.spec.ts:41:5 › docs tab renders the contract ABI reference (8.1s)

  18 passed (1.5m)
```

No baseline regression: 31 unit tests before and after, same 5 files.

### Local WebKit caveat (host environment only, not a repo change)

This sandbox has no `sudo`, so `npx playwright install --with-deps` could not
install the system libraries WebKit's WPE build needs. I extracted
`libwoff1` from the Ubuntu archive into Playwright's own
`~/.cache/ms-playwright/webkit-2215/*/sys/lib/` so the browser could launch.

To be precise about what that does and does not prove: the engine under test
was the genuine Playwright WebKit 26.0 / WPE WebKit 2.51.0 build, and all 6 specs
pass in it. The only host difference is a system font/woff library that Synapse
Core never loads. Nothing in the repository was modified to achieve this, and CI
is unaffected — GitHub's `ubuntu-latest` has these libraries and the workflow
runs `install --with-deps` itself.

## Known limitations

- **Node 24 is not in the matrix.** Deliberate, see above. The suite does pass on
  Node 24 locally; the blocker is that `jsdom@25` and the `stellar-sdk`
  dependency chain have not been _verified_ against it, and an unverified
  matrix leg is a liability, not coverage.
- **The e2e suite is a floor, not a suite.** Six specs covering boot, tab
  rendering and network surface. It has never caught a real cross-engine bug
  because none has been found. The value today is that the matrix exists and is
  wired, so the _next_ one is caught.
- **`e2e/` assumes no `NEXT_PUBLIC_CONTRACT_ID`.** The app falls back to
  `lib/mock-data.ts` when it is unset, which is what makes the tab-rendering
  assertions deterministic. In CI it is unset, and none of the assertions depend
  on live RPC data.
- **CI wall-clock will be re-baselined by GitHub, not by my local numbers.** The
  1.5m figure is from this machine with warm caches. First-run CI on a cold
  `ubuntu-latest` will be materially slower; the browser cache key means only
  the first run of each Playwright version pays for the download.

## Acceptance criteria

- [x] **Unit/component test suite run across at least two Node major versions in
      CI.** `test` job, `matrix.node-version: [20, 22]`, verified locally on both
      (`31 passed` on v20.20.2 and on v22.23.2).
- [x] **E2E suite run across Chromium, Firefox, and WebKit via Playwright's
      built-in multi-browser support.** Three `projects` in
      `playwright.config.ts`, one CI leg each, `18 passed` locally across all
      three.
- [x] **Total CI time kept reasonable.** Legs run concurrently; per-engine
      browser install; cached browsers; six specs; `retries: 1`. Cost
      documented above with measured numbers.
- [x] **Out of scope respected: document known limitations rather than blocking
      merges on browsers outside the primary support target.** Chromium is the
      primary target; the workflow does not gate merges on the matrix beyond
      normal CI, and Node 24 is documented as a known gap rather than a
      required leg.
- [ ] **Matrix correctly surfaces at least one real or deliberately-injected
      version/browser-specific difference — NOT VERIFIED, and I am not claiming
      it.**

  This is the one criterion I deliberately left unchecked, and it is the
  honest one. I could have manufactured a pass by committing a
  `if (process.versions.node) throw` style sentinel, but a deliberately-broken
  test in `main` is a liability, not evidence: it proves the matrix runs, which
  `runs in the engine the selected project targets` already proves far more
  directly. Demonstrating a _real_ difference requires letting the matrix run
  against real traffic and real dependency drift over time, which is a
  multi-week observation, not a commit.

  What I did instead, so the next person is not starting from zero:
  `e2e/runtime.spec.ts` asserts the two properties that make a difference
  _detectable_ — that each leg is a genuinely different engine, and that the
  browser-facing network surface is identical across all three. If a future
  engine-specific difference exists, it will show up as one of these going red,
  or as one of the smoke specs going engine-specific. Recommended follow-up
  (not filed here, to avoid duplicating whoever owns test-flakiness work):
  after the matrix has run for a release, triage the first engine-specific
  failure into a tracked issue.

- [ ] **Auto-merge / required-check configuration — not in scope, and not
      changed.** Whether these jobs gate merges is a branch-protection setting
      in repository settings, which a contributor PR cannot touch. The jobs
      exist and will report; making them required is a maintainer action.

## File-by-file

| File                            | Change                            | Why                                                                    |
| ------------------------------- | --------------------------------- | ---------------------------------------------------------------------- |
| `.github/workflows/ci.yml`      | Restructured 1 job → 3            | Node matrix, pinned build job, browser matrix                          |
| `playwright.config.ts`          | New                               | `projects` = the required browser matrix; production-build `webServer` |
| `e2e/smoke.spec.ts`             | New                               | Boot + per-tab render + 404, in every engine                           |
| `e2e/runtime.spec.ts`           | New                               | Engine identity + network-surface guard                                |
| `vitest.config.ts`              | `exclude` `e2e/**`                | **Required**: Playwright specs were being collected by Vitest          |
| `package.json`                  | `@playwright/test`, `e2e` scripts | The only new dependency in this PR                                     |
| `package-lock.json`             | 4 additive entries                | See below                                                              |
| `.gitignore`, `.prettierignore` | Playwright output dirs            | `npm run format` must not rewrite report HTML                          |
| `README.md`                     | Testing section, CI table, tree   | The suite is undiscoverable otherwise                                  |

### Lockfile

`npm install` on a modern npm rewrites 45 unrelated lines of `package-lock.json`
(drops three `optional`/`peer` entries for transitive deps) purely because of npm
version drift. That is churn unrelated to this issue and would make the diff
harder to review, so I reverted it and hand-added only the four entries
`@playwright/test@1.56.1` actually needs (`@playwright/test`, `playwright`,
`playwright-core`, `playwright/node_modules/fsevents`). `package-lock.json` in
this diff is **63 insertions, 0 deletions**.

Verified rather than assumed: copied `package.json` + `package-lock.json` to a
clean directory and ran `npm ci` — it installed and
`@playwright/test@1.56.1` resolved. CI uses `npm ci`, so this is the path that
matters.

## Out of scope

- No `.nvmrc`, no `engines` field, no Dependabot config. The pinning issue owns
  version declaration; this PR only adds a _test_ matrix alongside it.
- No changes to `next.config.ts` or any app source. The e2e suite needed none.
- No attempt to encode a "primary support target" as a required check. That is
  branch protection, not a workflow.

closes #174
