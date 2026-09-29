# Flaky tests: detection, history, and quarantine

`npm test` passes a test that fails once and succeeds on a retry. That is the
point of the retry budget, and it is also a hole: a test that fails one run in
forty is not fixed, it is merely quiet, and a quiet failure is the hardest kind
to notice.

This document describes how a retried test is noticed, recorded, and eventually
made to answer for itself.

## The three verdicts

`scripts/test/flake-reporter.mjs` runs as a Vitest reporter alongside the
default one. It gives every test one of four verdicts:

| Verdict   | Meaning                                | Blocks merge?                   |
| --------- | -------------------------------------- | ------------------------------- |
| `passed`  | Green on the first attempt             | no                              |
| `flaky`   | Failed at least once, green by the end | no — but recorded and annotated |
| `failed`  | Still red after every retry            | **yes**, exactly as before      |
| `skipped` | Never ran (`it.skip`, or filtered out) | no — and not counted as a pass  |

The ordering inside `classify()` is the policy: a failure is decided _before_
retries are looked at. `retryCount: 2` with a final state of `failed` is a real
failure that was attempted three times, and it is reported as a real failure.

CI prints the two interesting cases in separate, labelled sections, and flaky
tests also get a `::warning` annotation so they appear on the pull request
itself rather than only in a log someone has to go looking for:

```
── flake report: FLAKY (green only after a retry) ──
   These did NOT fail the build, but each one is a real bug hiding behind a retry.
   ! components/ui/Badge.test.tsx :: Badge > renders the label  (retried 1x)
   31 tests: 29 passed, 1 flaky, 0 failed, 1 skipped.
```

## Seeing the truth underneath

Retries are on by default so one unlucky run does not block unrelated work. When
you want the suite's real first-attempt pass rate:

```bash
FLAKE_RETRY=0 npm test
```

A test that is green here and flaky above is a flake, by definition, and is the
thing to fix.

## The history

`docs/testing/flake-history.json` holds one entry per test. Each entry carries a
bounded window — the last 30 runs, one character each:

- `0` passed first time
- `1` flaky
- `2` failed

A test's flake rate is the number of `1`s divided by the window length. The
window is capped, so the file cannot grow without bound, and a test that is fixed
stops counting as chronic as its flaky observations age out.

Skipped tests contribute no observation at all. `it.skip` is not evidence of
health, and counting it as a pass would let a suite quietly stop testing itself
while its flake rate improved.

The nightly job (`.github/workflows/flake-history.yml`) runs the suite, folds the
result in, and opens a pull request with the updated history. Nothing is
auto-committed to `main`, so the history stays reviewable.

## Chronic offenders

A test is a chronic offender when it is flaky in at least **5** observations and
its rate reaches **10%**. Both halves matter. The rate alone would flag a test on
its second ever run; the observation floor alone would flag a test that flaked
once and then behaved for twenty runs.

An offender is not a failure. It is a demand for a decision.

## Quarantine

A chronic offender may keep flaking only if it has an entry in
`docs/testing/quarantine.json`:

```json
[
  {
    "id": "components/ui/Badge.test.tsx :: Badge > renders the label",
    "owner": "@someone",
    "issue": 173,
    "addedAt": "2026-09-28T00:00:00.000Z",
    "expiresAt": "2026-10-28T00:00:00.000Z",
    "note": "Badge reads a CSS media query; jsdom has no layout. Needs a jsdom matchMedia mock — tracked in #173."
  }
]
```

Every field is required. An entry missing an owner, an issue or an expiry is
rejected when the file is read, rather than being treated as a valid quarantine.
An incomplete entry would create a quarantine that nobody is accountable for,
which is worse than no quarantine at all.

### The expiry is the point

**There is no flag, setting or code path that makes a quarantine permanent.** When
`expiresAt` passes, the entry stops covering the offender and CI blocks again:

```
  30%  lib/__flake_demo__.test.ts :: demo > passes only after a retry  — quarantine EXPIRED 2026-10-10T00:00:00.000Z (@someone, #173)

  1 quarantined test(s) past their expiry date:
    lib/__flake_demo__.test.ts :: demo > passes only after a retry  expired 2026-10-10T00:00:00.000Z

::error::1 chronic offender(s) are not covered by an active quarantine.
```

To keep it, someone has to write a new expiry date with a reason. That is the
whole mechanism: "we will fix it later" has to be re-argued out loud on a
schedule instead of decaying into silence.

Thirty days is a sensible default expiry. A shorter one for anything customer
visible. An expiry in the past at review time is a rejection, not a formality.

## Choosing between fixing and quarantining

Quarantine the test when the flake is a _known, bounded_ environment limitation —
a missing `jsdom` API, a fixed seed, a real race in a third-party library that
cannot be injected away. Write the note so the next reader understands the
limit without reading the test.

Fix the test when the cause is in code you own. If you can name the shared
mutable state, the real clock, the un-awaited promise, or the ordering
assumption, then it is a bug, and a retry is just refusing to look at it.

What not to do:

- **Raise the retry budget to make it go away.** `retry: 5` on a test that fails
  5% of the time makes CI slower and hides the signal. If a test needs five
  attempts, it needs a fix.
- **Quarantine with an issue number that will never be picked up.** The expiry
  will catch it; that is what it is for.
- **Delete the test.** A deleted test leaves its history behind, and the nightly
  job will report it as a stale entry rather than pretending it never existed.
- **Set `expiresAt` far in the future.** It works, and it defeats the mechanism.
  The reviewer for the quarantine PR is the last line of defence here.

## Commands

```bash
npm test                                        # retries on; prints the flake report
FLAKE_RETRY=0 npm test                          # no retries: the real first-attempt pass rate
npm run test:flake-history                      # fold the last run in and report offenders
npm run test:flake-history -- --no-merge        # report without writing the history
npm run test:flake-history -- --enforce         # exit non-zero on an unquarantined offender
npm run test:flake-history -- --rate=0.05 --min-observations=10
```

Exit codes: `0` nothing to do, `1` an unquarantined chronic offender (with
`--enforce`), `2` a bad history or quarantine file.

Tuning: `--rate` and `--min-observations` change when a test becomes an
offender. `min-observations` is the one to raise if the offender list is noisy —
the history needs more runs before it is entitled to complain.

## Tuning the retry budget

`vitest.config.ts` sets `retry: 2`, so a test is attempted at most three times.
Vitest 3 retries immediately, with no delay between attempts, which suits this
suite: every test is a fast in-process unit test, and there is no shared
external state for a retry to wait on.

A test that needs to wait for a race to resolve needs a real clock injected, not
a sleep. A longer delay would only make the build slow before saying the same
thing.

`retry: 1` is defensible for a suite that is mostly stable. `retry: 0` is the
honest setting, and the history makes it survivable: every test is tracked, so
the first-attempt pass rate is a number you can watch rather than a mood.
