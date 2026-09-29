# Configure CDN/edge cache-control for static assets and the HTML shell

## What

`next.config.ts` was an empty object (`const nextConfig: NextConfig = {}`). It now
declares an explicit `headers()` policy that splits the app's responses into exactly
two classes, plus a unit test that pins the configured values and the rule ordering
they depend on.

| Class                                    | `Cache-Control`                       | Why                                                               |
| ---------------------------------------- | ------------------------------------- | ----------------------------------------------------------------- |
| `/_next/static/**` (hashed build output) | `public, max-age=31536000, immutable` | The URL _is_ the content hash, so it can never mean two payloads. |
| everything else (`/`, routes, `public/`) | `public, max-age=0, must-revalidate`  | Mutable: must be revalidated against the origin on every request. |

## Why — what is actually broken on `main`

I built and served the unmodified `upstream/main` config and captured the real
response headers. The result is not "headers are missing" — the HTML shell is
actively being cached at the edge **for a year**:

```
$ npx next build && npx next start -p 3111

$ curl -sSI http://127.0.0.1:3111/ | grep -iE '^(HTTP|cache-control|etag|x-nextjs-cache)'
HTTP/1.1 200 OK
x-nextjs-cache: HIT
Cache-Control: s-maxage=31536000        <-- 1 year, shared caches only
ETag: "44t0tt1mzts0j"
```

`s-maxage=31536000` is precisely the "stale-app-version" hazard the issue calls out.
A CDN in front of this origin is allowed to reuse that HTML for a year without
revalidating, so a user can keep receiving the _previous_ build's document after a
deploy. Because the document is the thing that references the build's chunk hashes,
that stale HTML points at `/_next/static/**` names the new deploy never produced, and
the app fails with chunk 404s rather than degrading gracefully. No origin log ever
shows the problem, because the origin is never asked.

The rest of the baseline:

```
$ curl -sSI http://127.0.0.1:3111/_next/static/chunks/00k5.dx24ut2p.js
HTTP/1.1 200 OK
Cache-Control: public, max-age=31536000, immutable     # Next's own static handler

$ curl -sSI http://127.0.0.1:3111/next.svg
HTTP/1.1 200 OK
Cache-Control: public, max-age=0                      # no must-revalidate

$ curl -sSI http://127.0.0.1:3111/does-not-exist
HTTP/1.1 404 Not Found
Cache-Control: private, no-cache, no-store, max-age=0, must-revalidate
```

Note the asymmetry in the baseline: the immutable static handler already sends an
immutable year for chunks, but the HTML shell gets a _year of shared cache_. That is
backwards relative to the risk — the chunks are the safe thing to cache, the shell is
the dangerous one.

## After — same commands, same machine, real output

```
$ npx next build && npx next start -p 3111

$ curl -sSI http://127.0.0.1:3111/ | grep -iE '^(HTTP|cache-control|etag)'
HTTP/1.1 200 OK
Cache-Control: public, max-age=0, must-revalidate
ETag: "2ds8on26fys0j"

$ curl -sSI http://127.0.0.1:3111/_next/static/chunks/00k5.dx24ut2p.js | grep -iE '^(HTTP|cache-control)'
HTTP/1.1 200 OK
Cache-Control: public, max-age=31536000, immutable

$ curl -sSI http://127.0.0.1:3111/_next/static/chunks/0be7qbv2wli4m.css | grep -iE '^(HTTP|cache-control)'
HTTP/1.1 200 OK
Cache-Control: public, max-age=31536000, immutable

$ curl -sSI http://127.0.0.1:3111/_next/static/media/02263ebadd758ea4-s.0qg7j5o.yrclm.woff2 | grep -iE '^(HTTP|cache-control)'
HTTP/1.1 200 OK
Cache-Control: public, max-age=31536000, immutable

$ curl -sSI http://127.0.0.1:3111/next.svg | grep -iE '^(HTTP|cache-control)'
HTTP/1.1 200 OK
Cache-Control: public, max-age=0, must-revalidate

$ curl -sSI http://127.0.0.1:3111/does-not-exist | grep -iE '^(HTTP|cache-control)'
HTTP/1.1 404 Not Found
Cache-Control: private, no-cache, no-store, max-age=0, must-revalidate
```

The last line is a deliberate check, not an accident: the `/:path*` catch-all also
matches 404 paths, and I expected it to loosen Next's error-page `no-store`. It does
not — Next's 404 path sets its own `Cache-Control` after route resolution, so the
stricter value survives. I verified this holds for a 404 under `/_next/static/` too
(which _is_ matched by the immutable rule):

```
$ curl -sSI http://127.0.0.1:3111/_next/static/does-not-exist.js | grep -iE '^(HTTP|cache-control)'
HTTP/1.1 404 Not Found
Cache-Control: private, no-cache, no-store, max-age=0, must-revalidate
```

## Why `max-age=0, must-revalidate` and not `no-store`

`no-store` would also have satisfied the acceptance criterion, but it throws away the
benefit of an edge cache on the document. `max-age=0, must-revalidate` still lets a
shared cache _store_ the shell, so a repeat visit is a conditional request rather than
a full body — while RFC 9111 forces revalidation because the stored entry is stale the
instant it is written. Verified end to end against the real server:

```
$ ETAG=$(curl -sSI http://127.0.0.1:3111/ | grep -i '^etag' | tr -d '\r' | cut -d' ' -f2)
$ curl -sS -o /dev/null -w "revalidate status=%{http_code}\n" -H "If-None-Match: $ETAG" http://127.0.0.1:3111/
revalidate status=304
```

So the shell is cheap on repeat visits _and_ cannot be served without asking the
origin. `stale-while-revalidate` is deliberately **not** used on the shell: it is
exactly the directive that lets a CDN answer from a stale document while it
revalidates in the background, which is the masking behaviour being removed.

## Per-decision rationale

**`/_next/static/:path*` is the whole immutable scope.** I checked the actual build
output rather than assuming: all 48 files under `.next/static/` are content-hashed
(`chunks/00k5.dx24ut2p.js`, `media/02263ebadd758ea4-s.0qg7j5o.yrclm.woff2`,
`media/favicon.0vztqa9kjur3a.ico`, generated `icon/opengraph/twitter-image` files).
Nothing mutable lives under that prefix, so a one-year `immutable` lifetime is sound.
`next/image` is not used anywhere in the repo, so there is no `/_next/image` optimizer
route to configure and I did not add a speculative rule for it.

**Unversioned `public/` files get the revalidate value, not the immutable one.**
`public/next.svg`, `vercel.svg` etc. are served from a stable, unhashed path. Marking
those `immutable` would be the same class of bug in mirror: a replaced logo would keep
serving the old bytes for a year. They fall into the catch-all and revalidate, which
also upgrades them from the baseline's `public, max-age=0` (no `must-revalidate`) to a
compliant one.

**Rule order is load-bearing, and the test guards it.** Next runs _every_ matching
rule and the last one wins (`resHeaders[key] = value` in
`next/dist/server/lib/router-utils/resolve-routes.js`). `/:path*` also matches
`/_next/static/**`, so the broad rule must come **first** and the immutable rule
**after** it; reversing them silently disables long-lived asset caching. This is
inverted from the ordering in Vercel's `cache-headers` starter, which is a
reasonable thing to get wrong, so `next.config.ts` has an explicit note and the test
asserts it.

## Files

- `next.config.ts` — the `headers()` policy, with the two `Cache-Control` constants
  and the two source patterns exported so the test asserts the real config instead of
  a copy of it.
- `next.config.test.ts` — new. Seven assertions: the literal values on both rules,
  the effective value for hashed chunks / media, the effective value for the HTML
  shell and four route paths, the revalidate value for `public/` assets, the
  ordering invariant, and a guard that no rule declared after the immutable rule can
  match `/_next/static/**`.

The test does not assert against a hand-written copy of the config. It drains the
real `headers()` array and folds the rules the way Next does (last match wins) over a
`/`-prefix matcher, and it throws on any source pattern it does not recognise so a
future third rule cannot slip past the ordering assertions.

## Verification of the test itself

A test that cannot fail is not a test, so I inverted the rule order in
`next.config.ts` and re-ran it:

```
$ npx vitest run next.config.test.ts
 ✓ defines headers()
 × marks content-hashed build output immutable for one year
   → expected 'public, max-age=0, must-revalidate' to be 'public, max-age=31536000, immutable'
 ✓ forces revalidation of the HTML shell so a deploy can never be masked
 ✓ never gives an HTML route a shared-cache TTL that could outlive a deploy
 ✓ revalidates unversioned public/ assets, which are not content-hashed
 × lists the immutable rule after the catch-all, because the last match wins
   → expected 0 to be greater than 1
 × has no rule that can re-clobber the immutable header after it
   → expected true to be false
 Tests  3 failed | 4 passed (7)
```

Restored, all seven pass. Full suite is now 38 tests across 6 files (was 31 across 5).

```
$ npm run test     # 6 files, 38 tests passed
$ npm run lint     # clean
$ npx tsc --noEmit # clean
$ npm run build    # ✓ Compiled successfully, routes generated
```

## Scope notes and what I did not do

The issue asks to "configure the caching behavior of whatever hosting platform is
already in use". There is no hosting-platform configuration in this repo — the
deploy target is not recorded anywhere in-tree — so this PR configures the behaviour
at the only layer this repository actually owns: the headers the Next server emits.
That is the portable choice: any CDN, proxy, or platform in front of the app now
receives a correct `Cache-Control` to act on, rather than relying on a
platform-specific override. Configuring the CDNs themselves is a follow-up that
depends on knowing the platform; the values to apply are the same two strings exported
from `next.config.ts`.

**Unchecked — verified correct against a real deployed build's network response with
before/after measurements, and repeatable-improvement numbers on a staging
deployment.** I could run `next build && next start` locally and `curl` the real
responses, and the before/after header evidence is above. What I cannot do from a
contributor branch is measure repeat-visit load-time improvement on a real staging
deployment, or confirm the CDN in front of it is honouring the headers. That
definition-of-done item stays with whoever deploys.

One consequence worth flagging to the team: because the HTML shell is now
`max-age=0`, the origin is hit once per repeat visit per user instead of being served
entirely from the edge. That is the deliberate trade in this issue — correctness of the
app version over origin load — and the 304 path above means the response body is not
retransferred. If origin load ever becomes the problem, the right fix is a
revision-scoped CDN rule keyed on a deploy id, not a longer `max-age` on `/`.

closes #170
