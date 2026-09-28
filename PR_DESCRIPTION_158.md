feat(ci): add visual regression baseline approval gate

Wires the governance layer for visual regression baselines: a required check
that a snapshot change has been independently approved, with a documented
approval process. The suite itself is out of scope here.

## Status: wired, not yet enforcing

The visual regression **suite** is issue
[#148](https://github.com/Synapse-bridgez/synapse-web/issues/148), implemented
in open PR [#223](https://github.com/Synapse-bridgez/synapse-web/pull/223) and
not yet merged. `main` therefore has no snapshots to diff, so this workflow:

1. detects whether the suite is present in the commit,
2. if absent, posts a notice on the PR naming the missing suite, the tracking
   issue, and the unmerged PR, and emits a `::warning` annotation,
3. then **exits green**, stating explicitly in the PR comment:

   > This check is **green because it was skipped, not because it passed**.

That last point is deliberate. A silently-passing required check is worse than
no check, so the skip is made visible rather than made to look like a pass. Once
#148 merges, the identical workflow starts enforcing with no change to this PR
or to the policy document.

To avoid colliding with #223, this PR adds
`.github/workflows/visual-regression-governance.yml` rather than
`visual-regression.yml`, and reads the suite path from the
`VR_SUITE_PATH`/`VR_SNAPSHOT_PATH` env block at the top so the two stay aligned
in one place.

## The gate

`scripts/visual-regression-approval.mjs` holds the policy, in one function
(`evaluateBaselineApproval`) with the copy strings alongside it. The gate is
required exactly when the PR's base..head diff touches
`$VR_SNAPSHOT_PATH`; otherwise the workflow posts a "no visual diff" notice and
passes.

A baseline update is approved only when a single review satisfies **all** of:

| #   | Condition                                  | Why                                                                                  |
| --- | ------------------------------------------ | ------------------------------------------------------------------------------------ |
| 1   | state is `APPROVED`                        | `Comment` and `Request changes` do not count                                         |
| 2   | reviewer is **not the PR author**          | the rule the issue calls out                                                         |
| 3   | reviewer has **write** access              | an outside contributor cannot approve                                                |
| 4   | review targets the **current head**        | sign-off cannot be reused for a later diff                                           |
| 5   | body carries an explicit signal            | `<!-- baseline-approved -->`, `/baseline-approve`, or the phrase `baseline approved` |
| 6   | not revoked by a later `CHANGES_REQUESTED` | a reviewer can withdraw approval                                                     |

### Preventing author self-approval

The issue's specific edge case. The author's login comes from the event payload
and their review is **discarded outright**, not merely deprioritised — a required
check the author can satisfy alone would provide no review signal at all. Two
guards close the obvious workarounds:

- **Permission is read from the collaborator-permissions API**, falling back to
  `author_association` only when the API returns nothing, so a downgraded or
  revoked maintainer cannot keep approving.
- **Approval is invalidated by new commits**, so a reviewer cannot sign off one
  diff and have it silently apply to a different one pushed afterwards.

Every rejection is reported with a named reason, e.g.

```
- @octocat — self-approval by the PR author — authors can never satisfy the baseline gate
- @someone — reviewer does not have write access
- @reviewer — approval targets an older commit — re-approve the current head
```

## Documentation

`docs/visual-regression-ci.md` covers when the gate is required, the approval
procedure, why self-approval is refused, and what happens after merge. Its
description of the gate was checked line-by-line against the workflow — an
earlier draft claimed a "suite tests untouched" condition that the workflow does
not implement, and was corrected to state the actual rule (snapshot diff).

## Verification

- `npx tsc --noEmit` — clean. This required real fixes in the test file: the repo
  runs with `noImplicitAny` and `noUncheckedIndexedAccess`, so the fixtures are
  typed and array assertions go through an `onlyBlockReason` helper that fails
  loudly on an empty list rather than silently reading `undefined`.
- `npm run lint` — 0 errors.
- `npm test` — 46 pass (31 pre-existing + 15 new).
- `npm run build` — compiled successfully.
- `npm run format:check` — clean for every file in this PR. The three files it
  still flags (`.github/ISSUE_TEMPLATE/bug_report.md`, `feature_request.md`,
  `components/dashboard/StatCards.tsx`) are pre-existing and untouched here.
- Workflow YAML parses, with triggers and job conditions inspected.
- **The gate was exercised as a real CLI**, not only through unit tests:

  | Scenario                                             | Expected | Got                            |
  | ---------------------------------------------------- | -------- | ------------------------------ |
  | author self-approves, **with admin permission**      | reject   | exit 1, `author-self-approval` |
  | approval on a stale commit                           | reject   | exit 1                         |
  | approval from a `read`-only user                     | reject   | exit 1                         |
  | approval revoked by a later changes-requested review | reject   | exit 1                         |
  | write-access approval on the current head            | accept   | exit 0                         |
  | no snapshot change (`--required=false`)              | accept   | exit 0                         |

  The first row is the one that matters: even a repository admin who is also the
  PR author is refused.

## Not verified

The "pipeline live and required" part of the DoD **cannot be completed from this
PR**. Two things are outside a contributor's reach:

- Marking the check as required is a branch-protection setting on the upstream
  repository, and the role required to set it is one this account does not hold.
- The end-to-end demonstration on a real PR needs #148's suite to be merged
  first; with no snapshots on `main`, the workflow takes the documented skip path.

Both are called out here rather than claimed. A maintainer needs to add
`baseline-gate` to the required checks for `main` once #148 lands.

closes #158
