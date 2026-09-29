/**
 * Feature-flag types.
 *
 * Flags are deliberately boring: an on/off value, optionally narrowed to a
 * percentage of subjects. No variant strings, no typed payloads, no
 * experimentation platform. See `./README.md` for why that boundary was drawn
 * where it is.
 */

/** What a flag resolves to at runtime. */
export type FlagValue = boolean | number | string;

/**
 * A remotely-supplied override for one flag.
 *
 * A remote payload is untrusted input — it is JSON fetched from a third party at
 * runtime — so an override is only ever applied after validation, and every
 * field is independently optional. A malformed or partial override degrades to
 * the registry default rather than throwing.
 */
export interface FlagOverride {
  /**
   * Explicit on/off. Highest precedence, and the kill-switch: sending
   * `{ "value": false }` turns the flag off for everyone regardless of any
   * rollout percentage.
   */
  value?: boolean;
  /**
   * Percentage of subjects the flag applies to, 0–100. Narrows an already-on
   * flag: it is only consulted when the resolved value is `true`. A rollout of
   * `0` therefore disables the flag, and `100` is equivalent to omitting it.
   */
  percentage?: number;
}

/** A flag as declared in the registry, i.e. the build-time truth. */
export interface FlagDefinition {
  /** Stable identifier. Also the env-var suffix, uppercased. */
  readonly key: string;
  /** Why the flag exists and what it gates. Shown in the docs table. */
  readonly description: string;
  /**
   * The value used whenever no remote or env override applies. This is the
   * fail-safe: when the remote config source is unreachable *and* there is no
   * last-known-good cache, this is what resolves.
   *
   * New flags must be declared `false`. A flag declared `true` exists to give
   * something already shipped an instant kill-switch, and should be removed
   * once the feature is fully rolled out.
   */
  readonly defaultValue: boolean;
  /**
   * Optional build-time rollout, in percent. `defaultValue: true` with
   * `rollout: { percentage: 25 }` means "on for a quarter of users by default",
   * which is how a gradual launch is expressed without touching remote config.
   */
  readonly rollout?: { readonly percentage: number };
  /**
   * Optional build-time env override name, defaults to
   * `NEXT_PUBLIC_FEATURE_FLAG_<KEY uppercased, - and . replaced by _>`.
   * Useful for local development and for forcing a flag on in CI without
   * touching the registry. Read at build time, so it is *not* a way to change a
   * flag without a redeploy — that is what the remote source is for.
   */
  readonly envVar?: string;
  /** Who to ask when this flag needs changing. */
  readonly owner?: string;
}

/** The full registry, keyed by flag key. */
export type FlagRegistry = Record<string, FlagDefinition>;

/** Where a resolved flag value came from. Useful for the debug surface. */
export type FlagSource = "remote" | "cache" | "env" | "default";

/** The result of resolving one flag. */
export interface ResolvedFlag {
  readonly key: string;
  readonly value: boolean;
  readonly source: FlagSource;
  /** The percentage actually applied, or `null` for a plain on/off. */
  readonly percentage: number | null;
  /** True when the value came from a cached payload older than the freshness window. */
  readonly stale: boolean;
}
