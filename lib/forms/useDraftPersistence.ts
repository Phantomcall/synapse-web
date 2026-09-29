import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Draft persistence for in-progress admin forms.
 *
 * Auto-saves form input to storage as the user types (debounced), restores it
 * on return, exposes a "restored draft" indicator plus a discard option, and
 * clears the draft automatically on successful submission.
 *
 * Only public addresses/parameters are ever persisted here — no private key
 * material or other sensitive values are involved in these admin forms.
 */

export interface DraftPersistenceOptions<T> {
  /** Storage key, unique per form. */
  key: string;
  /** Current form values to persist. */
  values: T;
  /** Debounce window in ms before writing to storage. Defaults to 500. */
  debounceMs?: number;
  /** Stale drafts older than this are discarded. Defaults to 24h. */
  maxAgeMs?: number;
  /** Storage backend. Defaults to localStorage. */
  storage?: Storage;
  /** Set to false to disable persistence (e.g. while submitting). */
  enabled?: boolean;
}

export interface DraftPersistenceResult<T> {
  /** The restored draft, or null when none was found. */
  restoredDraft: T | null;
  /** True when a valid draft was restored and not yet discarded. */
  hasRestoredDraft: boolean;
  /** Discard the restored draft and remove it from storage. */
  discardDraft: () => void;
  /** Clear the persisted draft (call on successful submission). */
  clearDraft: () => void;
}

interface StoredDraft<T> {
  values: T;
  savedAt: number;
}

const DEFAULT_DEBOUNCE_MS = 500;
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function getStorage(storage?: Storage): Storage | null {
  if (storage) return storage;
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readDraft<T>(storage: Storage | null, key: string, maxAgeMs: number): T | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredDraft<T>;
    if (!parsed || typeof parsed.savedAt !== 'number') {
      storage.removeItem(key);
      return null;
    }
    if (Date.now() - parsed.savedAt > maxAgeMs) {
      storage.removeItem(key);
      return null;
    }
    return parsed.values;
  } catch {
    return null;
  }
}

export function useDraftPersistence<T>({
  key,
  values,
  debounceMs = DEFAULT_DEBOUNCE_MS,
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  storage,
  enabled = true,
}: DraftPersistenceOptions<T>): DraftPersistenceResult<T> {
  const resolvedStorage = getStorage(storage);

  const [restoredDraft, setRestoredDraft] = useState<T | null>(() =>
    readDraft<T>(resolvedStorage, key, maxAgeMs),
  );

  const hasRestoredDraft = restoredDraft !== null;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const valuesRef = useRef(values);
  valuesRef.current = values;

  // Debounced persistence as the user types.
  useEffect(() => {
    if (!enabled || !resolvedStorage) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      try {
        const payload: StoredDraft<T> = { values: valuesRef.current, savedAt: Date.now() };
        resolvedStorage.setItem(key, JSON.stringify(payload));
      } catch {
        // Storage may be unavailable or full; persistence is best-effort.
      }
    }, debounceMs);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [key, values, debounceMs, enabled, resolvedStorage]);

  const discardDraft = useCallback(() => {
    setRestoredDraft(null);
    if (resolvedStorage) {
      try {
        resolvedStorage.removeItem(key);
      } catch {
        // ignore
      }
    }
  }, [key, resolvedStorage]);

  const clearDraft = useCallback(() => {
    setRestoredDraft(null);
    if (timerRef.current) clearTimeout(timerRef.current);
    if (resolvedStorage) {
      try {
        resolvedStorage.removeItem(key);
      } catch {
        // ignore
      }
    }
  }, [key, resolvedStorage]);

  return { restoredDraft, hasRestoredDraft, discardDraft, clearDraft };
}

export default useDraftPersistence;
