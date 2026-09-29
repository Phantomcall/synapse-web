/**
 * Canonical tab registry.
 *
 * The shell has always kept its tab in React state, which meant the four tabs
 * shared one URL (`/`). That is fine for a local dev session but it has two
 * costs that bite us elsewhere:
 *
 *  1. Lighthouse can only audit a URL, so a single-URL app yields a single
 *     number no matter how many tabs it has. Auditing `/` four times and
 *     labelling the results "dashboard / transactions / admin / docs" would be
 *     four identical measurements wearing four different names — worse than
 *     useless, because it looks like per-tab coverage.
 *  2. A tab is not linkable, so it cannot be deep-linked, bookmarked, or
 *     restored on reload.
 *
 * Making each tab a statically-prerendered route segment fixes both. It is
 * deliberately *not* a query parameter: `useSearchParams()` in a statically
 * prerendered page either fails the build without a Suspense boundary or
 * forces the page dynamic, and a dynamic page would make the very Web Vitals we
 * are trying to measure worse. Route segments stay static, hydrate cleanly, and
 * give each tab its own HTML and its own Lighthouse report.
 *
 * This module is the single source of truth for the tab list. `lighthouserc.js`
 * derives its route list from it at config load, so adding a tab here is
 * enough to get it audited — see `TAB_ROUTES`.
 */

export const TABS = ["dashboard", "transactions", "admin", "docs"] as const;

export type Tab = (typeof TABS)[number];

/** The tab shown when no tab is in the path, i.e. at `/`. */
export const DEFAULT_TAB: Tab = "dashboard";

/** Type guard for an untrusted value (a route param, a query string, config). */
export function isTab(value: unknown): value is Tab {
  return typeof value === "string" && (TABS as readonly string[]).includes(value);
}

/**
 * Resolves a tab from a URL pathname, falling back to {@link DEFAULT_TAB}.
 *
 * `next/navigation`'s dynamic-segment params are `string | string[] | undefined`
 * depending on the catch-all shape, and this is also called with hand-written
 * pathnames in tests, so everything non-conforming lands on the default rather
 * than throwing. A trailing slash is tolerated because `next start` and various
 * proxies normalise inconsistently.
 */
export function tabFromPathname(pathname: string | null | undefined): Tab {
  if (typeof pathname !== "string") return DEFAULT_TAB;

  const segments = pathname.split("/").filter(Boolean);
  // `/` has no segments; `/dashboard` has one. Anything deeper is not a tab
  // route and must not silently resolve to the first segment.
  if (segments.length !== 1) return DEFAULT_TAB;

  const candidate = segments[0];
  return isTab(candidate) ? candidate : DEFAULT_TAB;
}

/** Canonical path for a tab. `/dashboard` rather than `` (bare). */
export function tabPath(tab: Tab): string {
  return `/${tab}`;
}

/**
 * Every tab as an absolute-path route, for tooling that audits "the app's
 * routes".
 *
 * `lighthouserc.js` is loaded by `@lhci/cli` through Node's `require`, so it
 * cannot import this TypeScript module at runtime. It therefore restates the
 * route list in plain JS, and `lib/tabs.test.ts` reads that file and asserts
 * the two agree — so the audited route list cannot silently drift away from the
 * tabs the app actually ships, without paying for a build step in CI.
 */
export const TAB_ROUTES: readonly string[] = TABS.map(tabPath);
