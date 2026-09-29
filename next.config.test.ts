import { describe, it, expect } from "vitest";
import nextConfig, {
  ALL_PATHS_SOURCE,
  REVALIDATE_CACHE_CONTROL,
  STATIC_ASSET_CACHE_CONTROL,
  STATIC_ASSET_SOURCE,
} from "./next.config";

type HeaderRule = {
  source: string;
  headers?: { key: string; value: string }[];
  has?: unknown[];
  missing?: unknown[];
};

// `headers()` is async; every rule is a literal, so drain it once at module scope.
const rules: HeaderRule[] = await (nextConfig.headers as () => Promise<HeaderRule[]>)();

/**
 * Whether a `headers()` rule matches `path`. Only the two source shapes declared
 * in `next.config.ts` are supported; anything else throws so a new source pattern
 * cannot silently escape the ordering assertions below.
 */
function matches(rule: HeaderRule, path: string): boolean {
  if (rule.has?.length || rule.missing?.length) {
    throw new Error(`unexpected conditional on source "${rule.source}"`);
  }
  if (rule.source === STATIC_ASSET_SOURCE) return path.startsWith("/_next/static/");
  if (rule.source === ALL_PATHS_SOURCE) return path.startsWith("/");
  throw new Error(`test helper does not know how to match source "${rule.source}"`);
}

/**
 * The `Cache-Control` a client actually receives. Next runs every matching rule
 * and the last match wins, so this is a plain last-write-wins fold.
 */
function cacheControlFor(path: string): string | undefined {
  let value: string | undefined;
  for (const rule of rules) {
    if (!matches(rule, path)) continue;
    for (const header of rule.headers ?? []) {
      if (header.key.toLowerCase() === "cache-control") value = header.value;
    }
  }
  return value;
}

describe("cache-control configuration (issue #170)", () => {
  it("defines headers()", () => {
    expect(typeof nextConfig.headers).toBe("function");
  });

  it("marks content-hashed build output immutable for one year", () => {
    expect(STATIC_ASSET_CACHE_CONTROL).toBe("public, max-age=31536000, immutable");
    expect(cacheControlFor("/_next/static/chunks/00k5.dx24ut2p.js")).toBe(
      STATIC_ASSET_CACHE_CONTROL
    );
    expect(cacheControlFor("/_next/static/media/02263ebad758ea4-s.0qg7j5o.yrclm.woff2")).toBe(
      STATIC_ASSET_CACHE_CONTROL
    );
  });

  it("forces revalidation of the HTML shell so a deploy can never be masked", () => {
    expect(REVALIDATE_CACHE_CONTROL).toBe("public, max-age=0, must-revalidate");
    expect(cacheControlFor("/")).toBe(REVALIDATE_CACHE_CONTROL);
  });

  it("never gives an HTML route a shared-cache TTL that could outlive a deploy", () => {
    for (const path of ["/", "/transactions", "/admin", "/docs"]) {
      const value = cacheControlFor(path);
      expect(value).toBeDefined();
      expect(value).not.toMatch(/s-maxage/);
      expect(value).not.toMatch(/stale-while-revalidate/);
      expect(value).toMatch(/max-age=0|no-store/);
      expect(value).toMatch(/must-revalidate/);
    }
  });

  it("revalidates unversioned public/ assets, which are not content-hashed", () => {
    expect(cacheControlFor("/next.svg")).toBe(REVALIDATE_CACHE_CONTROL);
  });

  it("lists the immutable rule after the catch-all, because the last match wins", () => {
    const catchAll = rules.findIndex((rule) => rule.source === ALL_PATHS_SOURCE);
    const immutable = rules.findIndex((rule) => rule.source === STATIC_ASSET_SOURCE);

    expect(catchAll).toBeGreaterThanOrEqual(0);
    expect(immutable).toBeGreaterThanOrEqual(0);
    // `/:path*` also matches `/_next/static/**`; listed last it would override the
    // immutable rule and silently disable long-lived asset caching.
    expect(immutable).toBeGreaterThan(catchAll);
    expect(rules.map((rule) => rule.source)).toEqual([ALL_PATHS_SOURCE, STATIC_ASSET_SOURCE]);
  });

  it("has no rule that can re-clobber the immutable header after it", () => {
    const immutable = rules.findIndex((rule) => rule.source === STATIC_ASSET_SOURCE);

    for (const rule of rules.slice(immutable + 1)) {
      expect(matches(rule, "/_next/static/chunks/00k5.dx24ut2p.js")).toBe(false);
    }
  });
});
