---
title: Contributing
description: Tests, CI expectations, PR conventions, and how the documentation site is built.
order: 5
---

## Before you open a PR

Run the same four gates CI runs:

```bash
npm run test
npm run lint
npx tsc --noEmit
npm run build
```

A pre-commit hook runs Prettier over staged files via `lint-staged`, so
formatting problems rarely reach review.

## Tests

Two suites, two runners, two CI jobs.

| Suite          | Runner         | Location                 | What it covers                       |
| -------------- | -------------- | ------------------------ | ------------------------------------ |
| `npm run test` | Vitest + jsdom | `*.test.ts(x)` colocated | Logic and component behaviour        |
| `npm run e2e`  | Playwright     | `e2e/*.spec.ts`          | The built app in each browser engine |

Vitest files live next to the module they test (`lib/utils.test.ts`,
`components/ui/Badge.test.tsx`). `e2e/` is excluded from Vitest's collect globs
because both runners default to matching `*.spec.ts`.

The e2e suite needs browsers once:

```bash
npm run e2e:install
npm run e2e
```

`npm run e2e` builds and starts the production app on port 3100 before running
the specs, so the first run takes a minute. Port 3100 is used so it can never
attach to a `npm run dev` server you already have on 3000.

## What CI runs

| Job                    | Node        | Commands                                     |
| ---------------------- | ----------- | -------------------------------------------- |
| `test`                 | 20, 22      | `npm run test`                               |
| `lint-typecheck-build` | 20 (pinned) | `npm run lint`, `tsc --noEmit`, `next build` |
| `e2e`                  | 20 (pinned) | Playwright, one engine per matrix leg        |

The build job is pinned to one Node version on purpose: the artifact must be
reproducible. The _test_ job is matrixed on purpose: a pin is a fine way to
produce a build and a bad way to claim the test suite is valid everywhere. Both
rationales are in the comment header of `.github/workflows/ci.yml`.

The e2e matrix is Chromium, Firefox and WebKit. Chromium is the primary target;
a failure in another engine is worth knowing about but is documented rather
than used to block unrelated work.

## Writing tests that are worth having

- Assert behaviour, not implementation. A test that re-states the code it calls
  passes forever and catches nothing.
- For UI, assert on what a user can see. A component that throws still renders
  _something_, so pair a positive marker with a negative one.
- Do not stub the thing under test. A test that mocks its own subject asserts
  only that the mock works.

## Adding a new tab

1. Create `components/<name>/<Name>Tab.tsx` exporting `<NameTab />`.
2. Add the tab key to the `TABS` array in `components/Shell.tsx`.
3. Add a matching `{tab === "<name>" && <NameTab />}` block in `Shell.tsx`.
4. Wrap it in `<TabErrorBoundary>` like the existing tabs.

## Documentation site

The docs site is a static build of `docs/*.md` with no framework and no new
dependencies:

```bash
npm run docs:build
```

Things worth knowing before you edit `docs/`:

- **The Markdown renderer is a documented subset.** Headings to `h4`,
  paragraphs, fenced code, GFM tables, flat lists, blockquotes, rules, and
  inline `code` / `**bold**` / `*italic*` / `[links](…)`. Anything outside that
  throws with a file and line number rather than rendering as raw text.
- **The ABI table is generated.** `docs/contract-abi.md` contains one
  `<!-- generated:abi-reference -->` marker. `scripts/docs/abi-reference.mjs`
  transpiles `lib/constants.ts` and fills it in. Do not paste an endpoint table
  into the Markdown — the build asserts that exactly one page carries the
  marker, and `npm run test` asserts the generated table matches
  `ABI_ENDPOINTS` exactly.
- **Front matter drives the nav.** `title` and `order` are required; `order`
  sorts the sidebar. A page missing either fails the build.
- **Links should be relative** (`./architecture/`) so the site works when
  deployed under a sub-path such as GitHub Pages' `/synapse-web/`.
- Adding a page means adding an `npm run docs:build` check locally. The deploy
  workflow rebuilds on every merge to `main`, so a page that builds locally is
  live on the next merge.

## Deploying the docs

`.github/workflows/docs-deploy.yml` builds the site and publishes it to GitHub
Pages on every merge to `main`, plus on manual dispatch. It requires the
repository's Pages setting to be configured for the GitHub Actions source —
a one-time repository-settings action, not something a pull request can do.
