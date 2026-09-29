feat(config): centralise environment configuration with build-time validation

Configuration was read ad hoc from `process.env` at 16 call sites, with the
testnet RPC URL hardcoded as a fallback in five separate files. That made a
misconfigured deployment fail silently: a `NEXT_PUBLIC_NETWORK=futurenet` build
with no explicit RPC URL fell through to a hardcoded _testnet_ endpoint, so the
dashboard rendered perfectly while displaying the wrong chain's data.

Routes every read through a single validated module, and makes the build the
place where a bad configuration is caught.

## What changed

**New `lib/config/env.ts`** — the schema and validator.

- Validates `NEXT_PUBLIC_NETWORK` (`testnet` | `futurenet` | `local`, defaulting
  to testnet), `NEXT_PUBLIC_SOROBAN_RPC_URL`, `NEXT_PUBLIC_CONTRACT_ID`,
  `NEXT_PUBLIC_SITE_URL`, and `VERCEL_URL`.
- Cross-validates the network against an explicit RPC URL. A testnet build
  pointed at the futurenet host is rejected, with a message naming both
  endpoints and the fix.
- Reports **every** problem in one pass. Cross-validation continues even when
  shape validation has already failed, so a developer with two mistakes fixes
  both in one rebuild instead of one per cycle.
- Rejects contract ids that are not `C` + 55 uppercase base32 characters, with a
  message that calls out the common trailing-space mistake, and rejects a `G`
  account address supplied where a contract belongs.
- Narrows the RPC URL to `http`/`https`. zod's `.url()` accepts any scheme, so
  `ftp://` previously would have passed validation and failed later in the
  browser, far from the cause.
- Uses `superRefine` rather than chained `.url().refine()` so one malformed value
  produces one message instead of reading as two separate problems.

**New `lib/config/index.ts`** — the resolved singleton.

`appConfig` exposes `rpcUrl`, `contractId`, `network`, and `siteUrl`, memoised so
the environment is parsed once. It is the only import the app needs, which keeps
call sites to a single line.

**`next.config.ts`** — fails the build on invalid configuration, printing a
boxed list of every issue and pointing at `.env.example`. The config module is
imported directly, so the build check and the runtime use the same schema rather
than two copies of the rules that can drift.

**All 16 `process.env` reads** now go through the module: `app/layout.tsx`, the
Soroban hooks, the transaction components, and the admin tab. The testnet URL is
no longer hardcoded anywhere outside `lib/config/`.

## Bug fixed along the way

`lib/soroban/events.ts` had its own `DEFAULT_RPC_URL` fallback. Because
`app/layout.tsx` passed the raw optional `NEXT_PUBLIC_SOROBAN_RPC_URL` straight
through, a network selection with no explicit URL left the value `undefined` and
the poller silently defaulted to **testnet** — the precise failure this issue
describes. The default is removed and `SorobanProvider`'s `rpcUrl` prop is now
required, so the endpoint can no longer be omitted by accident. A guard throws a
directive pointing at `appConfig.rpcUrl` if it is.

## Two judgement calls worth reviewing

**Mock data stays available.** The README documents mock data as a supported
fallback, so requiring a contract id in _every_ production build would contradict
it and would break a plain `next build` in CI, where no environment is set at
all. A contract is therefore required only when a build advertises a public
origin (`NEXT_PUBLIC_SITE_URL` or an injected `VERCEL_URL`) — that is, when it is
actually being deployed somewhere. A bare build is not treated as a deployment,
so CI still passes while a real deploy is held to naming its contract.

**No secrets.** Every variable in the schema is `NEXT_PUBLIC_*` or a platform
build variable, and `NEXT_PUBLIC_*` values are inlined into the browser bundle.
`.env.example` states this explicitly. This app has no server-side secrets, and
nothing here introduces a first.

## Documentation

Four committed templates, each a complete runnable starting point rather than a
partial list of variables:

| Template                   | Network         | Contract     | Purpose                                                |
| -------------------------- | --------------- | ------------ | ------------------------------------------------------ |
| `.env.development.example` | testnet / local | optional     | Local dev, mock-data fallback                          |
| `.env.staging.example`     | futurenet       | **required** | Pre-production, reachable by others                    |
| `.env.production.example`  | testnet         | **required** | Production release                                     |
| `.env.example`             | —               | —            | Full variable reference, formats, defaults, precedence |

Staging targets **futurenet on purpose** so that it exercises the non-default
network path — a testnet/production mix-up fails the staging build instead of
reaching production.

**Precedence**, documented in `.env.example` as two layers applied in order:

1. Next.js file loading, highest priority first: `.env.development.local`,
   `.env.local`, `.env.development`, `.env` (with the matching
   `.env.production.*` / `.env.test.*` variants). A variable already present in
   the shell is never overridden by a file, so
   `NEXT_PUBLIC_NETWORK=futurenet npm run build` wins over any file.
2. Platform environment variables at build time, which take precedence over
   committed files — the layer staging and production should actually use.

The docs state plainly that Next.js only auto-loads `development`, `production`,
and `test`, so `.env.staging` is not a name it recognises. That is why the
staging template is copied to `.env.local` locally and supplied through the
platform's environment in a real deployment, rather than implying an automatic
mechanism that does not exist.

**README** documents the `appConfig` API, a sample build failure, the two rules
below, and a table of the templates.

**Scope boundary**, called out in both `.env.example` and `README.md`: every
variable is `NEXT_PUBLIC_*` and is inlined into the browser bundle, so nothing in
`.env*` may hold a credential. This app has no server-side secrets, and secrets
management is out of scope here — stated explicitly, as the issue asks.

## Verification

- `npx tsc --noEmit` — clean.
- `npm run lint` — 0 errors.
- `npm test` — 84 tests pass, up from 63. The 53 new ones cover valid
  configurations, deliberately malformed input, the network/RPC cross-check, the
  production requirement, memoization, and the error path.
- Coverage of `lib/config/**`: 100% statements, lines, and functions; 95.91%
  branches — above the 90% target. `@vitest/coverage-v8` is pinned to `3.2.7` to
  match the repo's Vitest; the current `5.x` requires Vitest 5 and will not
  install.
- `npm run build` — succeeds with no environment set, and the four
  configuration scenarios were each checked:

  | Scenario                   | Expected          | Result                                                        |
  | -------------------------- | ----------------- | ------------------------------------------------------------- |
  | No environment             | builds, mock data | ✅ `[config] ok: network=testnet contract=(none — mock data)` |
  | Valid deployed config      | builds            | ✅ compiled successfully                                      |
  | `futurenet` + testnet RPC  | fails             | ✅ names both endpoints                                       |
  | Public origin, no contract | fails             | ✅ explains the mock-data risk                                |

- `npm run format:check` — the three files it flags
  (`.github/ISSUE_TEMPLATE/bug_report.md`, `feature_request.md`,
  `components/dashboard/StatCards.tsx`) are pre-existing and untouched here;
  verified with `git diff HEAD -- <file>`. `.prettierignore` gained `.env*` and
  `coverage`, since Prettier has no parser for dotenv syntax and `format:check`
  runs over the whole tree.
- Both the staging and production templates were applied as written (with a real
  56-character contract id) and the build succeeded for each, so they are known
  to be valid rather than merely plausible.
- `.env.local` was confirmed still git-ignored after adding the template
  exceptions, so real values cannot be committed by accident.

closes #160
