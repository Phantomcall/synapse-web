# Feature flags

A kill-switch and gradual-rollout layer for the Synapse UI.

## Why this exists

Deploying a change to every user at once is the failure mode this is here to
avoid. A flag gives you two things the rest of the stack does not:

- **A runtime kill-switch.** `{"flags":{"tab.admin":{"value":false}}}` removes
  the admin tab for everyone within one polling interval, with no redeploy and
  no rollback. A rollback takes minutes and its own deploy; a flag takes seconds.
- **A gradual rollout.** `{"value":true,"percentage":5}` shows a change to 5% of
  visitors first, so a bad interaction is found by a fraction of the users
  instead of all of them.

## Layout

| File               | Contents                                                           |
| ------------------ | ------------------------------------------------------------------ |
| `types.ts`         | `FlagDefinition`, `FlagOverride`, `ResolvedFlag`. No runtime code. |
| `evaluate.ts`      | Pure resolution: precedence, bucketing, env-var naming.            |
| `remoteConfig.ts`  | Fetch, validate, and cache. The only module that touches network.  |
| `definitions.ts`   | The registry, plus the tab-gating helpers.                         |
| `FlagProvider.tsx` | React context, `useFlag`, `useFlags`.                              |
| `index.ts`         | Barrel.                                                            |

The split is the point. `evaluate.ts` is a pure function of its arguments, so
the entire precedence and bucketing story is testable without a browser, a
network, or React — and it runs identically on the server and the client, which
is what keeps hydration consistent.

## Declaring a flag

Add an entry to `FLAGS` in `definitions.ts`:

```ts
"transactions.bulk-actions": {
  key: "transactions.bulk-actions",
  description: "Multi-select and bulk-sign flows on the transactions tab.",
  defaultValue: false,
  owner: "core",
},
```

### The default is the whole design

`defaultValue` is what runs when the remote config is unreachable _and_ there is
no last-known-good cache. Pick it so that a total failure of the flag system
leaves users in a state you would still be happy to ship:

- **A new capability is `false`.** Nothing appears until someone turns it on.
  The cost of forgetting is a feature that does not launch.
- **An already-shipped capability is `true`.** The flag exists only so it can be
  switched off without a deploy. If the admin RPC starts failing under load,
  you should not need a rollback to close the tab.

`tab.admin` and `tab.docs` are the second kind — they have shipped, and the flags
are kill-switches. `transactions.bulk-actions` is the first kind, and is the
worked example of a capability that cannot appear before it is enabled.

**Delete flags when they are done.** A registry of forty permanently-`true`
entries is indistinguishable from having no flags, and much harder to remove.

## Resolution order

Highest precedence first:

1. `remote.value` — runtime kill-switch, no redeploy.
2. `remote.percentage` — runtime rollout narrowing.
3. `NEXT_PUBLIC_FEATURE_FLAG_<KEY>` — build-time, for local dev and CI.
4. `registry.defaultValue` — the fail-safe.

A percentage only ever _narrows_ an already-on flag:

- `{ "value": true }` → on for everyone.
- `{ "value": true, "percentage": 5 }` → on for 5% of visitors.
- `{ "value": false }` → off for everyone, even alongside a stale percentage.
- `{ "percentage": 5 }` with `defaultValue: false` → still off. A percentage
  cannot conjure a feature that defaults off.

That last rule is deliberate: there must never be a way to enable a flag that
nobody explicitly turned on.

## Bucketing

A visitor's position in a rollout is `bucketOf(flagKey, subjectId)`, an FNV-1a
hash in `[0, 100)`. Deterministic, which matters twice over:

- A visitor does not re-roll on every page load, so a 5% rollout does not look
  like a flickering feature.
- The server and the client compute the same answer, so there is no hydration
  mismatch on a percentage flag.

The flag key is mixed into the hash so that a visitor in the lucky 5% for one
flag is not automatically in the lucky 5% for every other flag. Without that, a
partial rollout leaks one cohort into every feature simultaneously and the first
incident becomes far harder to reason about.

The subject id is a random anonymous string in `localStorage`. It is not derived
from an IP address or a wallet address on purpose: a feature rollout is not worth
making visitors correlatable across sites, and nothing is sent anywhere — the id
only feeds a local hash.

## Failure behaviour

Every one of these is a test, not a hope:

| Situation                                  | Result                                      |
| ------------------------------------------ | ------------------------------------------- |
| Remote unreachable, cache present          | Cache is used, marked stale past the window |
| Remote unreachable, no cache               | Registry defaults                           |
| Remote 5xx / 404 / timeout (3s)            | Cache, else defaults                        |
| Body is not JSON (proxy error page)        | Cache, else defaults                        |
| `localStorage` throws (private browsing)   | Flags still evaluate, ephemeral subject     |
| `value` is the string `"true"`             | Entry ignored, flag keeps its default       |
| Undeclared flag key in payload             | Ignored                                     |
| Payload is a valid map with nothing usable | Treated as "no overrides", not cached       |

Two of these deserve emphasis.

**Last-known-good, not last-known.** An expired cache is still used. Expiring it
would mean a five-minute config-service outage silently switches off a feature
that is already live for some users — turning a flag outage into a product
outage. Cache staleness is surfaced in the footer instead.

**Clearing overrides must work.** A well-formed payload with no usable entries
resolves to "no overrides" rather than falling back to cache. Otherwise an
operator who removes the last override could never turn a flag off. Only
transport failures and structurally broken payloads fall back to cache.

## Using a flag

```tsx
const bulkActions = useFlag("transactions.bulk-actions");
return bulkActions ? <BulkActionBar /> : null;
```

`useFlag` outside a provider returns the registry default rather than throwing,
so a component can be unit-tested in isolation.

For a tab, gate the tab list rather than just the body — an invisible-but-active
tab is worse than a missing one. `visibleTabs` and `resolveActiveTab` in
`definitions.ts` handle this, including the case where a tab is switched off
_while the user is looking at it_, which would otherwise blank the content area.

## Configuration

| Variable                         | Purpose                                     |
| -------------------------------- | ------------------------------------------- |
| `NEXT_PUBLIC_FEATURE_FLAGS_URL`  | Config endpoint. Unset → registry defaults. |
| `NEXT_PUBLIC_FEATURE_FLAG_<KEY>` | Build-time override for one flag.           |

## Testing

```bash
npm run test:coverage
```

Coverage is scoped to `lib/flags/**` with an 85% threshold, enforced in CI. The
`index.ts` barrel and the type-only `types.ts` are excluded: neither contains
executable logic, so reporting them as 0% covered would be a misleading number.

## Adding a remote override for a percentage rollout

```json
{
  "flags": {
    "tab.admin": { "value": true, "percentage": 25 },
    "tab.docs": { "value": false }
  }
}
```

Point `NEXT_PUBLIC_FEATURE_FLAGS_URL` at wherever that JSON is served. The
payload is fetched from the browser, so it must be CORS-enabled for the app's
origin. Static file hosts (S3, GCS, GitHub Pages) are sufficient; no server-side
component is required. If the endpoint is slow, the 3s timeout gives up and the
cache takes over.
