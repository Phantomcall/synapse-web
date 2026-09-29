feat(release): automate versioning, changelog, and GitHub releases

`package.json` sat at `0.1.0` with no release process, so version history and
release notes depend on someone remembering to write them. This derives all three
— version, `CHANGELOG.md`, and the GitHub release — from conventional commits on
merge to `main`.

## What it does

`.github/workflows/release.yml` runs on every push to `main`:

1. semantic-release diffs against the latest tag and computes the bump.
2. `npm run build && npm test` runs as `verifyRelease`, so **the release stops
   before any tag, commit, or release exists** if the build or tests fail.
3. `package.json`, `package-lock.json`, and `CHANGELOG.md` are committed straight
   to `main` as `chore(release): <version> [skip ci]`.
4. The tag and GitHub release are created with the generated notes and
   `CHANGELOG.md` attached.

`concurrency: release` prevents a second merge racing to tag mid-release, which
matters because step 3 pushes to `main` itself.

## Versioning strategy for the 0.1.0 starting point

The issue asks for this to be handled deliberately, so `release.config.js` states
the rules rather than relying on defaults:

| Commit                                                      | Bump                      |
| ----------------------------------------------------------- | ------------------------- |
| `feat`, `feat(scope)`                                       | minor — `0.1.0` → `0.2.0` |
| `fix`, `perf`, `revert`                                     | patch — `0.1.0` → `0.1.1` |
| `feat!:` or `BREAKING CHANGE:` footer                       | major — `0.1.0` → `1.0.0` |
| `docs`, `chore`, `ci`, `test`, `style`, `refactor`, `build` | none                      |

Two decisions worth flagging:

- **A breaking change is what moves the project to `1.0.0`.** Until then `0.x`
  carries the pre-1.0 caveat that minors may break. Documented in `CHANGELOG.md`
  so the policy is visible to consumers, not just to the toolchain.
- **Non-releasing types are listed explicitly.** A new commit type is then a
  deliberate decision rather than one that silently starts cutting releases, and
  a docs-only merge cannot churn the version.

`branches: ["main"]` means a release branch can never publish.

## One-time bootstrap a maintainer must do

**The repository has no git tag.** semantic-release works by diffing against the
latest tag, so with none it would treat the entire history as unreleased and
produce a `1.0.0` listing work that predates the current `0.1.0`. A maintainer
must tag the current state once:

```bash
git tag -a v0.1.0 -m "0.1.0" <commit-of-current-package.json-version>
git push origin v0.1.0
```

This needs write access to the upstream repo, so it cannot be done from a fork PR.
It is documented in `docs/release-process.md` and `CHANGELOG.md`. Until it happens
the workflow correctly reports that there is nothing to release — verified below.

## Testing

`scripts/release-config.test.ts` — 19 tests pinning the version arithmetic and
changelog grouping, run against a fixture set of conventional commits:

```
PASS  0.1.0 + [feat(wallet)]           -> 0.2.0
PASS  0.1.0 + [fix(origin)]            -> 0.1.1
PASS  0.1.0 + [perf(bundle)]           -> 0.1.1
PASS  0.1.0 + [docs, chore, ci, test, style, refactor, build] -> no release
PASS  0.1.0 + [docs + fix]             -> 0.1.1
PASS  0.1.0 + [feat!]                  -> 1.0.0
PASS  0.1.0 + [feat! + BREAKING CHANGE footer] -> 1.0.0
```

The changelog tests assert that a mixed fixture batch produces Features, Bug
Fixes, and Performance sections, that each released commit is listed with its
scope, and that `docs`/`chore` entries are **omitted**.

A separate throwaway run against a real git repo (fixture commits on top of a
`v0.1.0` tag) confirmed the end-to-end path: the analyser returned `minor` and the
generator produced correctly grouped notes with commit links and a
`v0.1.0...v0.2.0` comparison. That scratch repo and its tag were deleted
afterwards — the repository still has no tags.

The test file duplicates the plugin options from `release.config.js` rather than
importing them, because importing the config loads `@semantic-release/github` and
needs a token. The duplication is deliberate and called out in both files: change
the policy, change both.

## Notes for reviewers

- `types/semantic-release.d.ts` declares the two plugin APIs, which ship no type
  definitions. This keeps the test type-checked under the repo's strict settings
  instead of disabling `noImplicitAny`.
- `conventional-changelog-conventionalcommits` is a devDependency so the
  `conventionalcommits` preset resolves, but is deliberately **not** listed as a
  plugin: it is ESM-only and semantic-release loads plugins through CJS require,
  which fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`. This was hit and fixed during
  development; the reason is recorded in `release.config.js` so it is not
  "corrected" back later.
- Setting the repository variable `SEMANTIC_RELEASE_DRY_RUN=true` makes CI
  report the version and notes without publishing.
- Commit format is **not** enforced at commit time — that is a separate issue, as
  the issue notes. A non-conventional commit is ignored by the toolchain rather
  than failing the build, so the worst case is a missing changelog line.

## Verification

- `npx tsc --noEmit` — clean.
- `npm run lint` — 0 errors.
- `npm test` — 50 pass (31 pre-existing + 19 new).
- `npm run build` — compiled successfully.
- `npm run format:check` — clean for every file in this PR. The three files it
  still flags (`.github/ISSUE_TEMPLATE/bug_report.md`, `feature_request.md`,
  `components/dashboard/StatCards.tsx`) are pre-existing and untouched here.
- `npm run release:dry` — runs, and reports it will not publish because the
  current branch is not `main`; on `main` with no tag it reports nothing to
  release, which is the expected pre-bootstrap state.
- Release workflow YAML parses; triggers and the dry-run branch were inspected.

## Not verified

The DoD asks for "at least one real automated release cycle". The publish step
(`@semantic-release/github`) cannot be exercised from a fork PR: it needs a
`GITHUB_TOKEN` with write access to the upstream repository and it would create a
real tag. What is verified is everything up to that boundary — version
computation, changelog content, and the verify gate. The first real cycle will
happen on the first `feat`/`fix` merge after a maintainer adds the `v0.1.0` tag.

closes #159
