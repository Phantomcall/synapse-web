# Visual regression CI

How visual regression baselines are gated on pull requests, and how to approve
an intentional visual change.

> **Status: the gate is wired but not yet enforcing.**
> The visual regression _suite_ is tracked in issue
> [#148](https://github.com/Synapse-bridgez/synapse-web/issues/148) and is being
> added in open PR
> [#223](https://github.com/Synapse-bridgez/synapse-web/pull/223). Until that
> lands, `main` has no snapshots to diff, so this workflow detects the missing
> suite, posts a notice on the PR, and **exits green with a warning annotation**.
> That green means _skipped_, not _passed_, and the workflow says so on the PR
> itself. Once #148 merges, the same workflow starts enforcing with no change to
> this document.

## What runs, and when

`.github/workflows/visual-regression-governance.yml` triggers on:

| Event                                                            | Job                  | Purpose                                                      |
| ---------------------------------------------------------------- | -------------------- | ------------------------------------------------------------ |
| `pull_request` (opened, synchronize, reopened, ready_for_review) | `baseline-gate`      | Run the suite, publish the diff, enforce the approval gate   |
| `pull_request_review` (submitted, edited, dismissed)             | `baseline-gate`      | Re-evaluate when a review lands or is dismissed              |
| `push` to `main`                                                 | `reference-baseline` | Record the merged baseline as the reference for future diffs |
| `workflow_dispatch`                                              | both                 | Manual re-run                                                |

## What counts as a visual change

The gate is required exactly when this PR modifies a snapshot file under
`components/ui/__snapshots__/`, detected as a diff of `$VR_SNAPSHOT_PATH`
between the PR's base and head commits.

- **No snapshot changed** — the gate is not required. A PR that renders the
  components differently _without_ updating snapshots is an ordinary test
  failure, not a baseline update, so the workflow posts a "no visual diff"
  notice and passes.
- **A snapshot changed** — the gate is required and must be independently
  approved before the change can merge.

## The approval gate

A baseline update needs a review that satisfies **all** of the following. The
rules are evaluated by `scripts/visual-regression-approval.mjs`, which is unit
tested in `scripts/visual-regression-approval.test.ts`.

1. The review state is **Approve**. `Comment` and `Request changes` do not count.
2. The reviewer is **not the PR author**. The author can never satisfy their own
   gate — this is the rule that stops a visual change being waved through by the
   person who wrote it.
3. The reviewer has **write access** to the repository. A `none`/`contributor`
   association cannot approve.
4. The review targets the **current head commit**. An approval left on an older
   commit is treated as stale, so you cannot collect a sign-off and then push new
   visual changes on top of it.
5. The review body carries an explicit signal: `<!-- baseline-approved -->`,
   `/baseline-approve`, or the phrase `baseline approved`.
6. No later `Request changes` review from that reviewer has revoked it.

Any failing condition is reported by name, for example:

```
- @octocat — self-approval by the PR author — authors can never satisfy the baseline gate
- @someone — reviewer does not have write access
- @reviewer — approval targets an older commit — re-approve the current head
```

## How to approve a visual change

1. Open or update the PR so the snapshots reflect the intended design.
2. Ask a collaborator with **write access** — not the author — to review.
3. They leave an **Approve** review on the **current head** whose body contains
   the signal:

   ```
   Looks right — matches the new spacing spec.
   <!-- baseline-approved -->
   ```

   `/baseline-approve` and the words `baseline approved` work too, but the HTML
   comment is the most reliable since it cannot occur by accident in prose.

4. The `baseline-gate` job re-runs on the `pull_request_review` event and
   re-evaluates the gate. It fails until every condition above is satisfied.

## Why the author cannot self-approve

A required check that the PR author can satisfy alone provides no review signal
at all — it would only confirm that whoever wrote the code also approved it. The
gate therefore derives the author's login from the event payload and discards
their review outright, rather than merely preferring someone else's review.

Two further guards close the obvious workarounds:

- The permission check uses the collaborator-permissions API, falling back to
  `author_association` only when the API gives nothing, so a revoked or
  downgraded maintainer cannot keep approving.
- The on-head check invalidates approval as soon as new commits are pushed, so
  approval cannot be collected for one diff and reused for another.

## After approval

Once the gate passes and the PR merges, the `reference-baseline` job runs on the
push to `main` and records the merged snapshot as the reference for subsequent
diffs, and the suite's own snapshot files are the versioned baseline — there is
no separate artifact store to keep in sync.

## Reviewing this policy

The policy lives in one place: `scripts/visual-regression-approval.mjs`. To
change what counts as approval, change `evaluateBaselineApproval` and its tests
rather than editing the workflow.
