import type { FlagOverride } from "./types";

/**
 * Fetching and caching the remote flag config.
 *
 * Design constraints, in priority order:
 *
 *   1. **Never throw into React.** A flag source going down is an expected
 *      operational event, not an application error. Every failure path here
 *      resolves to a value; none of them rejects.
 *   2. **Never flip a flag off because of a network problem.** A fetch failure
 *      falls back to the last-known-good cache, and only to registry defaults
 *      when there is no cache. So an outage degrades the rollout, it does not
 *      silently disable a feature that is already live for some users.
 *   3. **Never trust the payload.** It is third-party JSON. Every field is
 *      validated independently so one bad key cannot invalidate a good config.
 */

export const CACHE_KEY = "synapse:feature-flags:v1";

/**
 * How long a cached payload is considered fresh enough to display as current.
 * Beyond this it is still *used* — it is just reported as `stale` so the
 * dashboard can say so. Expiring a flag config would mean a brief outage
 * silently reverts behaviour, which is the failure mode we are avoiding.
 */
export const FRESHNESS_WINDOW_MS = 5 * 60 * 1000;

/** Abort a slow config endpoint rather than waiting on it indefinitely. */
export const DEFAULT_TIMEOUT_MS = 3000;

export interface RemoteFlags {
  readonly overrides: Record<string, FlagOverride>;
  readonly fetchedAt: number;
  readonly etag?: string;
}

export interface LoadResult {
  readonly overrides: Record<string, FlagOverride>;
  /** Where the overrides came from, for the debug surface. */
  readonly source: "remote" | "cache" | "empty";
  /** True when the cache is past the freshness window. */
  readonly stale: boolean;
  /** Present on every non-`remote` path, for logging. Never fatal. */
  readonly error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate and sanitise a remote payload.
 *
 * Returns the subset of entries that are fully well-formed; a malformed key
 * drops out on its own without discarding its siblings. `null` means the
 * payload is not a flag map at all and the caller should fall back to cache.
 *
 * The distinction between `{}` and `null` is load-bearing and deliberately
 * narrow. `{}` means "this endpoint answered, and it has no overrides for you",
 * which is a legitimate answer and must *not* be served from cache — otherwise
 * deliberately clearing all overrides would never take effect. `null` means
 * "this is not a flag config", and only that is a fallback-to-cache condition,
 * alongside transport failures (non-2xx, timeout, network error, unparseable
 * body).
 *
 * Known keys are checked against the registry so an undeclared flag in the
 * payload is ignored — otherwise anyone who can write to the config endpoint
 * could invent flags the app happens to read.
 */
export function validateRemoteFlags(
  raw: unknown,
  knownKeys?: ReadonlySet<string> | readonly string[]
): Record<string, FlagOverride> | null {
  if (!isRecord(raw)) return null;
  const flags = raw.flags ?? raw;
  if (!isRecord(flags)) return null;

  const known = knownKeys instanceof Set ? knownKeys : knownKeys ? new Set(knownKeys) : null;
  const out: Record<string, FlagOverride> = {};

  for (const [key, value] of Object.entries(flags)) {
    if (known && !known.has(key)) continue;
    if (!isRecord(value)) continue;

    const override: FlagOverride = {};
    let hasAny = false;

    if (typeof value.value === "boolean") {
      override.value = value.value;
      hasAny = true;
    } else if (value.value !== undefined) {
      // `value: "true"` is the classic hand-edited-JSON mistake. Ignore it
      // rather than guessing, so the flag stays on its default.
      continue;
    }

    if (typeof value.percentage === "number" && Number.isFinite(value.percentage)) {
      override.percentage = value.percentage;
      hasAny = true;
    } else if (value.percentage !== undefined) {
      // A bad percentage must not silently become "no percentage", which would
      // read as a full enable. Keep an explicit value if there was one.
      if (override.value === undefined) continue;
    }

    if (!hasAny) continue;
    out[key] = override;
  }

  return out;
}

/** Parse a raw response body. Returns `null` on non-JSON. */
export function parseRemoteFlags(
  body: string,
  knownKeys?: readonly string[]
): Record<string, FlagOverride> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  return validateRemoteFlags(parsed, knownKeys);
}

/** A Storage that is safe to call in environments where it throws. */
type SafeStorage = Pick<Storage, "getItem" | "setItem" | "removeItem"> | null | undefined;

function readItem(storage: SafeStorage, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    // Safari private browsing and hardened browser settings throw on access.
    // A missing cache is always survivable, so swallow it here.
    return null;
  }
}

function writeItem(storage: SafeStorage, key: string, value: string): void {
  try {
    storage?.setItem(key, value);
  } catch {
    // Quota exceeded, or storage disabled. The flag still works for this
    // page view; it just will not survive a reload.
  }
}

/** Read the last-known-good payload. Returns `null` if absent or unusable. */
export function readCache(storage: SafeStorage, knownKeys?: readonly string[]): RemoteFlags | null {
  const raw = readItem(storage, CACHE_KEY);
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupt entry: drop it so we do not re-parse a bad value on every load.
    try {
      storage?.removeItem(CACHE_KEY);
    } catch {
      /* ignore */
    }
    return null;
  }
  if (!isRecord(parsed)) return null;
  // The cache envelope is { overrides, fetchedAt, etag }; only `overrides` is a
  // flag payload, so unwrap before validating rather than letting the envelope's
  // own keys be validated as flags.
  const overrides = validateRemoteFlags({ flags: parsed.overrides }, knownKeys);
  if (overrides === null) return null;
  const fetchedAt = typeof parsed.fetchedAt === "number" ? parsed.fetchedAt : 0;
  return {
    overrides,
    fetchedAt,
    etag: typeof parsed.etag === "string" ? parsed.etag : undefined,
  };
}

/** Persist a payload as last-known-good. */
export function writeCache(storage: SafeStorage, flags: RemoteFlags): void {
  writeItem(
    storage,
    CACHE_KEY,
    JSON.stringify({ overrides: flags.overrides, fetchedAt: flags.fetchedAt, etag: flags.etag })
  );
}

export interface LoadOptions {
  /** Endpoint returning the flag config. Omit to skip the network entirely. */
  readonly url?: string | undefined;
  readonly storage?: SafeStorage;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly now?: number;
  readonly knownKeys?: readonly string[];
  /** Send `If-None-Match` with the cached etag. */
  readonly etag?: string;
}

/**
 * Resolve the effective overrides, preferring fresh remote, then last-known-good
 * cache, then nothing (registry defaults apply).
 *
 * Never rejects and never throws. Every failure is reported via `error` and
 * falls through to the next source.
 */
export async function loadFlags(options: LoadOptions): Promise<LoadResult> {
  const { url, storage, knownKeys, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  const now = options.now ?? Date.now();
  const cache = readCache(storage, knownKeys);
  const fromCache = (error: string): LoadResult => ({
    overrides: cache?.overrides ?? {},
    source: cache ? "cache" : "empty",
    stale: cache ? now - cache.fetchedAt > FRESHNESS_WINDOW_MS : false,
    error,
  });

  if (!url) {
    return cache
      ? {
          overrides: cache.overrides,
          source: "cache",
          stale: now - cache.fetchedAt > FRESHNESS_WINDOW_MS,
          error: "no remote url configured",
        }
      : { overrides: {}, source: "empty", stale: false, error: "no remote url configured" };
  }

  const doFetch = options.fetchImpl ?? (typeof fetch === "function" ? fetch : undefined);
  if (!doFetch) return fromCache("fetch unavailable");

  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer =
    controller && timeoutMs > 0
      ? setTimeout(() => {
          controller.abort();
        }, timeoutMs)
      : null;

  try {
    const headers: Record<string, string> = { accept: "application/json" };
    const etag = options.etag ?? cache?.etag;
    if (etag) headers["if-none-match"] = etag;

    const response = await doFetch(url, { signal: controller?.signal, headers, cache: "no-store" });

    if (response.status === 304 && cache) {
      // Not modified: the cache is authoritative and still fresh.
      return {
        overrides: cache.overrides,
        source: "cache",
        stale: now - cache.fetchedAt > FRESHNESS_WINDOW_MS,
      };
    }
    if (!response.ok) {
      return fromCache(`remote responded ${response.status}`);
    }

    const body = await response.text();
    const overrides = parseRemoteFlags(body, knownKeys);
    if (overrides === null) {
      return fromCache("remote payload was not a usable flag config");
    }

    const nextEtag = response.headers?.get?.("etag") ?? undefined;
    writeCache(storage, { overrides, fetchedAt: now, etag: nextEtag });
    return { overrides, source: "remote", stale: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const reason = /abort/i.test(message)
      ? `remote timed out after ${timeoutMs}ms`
      : `remote fetch failed: ${message}`;
    return fromCache(reason);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
