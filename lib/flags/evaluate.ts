import type { FlagDefinition, FlagOverride, ResolvedFlag } from "./types";

/**
 * Pure flag evaluation. No network, no storage, no React — every function here
 * is a total function over its arguments so it can be tested exhaustively and
 * reused on the server.
 */

/**
 * FNV-1a, 32-bit. Used to map (flag, subject) pairs onto a stable bucket.
 *
 * Chosen over `Math.random()` for two reasons: a subject's bucket must not
 * change between page loads, or a 10% rollout would re-shuffle every visitor on
 * every refresh; and it must not change between the server and the client, or
 * SSR and the first client render would disagree about whether a feature is on.
 * Hashing a stable string gives both for free.
 */
export function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // hash * 16777619, via shifts, to stay inside 32-bit integer math.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Deterministically place a subject into a bucket in `[0, 100)`.
 *
 * The flag key is mixed in so that a subject who is in the lucky 10% for one
 * flag is not automatically in the lucky 10% for every other flag — otherwise a
 * partial rollout leaks a cohort of users across every feature at once, which
 * makes the first incident far harder to reason about.
 */
export function bucketOf(flagKey: string, subjectId: string): number {
  // Modulo 10_000 rather than 100 for two decimal places of resolution, so
  // small percentages (1%, 0.5%) are representable instead of rounding to 0.
  return (fnv1a(`${flagKey}:${subjectId}`) % 10_000) / 100;
}

/** True when the subject falls inside a `[0, percentage)` rollout. */
export function isInRollout(flagKey: string, subjectId: string, percentage: number): boolean {
  return bucketOf(flagKey, subjectId) < percentage;
}

/** The env var a flag reads when no `envVar` is declared explicitly. */
export function envVarFor(flag: FlagDefinition): string {
  if (flag.envVar) return flag.envVar;
  return `NEXT_PUBLIC_FEATURE_FLAG_${flag.key.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}

function clampPercentage(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

export interface ResolveOptions {
  /**
   * Remote override from the fetched config, if any. A sanitised remote
   * payload — `validateRemoteFlags` is responsible for rejecting garbage before
   * it gets here.
   */
  readonly remote?: FlagOverride | undefined;
  /** Parsed env value, if any. Truthy strings enable the flag. */
  readonly env?: string | undefined;
  /**
   * Stable per-visitor id. Any string works; bucketing is a hash so the id
   * never needs to be meaningful. A fresh random id per page load would defeat
   * the purpose of a percentage rollout, which is why the caller is responsible
   * for persisting it.
   */
  readonly subjectId: string;
  /** Set when the supplied remote value came from a stale cache. */
  readonly stale?: boolean;
}

/**
 * Resolve one flag to a concrete on/off value.
 *
 * Precedence, highest first:
 *   1. remote `value`   — runtime kill-switch, no redeploy
 *   2. remote `percentage` — runtime rollout narrowing
 *   3. env              — build-time override, for local dev / CI
 *   4. registry default — the fail-safe
 *
 * A percentage only ever *narrows*. Remote `{ value: true }` with no percentage
 * is a full enable; `{ value: true, percentage: 5 }` is a 5% launch; the
 * registry's `defaultValue: true` with `rollout.percentage: 25` is the same
 * thing declared at build time. There is deliberately no way to express
 * "percentage without a value" — every percentage has an explicit owner.
 */
export function resolveFlag(flag: FlagDefinition, options: ResolveOptions): ResolvedFlag {
  const { remote, env, subjectId, stale = false } = options;

  const remoteHasValue = typeof remote?.value === "boolean";
  const envOn = env !== undefined && env !== "" && env !== "0" && env !== "false";

  let value: boolean;
  let source: ResolvedFlag["source"];
  if (remoteHasValue) {
    value = remote!.value as boolean;
    source = "remote";
  } else if (env !== undefined && env !== "") {
    value = envOn;
    source = "env";
  } else {
    value = flag.defaultValue;
    source = "default";
  }

  // Remote percentage wins over the registry rollout: it is the more recent
  // instruction. Absent remotely, fall back to the build-time rollout.
  const rawPercentage = remote?.percentage ?? flag.rollout?.percentage;
  const hasPercentage = rawPercentage !== undefined;
  const percentage = hasPercentage ? clampPercentage(rawPercentage as number) : null;

  if (percentage !== null && value) {
    // Only narrow an already-on flag, so a `{ value: false }` kill-switch is
    // never accidentally re-enabled by a leftover percentage.
    value = isInRollout(flag.key, subjectId, percentage);
  }

  return { key: flag.key, value, source, percentage, stale };
}

/**
 * Resolve a whole registry against one set of overrides.
 *
 * Unknown keys in `overrides` are ignored rather than validated here — the
 * remote payload validator is the only place that decides what a well-formed
 * flag key is, so validation lives in exactly one spot.
 */
export function resolveAll(
  registry: Record<string, FlagDefinition>,
  overrides: Record<string, FlagOverride>,
  options: { subjectId: string; env?: Record<string, string | undefined>; stale?: boolean }
): Record<string, ResolvedFlag> {
  const out: Record<string, ResolvedFlag> = {};
  for (const key of Object.keys(registry)) {
    const flag = registry[key];
    if (!flag) continue;
    out[key] = resolveFlag(flag, {
      remote: overrides[key],
      env: options.env?.[envVarFor(flag)] ?? options.env?.[key],
      subjectId: options.subjectId,
      stale: options.stale,
    });
  }
  return out;
}
