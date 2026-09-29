# Changelog

All notable changes to this project are documented in this file.

Releases are generated from
[conventional commits](https://www.conventionalcommits.org/) by
semantic-release; see [Release process](docs/release-process.md). Do not edit
this file by hand.

## Versioning strategy

The project is pre-1.0 (`0.x`). The rules are:

| Commit                                                      | Bump                      |
| ----------------------------------------------------------- | ------------------------- |
| `feat:`, `feat(scope):`                                     | minor — `0.1.0` → `0.2.0` |
| `fix:`, `perf:`, `revert:`                                  | patch — `0.1.0` → `0.1.1` |
| `feat!:` or a `BREAKING CHANGE:` footer                     | major — `0.1.0` → `1.0.0` |
| `docs`, `chore`, `ci`, `test`, `style`, `refactor`, `build` | none                      |

A breaking change is treated as the signal that the API has stabilised, so it is
what moves the project to `1.0.0`. Until then, `0.x` versions carry the
pre-1.0 caveat that minor bumps may contain breaking changes.

Non-releasing types are listed explicitly in `release.config.js` rather than left
to a default, so adding a new commit type is a deliberate decision instead of one
that silently starts producing releases.

## Unreleased

Automated release notes will appear here once a release is cut.
