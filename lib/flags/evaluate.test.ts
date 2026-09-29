import { describe, expect, it } from "vitest";
import { bucketOf, envVarFor, fnv1a, isInRollout, resolveAll, resolveFlag } from "./evaluate";
import { FLAGS, REGISTRY, resolveActiveTab, visibleTabs, type FlagKey } from "./definitions";
import type { FlagDefinition } from "./types";

const TAB_ADMIN = FLAGS["tab.admin"];
const BULK = FLAGS["transactions.bulk-actions"];

const flag = (over: Partial<FlagDefinition> = {}): FlagDefinition => ({
  key: "test.flag",
  description: "test",
  defaultValue: false,
  ...over,
});

const enabled = (keys: FlagKey[]) => (key: FlagKey) => keys.includes(key);

describe("fnv1a", () => {
  it("is deterministic", () => {
    expect(fnv1a("tab.admin:anon-1")).toBe(fnv1a("tab.admin:anon-1"));
  });

  it("matches the reference FNV-1a 32-bit vectors", () => {
    // Guards against an accidental change to the hash that would silently
    // reshuffle every existing rollout cohort.
    expect(fnv1a("")).toBe(0x811c9dc5);
    expect(fnv1a("a")).toBe(0xe40c292c);
    expect(fnv1a("foobar")).toBe(0xbf9cf968);
  });

  it("stays inside 32-bit unsigned range for long and unicode input", () => {
    for (const input of ["x".repeat(1000), "日本語のフラグ", "🔑🚀"]) {
      const hash = fnv1a(input);
      expect(Number.isInteger(hash)).toBe(true);
      expect(hash).toBeGreaterThanOrEqual(0);
      expect(hash).toBeLessThanOrEqual(0xffffffff);
    }
  });
});

describe("bucketOf", () => {
  it("always lands in [0, 100)", () => {
    for (let i = 0; i < 500; i++) {
      const bucket = bucketOf("tab.admin", `anon-${i}`);
      expect(bucket).toBeGreaterThanOrEqual(0);
      expect(bucket).toBeLessThan(100);
    }
  });

  it("is stable for the same subject", () => {
    expect(bucketOf("tab.admin", "anon-42")).toBe(bucketOf("tab.admin", "anon-42"));
  });

  it("gives a different subject a different bucket for the same flag", () => {
    const buckets = new Set(
      Array.from({ length: 50 }, (_, i) => bucketOf("tab.admin", `anon-${i}`))
    );
    expect(buckets.size).toBeGreaterThan(40);
  });

  it("decorrelates flags so one subject is not in every cohort at once", () => {
    // Same subject, different flags: the buckets must not be identical, or a
    // 10% rollout would leak a single cohort into every feature.
    const buckets = ["tab.admin", "tab.docs", "transactions.bulk-actions"].map((f) =>
      bucketOf(f, "anon-7")
    );
    expect(new Set(buckets).size).toBe(3);
  });

  it("distributes roughly uniformly", () => {
    const buckets = Array.from({ length: 2000 }, (_, i) => bucketOf("tab.admin", `anon-${i}`));
    const under50 = buckets.filter((b) => b < 50).length;
    expect(under50).toBeGreaterThan(900);
    expect(under50).toBeLessThan(1100);
  });
});

describe("isInRollout", () => {
  it("includes everyone at 100% and nobody at 0%", () => {
    for (let i = 0; i < 100; i++) {
      expect(isInRollout("tab.admin", `anon-${i}`, 100)).toBe(true);
      expect(isInRollout("tab.admin", `anon-${i}`, 0)).toBe(false);
    }
  });

  it("keeps the 10% cohort stable across calls", () => {
    const inCohort = Array.from({ length: 200 }, (_, i) =>
      isInRollout("tab.docs", `anon-${i}`, 10)
    );
    const again = Array.from({ length: 200 }, (_, i) => isInRollout("tab.docs", `anon-${i}`, 10));
    expect(inCohort).toEqual(again);
  });

  it("is monotonic: a wider rollout never excludes someone a narrower one included", () => {
    for (let i = 0; i < 200; i++) {
      const subject = `anon-${i}`;
      let previous = isInRollout("tab.admin", subject, 0);
      for (const pct of [5, 10, 25, 50, 75, 100]) {
        const inNow = isInRollout("tab.admin", subject, pct);
        if (previous && !inNow) throw new Error(`monotonicity broken at ${pct}% for ${subject}`);
        previous = inNow;
      }
    }
  });
});

describe("envVarFor", () => {
  it("derives NEXT_PUBLIC_FEATURE_FLAG_<KEY> by default", () => {
    expect(envVarFor(flag({ key: "tab.admin" }))).toBe("NEXT_PUBLIC_FEATURE_FLAG_TAB_ADMIN");
    expect(envVarFor(flag({ key: "transactions.bulk-actions" }))).toBe(
      "NEXT_PUBLIC_FEATURE_FLAG_TRANSACTIONS_BULK_ACTIONS"
    );
  });

  it("honours an explicit envVar", () => {
    expect(envVarFor(flag({ key: "x", envVar: "CUSTOM_FLAG" }))).toBe("CUSTOM_FLAG");
  });

  it("produces a valid identifier for keys with unusual characters", () => {
    expect(envVarFor(flag({ key: "weird key.with/chars" }))).toBe(
      "NEXT_PUBLIC_FEATURE_FLAG_WEIRD_KEY_WITH_CHARS"
    );
  });
});

describe("resolveFlag precedence", () => {
  it("falls back to the registry default with no overrides", () => {
    expect(resolveFlag(TAB_ADMIN, { subjectId: "s" }).value).toBe(true);
    expect(resolveFlag(BULK, { subjectId: "s" }).value).toBe(false);
    expect(resolveFlag(TAB_ADMIN, { subjectId: "s" }).source).toBe("default");
  });

  it("lets remote value win over env and default", () => {
    const resolved = resolveFlag(TAB_ADMIN, { subjectId: "s", env: "1", remote: { value: false } });
    expect(resolved.value).toBe(false);
    expect(resolved.source).toBe("remote");
  });

  it("lets env win over the default when there is no remote", () => {
    const resolved = resolveFlag(BULK, { subjectId: "s", env: "true" });
    expect(resolved.value).toBe(true);
    expect(resolved.source).toBe("env");
  });

  it("treats an empty env value as unset, and 0/false as off", () => {
    // An empty string is "not configured" (a NEXT_PUBLIC_ var declared but
    // blank), so it must fall through to the default rather than force the flag
    // off and silently break a shipped feature.
    expect(resolveFlag(TAB_ADMIN, { subjectId: "s", env: "" }).value).toBe(true);
    expect(resolveFlag(TAB_ADMIN, { subjectId: "s", env: "" }).source).toBe("default");
    for (const env of ["0", "false"]) {
      const resolved = resolveFlag(TAB_ADMIN, { subjectId: "s", env });
      expect(resolved.value).toBe(false);
      expect(resolved.source).toBe("env");
    }
  });

  it("uses a remote kill-switch to disable a flag for everyone", () => {
    // Percentage is present but must not re-enable a flag that is off.
    const resolved = resolveFlag(TAB_ADMIN, {
      subjectId: "s",
      remote: { value: false, percentage: 100 },
    });
    expect(resolved.value).toBe(false);
  });

  it("applies a remote percentage to narrow an enabled flag", () => {
    const results = Array.from({ length: 100 }, (_, i) =>
      resolveFlag(TAB_ADMIN, { subjectId: `anon-${i}`, remote: { value: true, percentage: 10 } })
    );
    const on = results.filter((r) => r.value).length;
    expect(on).toBeGreaterThan(0);
    expect(on).toBeLessThan(30);
    expect(results[0]?.percentage).toBe(10);
  });

  it("ignores a remote percentage when the flag is off by default", () => {
    // A percentage must never conjure a feature that defaults off.
    const results = Array.from({ length: 50 }, (_, i) =>
      resolveFlag(BULK, { subjectId: `anon-${i}`, remote: { percentage: 100 } })
    );
    expect(results.every((r) => r.value === false)).toBe(true);
  });

  it("applies the registry rollout when there is no remote percentage", () => {
    const rolled = flag({ defaultValue: true, rollout: { percentage: 0 } });
    expect(resolveFlag(rolled, { subjectId: "s" }).value).toBe(false);
  });

  it("lets a remote percentage override the registry rollout", () => {
    const rolled = flag({ defaultValue: true, rollout: { percentage: 0 } });
    expect(resolveFlag(rolled, { subjectId: "s", remote: { percentage: 100 } }).value).toBe(true);
  });

  it("clamps out-of-range and non-finite percentages", () => {
    expect(
      resolveFlag(TAB_ADMIN, { subjectId: "s", remote: { value: true, percentage: 999 } }).value
    ).toBe(true);
    expect(
      resolveFlag(TAB_ADMIN, { subjectId: "s", remote: { value: true, percentage: -5 } }).value
    ).toBe(false);
    expect(
      resolveFlag(TAB_ADMIN, { subjectId: "s", remote: { value: true, percentage: NaN } }).value
    ).toBe(false);
  });

  it("reports staleness through to the resolved flag", () => {
    expect(resolveFlag(TAB_ADMIN, { subjectId: "s", stale: true }).stale).toBe(true);
    expect(resolveFlag(TAB_ADMIN, { subjectId: "s" }).stale).toBe(false);
  });
});

describe("resolveAll", () => {
  it("resolves every registry key", () => {
    const resolved = resolveAll(REGISTRY, {}, { subjectId: "s" });
    expect(Object.keys(resolved).sort()).toEqual(Object.keys(REGISTRY).sort());
  });

  it("ignores overrides for undeclared keys", () => {
    const resolved = resolveAll(REGISTRY, { "not.a.flag": { value: true } }, { subjectId: "s" });
    expect(resolved["not.a.flag"]).toBeUndefined();
  });

  it("accepts env overrides keyed by env var name or by flag key", () => {
    const byEnvVar = resolveAll(
      REGISTRY,
      {},
      { subjectId: "s", env: { NEXT_PUBLIC_FEATURE_FLAG_TAB_DOCS: "0" } }
    );
    expect(byEnvVar["tab.docs"]?.value).toBe(false);
    const byKey = resolveAll(REGISTRY, {}, { subjectId: "s", env: { "tab.docs": "0" } });
    expect(byKey["tab.docs"]?.value).toBe(false);
  });
});

describe("visibleTabs", () => {
  const tabs = ["dashboard", "transactions", "admin", "docs"] as const;

  it("keeps ungated tabs regardless of flag state", () => {
    expect(visibleTabs(tabs, enabled([]))).toEqual(["dashboard", "transactions"]);
  });

  it("keeps everything when both flags are on", () => {
    expect(visibleTabs(tabs, enabled(["tab.admin", "tab.docs"]))).toEqual([...tabs]);
  });

  it("gates a single tab off", () => {
    // Only tab.docs is enabled, so admin drops out and docs stays.
    expect(visibleTabs(tabs, enabled(["tab.docs"]))).toEqual(["dashboard", "transactions", "docs"]);
  });
});

describe("resolveActiveTab", () => {
  const tabs = ["dashboard", "transactions", "admin", "docs"] as const;

  it("keeps the active tab when it is still visible", () => {
    expect(resolveActiveTab(tabs, "transactions", enabled(["tab.docs"]))).toBe("transactions");
  });

  it("moves the user off a tab that was switched off while open", () => {
    // The important case: the flag changes under the user mid-session.
    expect(resolveActiveTab(tabs, "admin", enabled([]))).toBe("dashboard");
    expect(resolveActiveTab(tabs, "docs", enabled([]))).toBe("dashboard");
  });

  it("returns null when every tab is gated off, surfacing the misconfiguration", () => {
    expect(resolveActiveTab(tabs, "dashboard", () => true)).toBe("dashboard");
    expect(resolveActiveTab([], "dashboard", enabled([]))).toBeNull();
  });

  it("matches the registry defaults when no flag is enabled", () => {
    // Sanity check tying the helper to the real registry: with remote config
    // unreachable, the defaults must reproduce today's UI exactly.
    const predicate = (key: FlagKey) => REGISTRY[key]?.defaultValue ?? false;
    expect(visibleTabs(tabs, predicate)).toEqual([...tabs]);
  });
});
