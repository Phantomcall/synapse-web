"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { envVarFor, resolveAll } from "./evaluate";
import { FLAGS, FLAG_KEYS, type FlagKey } from "./definitions";
import { loadFlags } from "./remoteConfig";
import type { FlagOverride, ResolvedFlag } from "./types";

/**
 * React bindings for the flag system.
 *
 * The one subtlety worth stating: the initial render deliberately resolves
 * against **defaults only** — no storage read, no fetch. localStorage is
 * unavailable during SSR, so reading it would make the server render disagree
 * with the client's first render and trip a hydration mismatch, which is a
 * worse outcome than evaluating defaults for one frame. The remote config
 * arrives in an effect immediately afterwards, so the window where a visitor
 * sees a flag's default instead of its live value is a single tick, and it is
 * the *safe* direction: the default is the fail-safe by construction.
 */

const SUBJECT_KEY = "synapse:flag-subject:v1";

function readEnv(): Record<string, string | undefined> {
  // `process.env.NEXT_PUBLIC_*` is inlined at build time, so the keys must be
  // referenced statically. Reading them dynamically would yield undefined.
  return {
    NEXT_PUBLIC_FEATURE_FLAG_TAB_ADMIN: process.env.NEXT_PUBLIC_FEATURE_FLAG_TAB_ADMIN,
    NEXT_PUBLIC_FEATURE_FLAG_TAB_DOCS: process.env.NEXT_PUBLIC_FEATURE_FLAG_TAB_DOCS,
    NEXT_PUBLIC_FEATURE_FLAG_TRANSACTIONS_BULK_ACTIONS:
      process.env.NEXT_PUBLIC_FEATURE_FLAG_TRANSACTIONS_BULK_ACTIONS,
  };
}

/**
 * A stable, anonymous id used only for percentage bucketing.
 *
 * Persisted so a visitor does not re-roll on every load — a 10% rollout that
 * reshuffled each refresh would look like the flag was flickering. Random rather
 * than derived from an IP or a wallet address on purpose: it must not be
 * correlatable across sites or with an identity, and a feature rollout is not
 * worth that. Nothing is sent anywhere; the id only feeds a local hash.
 */
function getSubjectId(): string {
  try {
    const existing = window.localStorage.getItem(SUBJECT_KEY);
    if (existing) return existing;
    const generated = `anon-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
    window.localStorage.setItem(SUBJECT_KEY, generated);
    return generated;
  } catch {
    // Storage blocked. Flags still resolve; a percentage rollout just re-rolls
    // per load, which is a lesser evil than crashing the shell.
    return "ephemeral";
  }
}

export interface FlagContextValue {
  readonly flags: Record<string, ResolvedFlag>;
  readonly isEnabled: (key: FlagKey) => boolean;
  readonly status: "loading" | "ready";
  readonly source: "remote" | "cache" | "empty";
  readonly stale: boolean;
  readonly lastError?: string;
  readonly refresh: () => void;
}

const FlagContext = createContext<FlagContextValue | null>(null);

export interface FlagProviderProps {
  readonly children: React.ReactNode;
  /** Overrides `NEXT_PUBLIC_FEATURE_FLAGS_URL`. */
  readonly url?: string;
  /** Injected in tests. */
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export function FlagProvider({ children, url, fetchImpl, timeoutMs }: FlagProviderProps) {
  const [overrides, setOverrides] = useState<Record<string, FlagOverride>>({});
  const [meta, setMeta] = useState<{
    source: FlagContextValue["source"];
    stale: boolean;
    error?: string;
  }>({
    source: "empty",
    stale: false,
  });
  const [status, setStatus] = useState<FlagContextValue["status"]>("loading");
  const [nonce, setNonce] = useState(0);
  // State rather than a ref, with a lazy initialiser rather than an assignment
  // in an effect, because bucketing a percentage rollout is part of *rendering*
  // the result. A ref read during render would bucket every visitor as the
  // "ssr" placeholder until something else happened to re-render, making a 10%
  // rollout all-or-nothing.
  //
  // On the server this yields "ephemeral"; on the client a real id. That is not
  // a hydration mismatch: the first client render has no overrides yet either,
  // so no percentage is in play until after hydration has finished.
  const [subjectId] = useState(getSubjectId);

  const endpoint = url ?? process.env.NEXT_PUBLIC_FEATURE_FLAGS_URL;

  useEffect(() => {
    let cancelled = false;
    loadFlags({
      url: endpoint,
      storage: typeof window === "undefined" ? null : window.localStorage,
      fetchImpl,
      timeoutMs,
      knownKeys: FLAG_KEYS,
    })
      .then((result) => {
        if (cancelled) return;
        setOverrides(result.overrides);
        setMeta({ source: result.source, stale: result.stale, error: result.error });
        setStatus("ready");
      })
      .catch((error: unknown) => {
        // loadFlags is documented not to reject. This is belt-and-braces: a
        // provider that threw here would take the whole shell down with it.
        if (cancelled) return;
        setOverrides({});
        setMeta({
          source: "empty",
          stale: false,
          error: error instanceof Error ? error.message : String(error),
        });
        setStatus("ready");
      });

    return () => {
      cancelled = true;
    };
  }, [endpoint, fetchImpl, timeoutMs, nonce]);

  // `loading` is set here rather than in the effect: this runs in an event
  // handler, so re-rendering is expected, whereas setting it in the effect body
  // would cause a cascading render on every mount for no benefit.
  const refresh = useCallback(() => {
    setStatus("loading");
    setNonce((n) => n + 1);
  }, []);

  const flags = useMemo(
    () => resolveAll(FLAGS, overrides, { subjectId, env: readEnv(), stale: meta.stale }),
    [overrides, meta.stale, subjectId]
  );

  const value = useMemo<FlagContextValue>(
    () => ({
      flags,
      isEnabled: (key) => flags[key]?.value ?? FLAGS[key]?.defaultValue ?? false,
      status,
      source: meta.source,
      stale: meta.stale,
      lastError: meta.error,
      refresh,
    }),
    [flags, status, meta.source, meta.stale, meta.error, refresh]
  );

  return <FlagContext.Provider value={value}>{children}</FlagContext.Provider>;
}

/**
 * Read a flag. Outside a provider it falls back to the registry default rather
 * than throwing, so a component can be unit-tested in isolation without
 * standing up the whole provider tree. A missing provider is a wiring bug, but
 * it should not take a page down.
 */
export function useFlag(key: FlagKey): boolean {
  const context = useContext(FlagContext);
  // The `?? false` is unreachable through the type system but cheap insurance:
  // a renamed or mistyped flag key should switch a feature off, not throw
  // during render and take the page down.
  if (!context) return FLAGS[key]?.defaultValue ?? false;
  return context.isEnabled(key);
}

/** Full flag context. Returns defaults-only values outside a provider. */
export function useFlags(): FlagContextValue {
  const context = useContext(FlagContext);
  const fallback = useMemo<FlagContextValue>(
    () => ({
      flags: resolveAll(FLAGS, {}, { subjectId: "ssr", env: readEnv() }),
      isEnabled: (key) => FLAGS[key]?.defaultValue ?? false,
      status: "ready",
      source: "empty",
      stale: false,
      refresh: () => {},
    }),
    []
  );
  return context ?? fallback;
}

export { envVarFor };
