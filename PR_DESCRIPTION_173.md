# Detect flaky tests, record the flake rate, and make quarantine expire

Retries are the standard way to stop one unlucky run from blocking unrelated
work, and they are also how a bug gets to hide: a test that fails once every
forty runs becomes a green checkmark forever. The issue asks for a retry budget
_and_ for the guarantee that "the tracked flake-rate history is what prevents
that, by surfacing chronic offenders for investigation rather than permanently
ignoring them."

This PR does both, and the second half is the point.

## What

| File                                      | Change                                                                                                                   |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `vitest.config.ts`                        | `retry: 2` (three attempts max) + the flake reporter registered alongside `default`. `FLAKE_RETRY` overrides.            |
| `scripts/test/flake-reporter.mjs`         | **New.** Per-test verdicts (`passed` / `flaky` / `failed` / `skipped`), a labelled CI summary, and a run record on disk. |
| `scripts/test/flake-history.mjs`          | **New.** Bounded per-test window, chronic-offender detection, the quarantine ledger, and a CLI.                          |
| `scripts/test/*.test.ts`                  | **New.** 63 tests over the two modules.                                                                                  |
| `docs/testing/QUARANTINE.md`              | **New.** The process, and when to quarantine rather than fix.                                                            |
| `docs/testing/flake-history.json`         | **New.** Seeded from a real run of the 94 tests in this repo, all clean.                                                 |
| `docs/testing/quarantine.json`            | **New.** Empty ledger, with a schema the loader enforces.                                                                |
| `.github/workflows/flake-history.yml`     | **New.** Nightly: runs the suite, folds the result in, opens a PR.                                                       |
| `.github/workflows/ci.yml`                | A `Check the flake history` step after `Test`.                                                                           |
| `package.json`, `README.md`, `.gitignore` | `test:flake-history` script, a short README section, ignore the run record.                                              |

## The four verdicts

`classify()` decides before it looks at retries:

```js
if (state === "failed") return "failed"; // outranks any retry count
if (state === "pending") return "skipped";
if (state === "passed" && retries > 0) return "flaky";
return "passed";
```

A test that is red after three attempts is a real failure, and is reported as
one. That ordering is the whole difference between "retry budget" and "retry
budget that launders bugs", and it is pinned by a test named for it.

The reporter agrees with vitest's own definition of flaky
(`retryCount > 0 && internal state "pass"`, from `ReportedTask#diagnostic`), so
the two reporters can never disagree about one test. There is a test asserting
exactly that, including the non-obvious detail that vitest's internal state
string is `"pass"` while the public `result().state` is `"passed"` — getting that
mapping wrong would report the opposite of what vitest says.

## Verification

### 1. A genuinely flaky test does not block the build, and is not quiet about it

Temporary fixture that fails on its first attempt and passes on its retry,
against the real config (`retry: 2`):

```
 ✓ lib/__flake_demo__.test.ts (1 test) 22ms
::warning file=lib/__flake_demo__.test.ts::FLAKY: demo > passes only after a retry passed only after 1 retry/retries. See docs/testing/QUARANTINE.md.
── flake report: FLAKY (green only after a retry) ──
   These did NOT fail the build, but each one is a real bug hiding behind a retry.
   ! lib/__flake_demo__.test.ts :: demo > passes only after a retry  (retried 1x)
   1 tests: 0 passed, 1 flaky, 0 failed, 0 skipped.
 Test Files  1 passed (1)
      Tests  1 passed (1)
--- exit code: 0
```

The `::warning` annotation is deliberate: it puts the flake on the pull request
itself, where the merge decision happens, instead of in a log someone has to go
looking for.

### 2. The truth is one env var away

Same fixture, `FLAKE_RETRY=0`:

```
── flake report: FAILED (still red after every retry — these DO block merge) ──
⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯
 Test Files  1 failed (1)
--- exit code: 1
```

A test that is green here and flaky above is a flake, by definition. The
history makes the first-attempt pass rate a number you can watch rather than a
mood, so `retry: 0` is a defensible setting for anyone who prefers it.

### 3. A genuinely broken test is not laundered by three attempts

```
── flake report: FAILED (still red after every retry — these DO block merge) ──
   x lib/__flake_demo__.test.ts :: demo > passes only after a retry  (attempted 3x)
⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯
--- exit code: 1
```

This is the property that matters most, and it is the one that a naive
`retryCount > 0 ? flaky : ...` would get wrong.

### 4. Ten runs, and the history escalates it

A test that flakes on runs 1, 2 and 3 and is clean on runs 4–10, folded into the
history after each run:

```
  run  1: window=1
  run  2: window=11
  run  3: window=111
  run  4: window=1110
  run  5: window=11100
  run  6: window=111000
  run  7: window=1110000
  run  8: window=11100000
  run  9: window=111000000
  run 10: window=1110000000

flake history: chronic offenders need a decision (see docs/testing/QUARANTINE.md)
   30%  lib/__flake_demo__.test.ts :: demo > passes only after a retry  — NOT quarantined
```

One character per run, `1` meaning "needed a retry". Bounded at 30, so the file
cannot grow without bound and a fixed test ages out.

### 5. What CI actually does with that

```
$ node scripts/test/flake-history.mjs --no-merge --enforce=1
flake history: chronic offenders need a decision (see docs/testing/QUARANTINE.md)
   30%  lib/__flake_demo__.test.ts :: demo > passes only after a retry  — NOT quarantined

  A retry keeps a flaky test from breaking unrelated work; it does not fix anything.
  Each of the above needs either a fix, or a quarantine entry with an owner, an issue and an expiry date.

::error::1 chronic offender(s) are not covered by an active quarantine. Fix the test, or add an entry to docs/testing/quarantine.json with an owner, a tracking issue and an expiry date.
--- exit code: 1
```

### 6. Quarantine works, and only for a bounded time

With an owner, an issue and an expiry:

```
   30%  lib/__flake_demo__.test.ts :: demo > passes only after a retry  — quarantined until 2026-10-10T00:00:00.000Z (@someone, #173)
--- exit code: 0
```

The **same** entry, evaluated after its expiry:

```
   30%  lib/__flake_demo__.test.ts :: demo > passes only after a retry  — quarantine EXPIRED 2026-10-10T00:00:00.000Z (@someone, #173)

  1 quarantined test(s) past their expiry date:
    lib/__flake_demo__.test.ts :: demo > passes only after a retry  expired 2026-10-10T00:00:00.000Z

::error::1 chronic offender(s) are not covered by an active quarantine.
--- exit code: 1
```

**There is no flag, setting or code path that makes a quarantine permanent.**
That is the mechanism the issue asks for: retry-masking cannot hide anything
forever, because the thing doing the hiding stops working on a date.

### 7. The guards are real, not decorative

Each of the four properties above was verified by breaking it and watching the
named test fail:

| Mutation                                                 | Test that caught it                                                             |
| -------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `classify`: let a retried failure return `flaky`         | `classify > calls a still-red test a failure however many times it was retried` |
| `isActive`: return `true` regardless of the expiry       | `quarantine > stops being satisfied once it expires — no flag can extend it`    |
| `mergeRun`: count a skipped test as a pass               | `mergeRun > contributes no observation for a skipped test`                      |
| `findChronicOffenders`: drop the `minObservations` floor | `does not flag a test on too little data, however bad the rate`                 |

The skipped-test mutation matters more than it looks: counting `it.skip` as a
pass would let a suite quietly stop testing itself while its flake rate
improved.

## Two bugs this found, and one correction

**`--no-merge` and `--enforce` were being silently dropped.** The CLI parsed
arguments with `/^--([\w-]+)=(.*)$/`, which only matches `--flag=value`. A bare
`--flag` did not match, was ignored, and the run was merged anyway. The demo
caught it because a rate that should have stayed at 30% kept falling: 27%, 25%,
23%, 21% across four invocations, each silently folding in another clean
observation. **In CI this would have meant `--enforce` doing nothing while the
job reported success** — the exact failure the issue is about. `parseArgs` now
handles both forms and rejects stray arguments instead of ignoring them, with
tests for each.

**`pathToFileURL(process.argv[1])` threw at import time** when `process.argv[1]`
was undefined, which broke `node -e` and any programmatic import. Now guarded.

**A correction to an earlier claim of mine:** this branch originally set
`retryDelay: 200`, and Vitest 3.2.7 has no such option — retries happen
immediately, and `tsc` rejected the key. I checked the source
(`@vitest/runner/dist/chunk-hooks.js`) rather than assuming a delay, and removed
it. The config comment and the doc now say what actually happens, and say why it
is fine for this suite: every test is a fast in-process unit test with no shared
external state for a retry to wait on.

## Decisions, in brief

**Two thresholds, not one.** A chronic offender needs at least **5** observations
_and_ a rate of **10%**. The rate alone would flag a test on its second ever
run; the observation floor alone would flag a test that flaked once and then
behaved for twenty runs. `min-observations` is the knob to raise if the list
gets noisy — the history needs more runs before it is entitled to complain.

**Failures do not count as flakes.** A test that is red every run is a broken
test, and a broken test already fails the build on its own. Counting it toward
the flake rate would dilute the signal the rate exists to carry. Failed
observations stay in the window, so the track record is complete, but the
numerator only counts `1`s.

**Skipped tests contribute no observation.** See above.

**The history is a PR, not an auto-commit.** The nightly job opens a pull
request when the file actually changes, and says so in the log when it does not.
A nightly that pushes to `main` unattended is a nightly nobody reviews, and one
that opens an empty PR every morning is a nightly everybody dismisses. The
branch name is reused per day and force-pushed, so a re-run does not accumulate
near-duplicate PRs.

**The ledger is validated on read, not just on write.** An entry missing an
owner, an issue or an expiry is rejected when the file is loaded. An incomplete
entry would create a quarantine nobody is accountable for, which is worse than no
quarantine at all.

**The reporter reads vitest's public reporter API** (`test.fullName`,
`test.result().state`, `test.diagnostic()`), and has a small `.mjs` run-record
writer rather than depending on `onFinished`'s deprecated shape.

**Seeded from a real run.** `flake-history.json` was produced by running the
suite in this repo and folding the result in: 94 tests tracked, all clean. Not a
hand-written file with invented numbers.

## Definition of done

- [x] `retry: 2` configured centrally, overridable via `FLAKE_RETRY`. A test still
      red after the last attempt fails the build exactly as before — shown above
      failing on a fixture that fails three times.
- [x] Clear CI output distinguishing flaky (retried, green) from real failure
      (still red, blocks merge): separate labelled sections, plus a `::warning`
      annotation on the PR for each flaky test.
- [x] Per-test flake-rate history, bounded, updated by CI nightly, PR-reviewed.
      Demonstrated over ten runs; window visible growing one character at a time.
- [x] A chronic offender needs a decision, not another retry: CI fails on an
      unquarantined offender, with an `::error::` that names the fix.
- [x] Quarantine process documented: required fields, when to quarantine rather
      than fix, anti-patterns, and a demonstrated expiry.
- [x] **A quarantine cannot be permanent.** No flag or code path extends one;
      shown failing after the expiry date, and mutation-tested.
- [x] 63 new tests; four mutations of the four load-bearing guards each caught by
      the test that names the guarantee.
- [x] Two genuine bugs found by the demonstration and fixed (argument parsing,
      `argv[1]` guard), both of which would have defeated enforcement in CI.
- [x] Full gate green; no `package-lock.json` churn.

## Not done, deliberately

**No auto-remediation.** A test that is chronically flaky does not get deleted or
skipped automatically. The ledger forces a human to choose between fixing it and
quarantining it with a name attached.

**No flake detection in the PR build itself.** The PR build enforces the policy
against the committed history; it does not merge this PR's own run into that
history, because two writers on one file race, and because a PR should not
rewrite the record it is being judged against. The nightly job is the single
writer (`concurrency` guards it as well).

**`format:check` is still failing on three pre-existing files** on `main`
(`.github/ISSUE_TEMPLATE/*.md`, `components/dashboard/StatCards.tsx`). Verified
against a clean tree, unrelated to this PR, and not part of the four CI gates.
Not touched, to keep this PR to the issue.

## Full gate

```
$ npm test        # 7 files, 94 tests passed (31 before this PR, 63 added)
$ npm run lint    # clean
$ npx tsc --noEmit # clean
$ npm run build   # ✓ Compiled successfully in 11.2s
$ git diff --exit-code -- package-lock.json # unchanged
```

closes #173
