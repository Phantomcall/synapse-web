# Release process

Versions, the changelog, and GitHub releases are generated from conventional
commits by [semantic-release](https://semantic-release.gitbook.io/). Nobody edits
a version number or writes release notes by hand.

## One-time bootstrap

**The repository currently has no git tag.** semantic-release decides what to
release by diffing against the most recent tag, so with no tag it would treat the
entire history as unreleased and produce a `1.0.0` listing work that predates the
current `0.1.0`.

A maintainer must tag the current state before the first automated release:

```bash
git tag -a v0.1.0 -m "0.1.0" <commit-sha-of-current-package.json-version>
git push origin v0.1.0
```

This is a one-time step and needs write access to the upstream repository, so it
cannot be done from a fork PR. Until it happens, the `Release` workflow reports
that there is nothing to release.

## How a release happens

1. A PR with conventional commits merges into `main`.
2. `.github/workflows/release.yml` runs on that push.
3. semantic-release compares `main` against the latest tag and decides the bump.
4. `@semantic-release/exec` runs `npm run build && npm test`. If either fails,
   the release stops **before** any tag, commit, or release exists.
5. `package.json` and `package-lock.json` get the new version,
   `CHANGELOG.md` gets the entry, and both are committed to `main` by
   `@semantic-release/git` as `chore(release): <version> [skip ci]`.
6. `@semantic-release/github` creates the tag and the GitHub release with the
   generated notes and `CHANGELOG.md` attached.

The release commit is pushed straight to `main`, which is why the workflow uses
`concurrency: release` — a second merge arriving mid-release would otherwise race
to tag and publish.

## Commit format

```
<type>(<optional scope>): <imperative summary>
```

| Type                                                        | Bump  | In changelog             |
| ----------------------------------------------------------- | ----- | ------------------------ |
| `feat`                                                      | minor | Features                 |
| `fix`                                                       | patch | Bug Fixes                |
| `perf`                                                      | patch | Performance Improvements |
| `revert`                                                    | patch | Reverts                  |
| `docs`, `chore`, `ci`, `test`, `style`, `refactor`, `build` | none  | omitted                  |

A breaking change is `feat!:` or a `BREAKING CHANGE:` footer in the body, and
produces a major release. See the versioning strategy in
[`CHANGELOG.md`](../CHANGELOG.md).

Commit format is **not** enforced at commit time — the issue that would add that
is separate. A non-conventional commit is simply ignored by the release
toolchain rather than failing the build, so the worst case is a missing changelog
line.

## Running it locally

```bash
npm run release:dry   # reports the version and notes, publishes nothing
npm run release       # performs a real release; needs a GITHUB_TOKEN
```

`release:dry` is the safe way to check what a batch of commits would produce.

## Dry run in CI

Set the repository **variable** `SEMANTIC_RELEASE_DRY_RUN=true` and the workflow
will run `semantic-release --dry-run` instead of publishing. Useful for checking
the version arithmetic on a real merge. Unset it to resume real releases.

## Configuration

`release.config.js` holds the whole policy. Two things are worth knowing:

- Only `main` may cut a release (`branches: ["main"]`), so a release branch can
  never publish.
- The commit-type list is explicit. A new type is a deliberate decision, not a
  default.

`scripts/release-config.test.ts` pins the version arithmetic and the changelog
grouping. It duplicates the plugin options from `release.config.js` rather than
importing them, because importing the config would load the GitHub plugin and
require a token. **If you change the release policy, change both.**
