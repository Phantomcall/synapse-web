# feat(wallet): verify the running origin before the user signs anything

Closes #177

Wallet-connect phishing — a pixel-perfect clone of this dashboard on a different
host, asking you to sign — is the most common Web3 attack there is. The defenses
against it live mostly inside the wallet extension, but the dashboard can make
the comparison possible before the user approves anything, and can teach them
what to compare.

## What this adds

**A persistent origin badge** (`components/wallet/OriginBadge.tsx`) in the header,
plus a **`<SigningOriginNote />` directly above every sign-triggering action** —
in `AdminTab` (both the resting state and the confirm dialog), and in
`TransactionsTab` at the callback-registration action. The header badge says it
once; the note says it at the moment the decision is actually made.

Four states, deliberately unforgiving:

| State        | Meaning                                                                  |
| ------------ | ------------------------------------------------------------------------ |
| `GENUINE`    | Origin exactly matches a published origin — scheme _and_ port included.  |
| `LOCAL DEV`  | `localhost` / `127.0.0.1` / `::1`. No signing here is real.              |
| `UNVERIFIED` | Not a published origin: a clone, a fork, or an unknown preview host.     |
| `EMBEDDED`   | Running inside another page's frame — the address bar is not the user's. |

The badge carries `data-origin-classification` and `data-origin-hostname`
attributes, so a test or the console can assert the real state rather than
inferring it from styling. It renders nothing until the origin is known, so a
first paint can never flash the wrong state.

**A first-visit briefing** (`components/onboarding/GuidedTour.tsx`), reopenable
from a `?` button in the header. It covers what the badge means, that the
extension's own domain confirmation is the check that actually binds a signature
to a site, and how clones get people. It opens once, keyed in `localStorage`, and
never nags a returning user.

**Documentation** — a "Verifying you're on the real dashboard" section in
`README.md` covering the states, the allowlist variables, the iframe decision,
and what is explicitly out of scope, plus a new `.env.example`.

**17 unit tests** in `lib/wallet/origin.test.ts`.

## Design notes

### The classification is a comparison, not a claim

The badge's truth, not its appearance, is the protection. The classification is
derived from `window.location.origin` compared against an explicit operator
allowlist, so a clone is _unknown_, never "genuine-ish". Anyone can style a span
green; a clone cannot make its own origin match a string in the allowlist.

## Five bugs found and fixed in the pre-existing draft

The branch already had an uncommitted implementation. Reviewing it before
shipping turned up five real defects, all fixed here:

**1. The allowlist could mint a trusted badge for a local origin** (security)

`classifyOrigin` checked `allowedOrigins.includes(origin)` _before_ the
localhost check, so a `localhost` origin present in the allowlist classified as
`GENUINE` and rendered the green trusted badge. Anything reachable on localhost
or plain HTTP is trivially impersonable — being able to run a local server would
be enough to advertise a trusted origin. The localhost check now runs first, so
`dev` cannot be promoted to `genuine`. The allowlist entry is still reported in
`allowedOrigins`, so a mismatch stays visible rather than being silently
swallowed.

The test for this asserted `.toBe("genuine")` directly beneath a comment reading
"a localhost in the allowlist cannot turn into genuine" — the comment and the
assertion contradicted each other, and the assertion was the one encoding the
vulnerability. Both are now coherent and match the fixed behaviour.

**2. The classifier threw on the exact input the issue is about** (crash)

```js
isHttps: new URL(origin).protocol === "https:" ? true : ...
```

A sandboxed iframe (one without `allow-same-origin`) reports `location.origin`
as the literal string `"null"` — an opaque origin — and `new URL("null")` throws
`TypeError: Invalid URL`. This fires inside `useEffect`, so the badge crashes
and renders nothing at precisely the moment the user most needs to be warned
about a framed, hostile page. Parsing is now guarded and an unparsable origin
reports `isHttps: null` ("unknown") rather than throwing. Covered by two new
tests.

**3. `VERCEL_URL` was read from a variable Vercel does not set** (config)

The badge read `process.env.NEXT_PUBLIC_VERCEL_URL`. Vercel inlines the
deployment URL as bare `VERCEL_URL` — which `app/layout.tsx:26` already uses
correctly. `NEXT_PUBLIC_VERCEL_URL` is a different, unset variable, so every
Vercel deployment was silently absent from its own allowlist and every preview
build rendered `UNVERIFIED`. Now reads `VERCEL_URL`. Documented in
`.env.example` so it is not renamed back.

**4. Both new components violated the repo's own lint rules** (CI)

`npx eslint` failed with three `react-hooks/set-state-in-effect` errors, which
would have failed the repo's CI gate. This is a React 19 codebase with the React
Compiler lint rules enabled.

`useOriginState` moved from `useState` + `useEffect` to
`useSyncExternalStore`, reading `window.location` during render with a
module-scoped snapshot cache. The origin cannot change without a full
navigation, so the cache is correct, and it also means no origin-specific value
is ever written into the SSR/SSG payload — which is right, since the
classification is meaningless off-browser.

`GuidedTour` had a `setInitialized(true)` effect purely as a "skip the first
run" guard before reacting to the reopen counter. That is now React's documented
"adjusting state when a prop changes" pattern, carrying the last handled value
in state so the first render is a no-op — no effect, no extra render pass, and
no mutation-during-render. (An earlier attempt using a `useRef` instead of
state was rejected by `react-hooks/refs`; the state form is the sanctioned
one.)

**5. An unrelated edit orphaned an import** (correctness)

A stray hunk in `components/transactions/TxDetailModal.tsx` removed
`padding: 16` and `background: BG2` from a status panel, leaving `BG2` imported
but unused — an unused-variable lint error, and a cosmetic change with no
bearing on origin verification. Reverted, so the diff stays on-topic.

## Manual review of every connect/sign entry point

The issue asks for a documented manual review confirming the indicator is
visible and accurate at each entry point. Traced through the code:

| Entry point                             | Indicator                                                 |
| --------------------------------------- | --------------------------------------------------------- |
| Header (all tabs, always)               | `<OriginBadge />`                                         |
| `AdminTab` — invoke, resting state      | `<SigningOriginNote />` above the action button           |
| `AdminTab` — invoke, confirm dialog     | `<SigningOriginNote />` inside the dialog                 |
| `TransactionsTab` — `register_callback` | `<SigningOriginNote />` above the action button           |
| Wallet connect (header connect button)  | `<OriginBadge />` already visible; the briefing covers it |

The sign-confirmation itself happens in the extension, which the briefing points
at: Freighter and xBull both show their own requesting-domain confirmation, and
that is the check that actually binds a signature to a site. Implementing it is
outside this repo, so the briefing links to their documentation rather than
pretending to replace it.

Behaviour across the states: a genuine origin shows green with the exact
hostname; a clone on a typo domain, a `www.` prefix, a different port, or a
different scheme each fail the exact-match comparison and show `UNVERIFIED` in
red; a framed page shows `EMBEDDED`; localhost shows `LOCAL DEV`. An unparsable
origin reports unknown TLS state rather than throwing.

## Iframe handling

Coordinates with the CSP hardening issue (#176), which ships
`frame-ancestors 'none'` + `X-Frame-Options: DENY`. Those headers are the actual
defence. The badge is the loud fallback if they are ever missing: `framed`
overrides every other state, _including_ a matching `GENUINE` origin, because a
framed page's visible address bar belongs to the attacker.

`window.opener` is deliberately ignored — setting `noopener`/`noreferrer` is the
correct response, and a legitimate `window.open` flow should not be flagged for
using it.

## Files

| File                                          | Change                                           |
| --------------------------------------------- | ------------------------------------------------ |
| `lib/wallet/origin.ts`                        | New — origin parsing and classification          |
| `lib/wallet/origin.test.ts`                   | New — 17 tests                                   |
| `components/wallet/OriginBadge.tsx`           | New — `<OriginBadge />`, `<SigningOriginNote />` |
| `components/onboarding/GuidedTour.tsx`        | New — anti-phishing briefing                     |
| `components/Shell.tsx`                        | Mount badge, briefing toggle                     |
| `components/admin/AdminTab.tsx`               | `<SigningOriginNote />` at both invoke stages    |
| `components/transactions/TransactionsTab.tsx` | `<SigningOriginNote />` at `register_callback`   |
| `README.md`                                   | Origin verification section + file tree          |
| `.env.example`                                | New — documents the allowlist variables          |

## Verification

```
npx eslint        clean
npx tsc --noEmit  clean
npx vitest run    6 files, 48 tests passed (17 new)
npx next build    compiled successfully, 8/8 static pages
npx prettier --check .   only the 3 warnings that already exist on main
```

Checked against a pristine worktree of `upstream/main` to confirm the three
remaining Prettier warnings (`.github/ISSUE_TEMPLATE/bug_report.md`,
`feature_request.md`, `components/dashboard/StatCards.tsx`) are pre-existing and
not introduced here; only files touched by this PR were formatted.

---

closes #177
