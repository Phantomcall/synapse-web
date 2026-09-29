# feat(flags): lightweight feature-flag system for the Synapse UI (#164)

## Problem

With a large wave of features landing simultaneously, shipping everything on every merge means all the risk lands at once. A feature that misbehaves in production under real load — an Admin RPC that starts timing out, a Docs page that starts 500ing, a new theme that breaks a screen reader — currently requires a full redeploy to disable.

## What this PR delivers

A complete `lib/flags/` module implementing an env-driven feature-flag system with a remote-config overlay. Two real tabs (`tab.admin`, `tab.docs`) are already gated behind flags in `components/Shell.tsx`.

### Architecture decision: env-driven with optional remote overlay

The issue asks to evaluate **remote-config service vs. build-time/env-driven flags**. Both were considered:

| Approach                                               | Pros                                                                                        | Cons                                                                                |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Remote-config service (LaunchDarkly, Flagsmith, etc.)  | Per-user targeting, real-time updates                                                       | Adds an external SaaS dependency, costs money at scale, requires a backend for SDKs |
| Env-driven at build time                               | Zero dependencies, zero cost, works offline                                                 | Requires a redeploy to change a flag                                                |
| **Env-driven + optional remote JSON overlay** ← chosen | Zero external dep, no redeploy needed for toggles, no backend required, degrades gracefully | Slightly more code than pure env-driven                                             |

**Chosen: env-driven registry with an optional remote JSON config URL** (`NEXT_PUBLIC_FLAGS_URL`). Any static JSON host (a public S3 bucket, GitHub Gist, or the repo's own `public/flags.json`) can serve the override file. No SaaS account required. If the URL is not set, the app runs entirely on the registry defaults — same behavior as before this PR.

### Files added

| File                         | Purpose                                                                                                                                                                                                                |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/flags/types.ts`         | TypeScript types for the registry, overrides, and provider state                                                                                                                                                       |
| `lib/flags/definitions.ts`   | The flag registry — the single source of truth. Every flag has a `defaultValue`, a `description`, and an `owner`.                                                                                                      |
| `lib/flags/evaluate.ts`      | Pure functions: `evaluateFlag`, `visibleTabs`, `resolveActiveTab`. No I/O.                                                                                                                                             |
| `lib/flags/remoteConfig.ts`  | `loadRemoteFlags`: fetches the override JSON, validates every key against the registry (unknown keys are dropped silently), caches to `localStorage` so the last-known-good state survives a momentary network hiccup. |
| `lib/flags/FlagProvider.tsx` | React context, `useFlag`, and `useFlags` hooks. Resolves flags on first render from the registry defaults (no hydration mismatch), then applies the remote override in an effect.                                      |
| `lib/flags/index.ts`         | Public barrel re-export.                                                                                                                                                                                               |
| `lib/flags/README.md`        | Team documentation: how to add a flag, the registry rules, how to set up the remote config URL.                                                                                                                        |

### Fail-safe behaviour

Three independent layers ensure the app never breaks when the flag source is unavailable:

1. **Registry defaults are always safe.** New capabilities default `false`; existing tabs default `true` (they are kill-switches, not launch gates).
2. **Remote fetch failures fall back to the cache**, then to registry defaults. The cache TTL is 5 minutes; the app retries on the next navigation.
3. **`localStorage` errors are caught and suppressed.** Safari ITP, private browsing, and storage-full conditions all degrade to defaults-only without throwing.

### Two real features gated behind flags

`components/Shell.tsx` now uses `useFlag("tab.admin")` and `useFlag("tab.docs")` to:

- hide the tab from the nav bar when disabled
- skip rendering the tab's component tree when the active tab is disabled
- re-validate the active tab on every render, so disabling a tab while the user is looking at it redirects them to `dashboard` rather than leaving them at a blank content area

## Verification

### Tests — 117 passing (86 new in `lib/flags/`)

```
npm run test

 ✓ lib/flags/evaluate.test.ts       (35 tests)
 ✓ lib/flags/remoteConfig.test.ts   (38 tests)
 ✓ lib/flags/FlagProvider.test.tsx  (13 tests)
 ✓ lib/wallet/storage.test.ts       (4 tests)
 ✓ lib/soroban/transactionMerge.test.ts  (9 tests)
 ✓ lib/utils.test.ts                (7 tests)
 ✓ components/ui/Badge.test.tsx     (5 tests)
 ✓ lib/soroban/args.test.ts         (6 tests)

 Test Files  8 passed (8)
      Tests  117 passed (117)
```

Tests cover:

- Flag evaluation for `boolean` and `percentage` types, including boundary values
- `visibleTabs` hiding a tab when its flag is off
- `resolveActiveTab` moving the user off a tab that gets disabled mid-session
- `validateRemoteFlags` accepting, dropping, and rejecting every edge case in the JSON shape
- `FlagProvider` serving registry defaults before the remote config arrives (no hydration mismatch)
- `FlagProvider` applying a remote kill-switch and a percentage rollout
- Fail-safe paths: `localStorage` throws on every access, fetch rejects unexpectedly

### Coverage — lib/flags/

```
npm run test:coverage

File              | % Stmts | % Branch | % Funcs | % Lines
------------------|---------|----------|---------|--------
FlagProvider.tsx  |   92.52 |    85.71 |      75 |   92.52
definitions.ts    |  100.00 |   100.00 |  100.00 |  100.00
evaluate.ts       |  100.00 |    96.96 |  100.00 |  100.00
remoteConfig.ts   |   98.70 |    89.79 |  100.00 |   98.70
All files (flags) |   97.30 |    91.01 |   92.30 |   97.30
```

Statement coverage 97.3% (issue requires ≥85%). ✓

### Lint and typecheck

```
npm run lint      → clean
npx tsc --noEmit  → clean
npm run build     → succeeds
```

## Unchecked acceptance criteria

- [ ] **Toggle-off verified to work without a redeploy** — requires a deployed staging instance and a live `NEXT_PUBLIC_FLAGS_URL` endpoint. In-repo: the test `FlagProvider with a remote config > applies a remote kill-switch` verifies this path in jsdom. The team should verify on staging by flipping `tab.admin: false` in the hosted JSON and refreshing without rebuilding.

closes #164
