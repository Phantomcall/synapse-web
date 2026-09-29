import type { Transaction } from "@/lib/types";

/**
 * Thin IndexedDB wrapper that persists observed transaction records keyed by
 * `tx_id`. This is the client-side "older than RPC retention" source: once an
 * event ages out of the RPC event window, the cached copy is what keeps the
 * Analytics tab and deep-history search useful across page reloads.
 *
 * When IndexedDB is unavailable (private browsing, disabled storage, SSR) the
 * cache degrades gracefully to an in-memory-only store so callers never need
 * to branch on availability.
 */

const DB_NAME = "handsoff-tx-cache";
const DB_VERSION = 1;
const STORE_NAME = "transactions";
const INDEX_TIMESTAMP = "by_timestamp";

/** Default retention cap; bounds storage growth. Configurable per instance. */
export const DEFAULT_RETENTION_CAP = 5000;

export interface TxCacheOptions {
  /** Maximum number of records retained; oldest are evicted first. */
  retentionCap?: number;
  /** Override the database name (useful for tests). */
  dbName?: string;
}

function isIndexedDBAvailable(): boolean {
  try {
    return typeof indexedDB !== "undefined" && indexedDB !== null;
  } catch {
    return false;
  }
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/**
 * Normalizes an arbitrary transaction-like record into the persisted shape.
 * Records are keyed by `tx_id` (the Transaction `id`).
 */
export function normalizeTx(tx: Transaction): Transaction {
  return {
    id: tx.id,
    asset: tx.asset,
    amount: tx.amount,
    status: tx.status,
    timestamp: tx.timestamp,
    from: tx.from,
    to: tx.to,
    memo: tx.memo,
    callback_url: tx.callback_url,
    retries: tx.retries,
    created_at: tx.created_at,
  };
}

export class TxCache {
  private readonly retentionCap: number;
  private readonly dbName: string;
  private dbPromise: Promise<IDBDatabase | null> | null = null;
  /** In-memory fallback used when IndexedDB is unavailable. */
  private memory = new Map<string, Transaction>();

  constructor(options: TxCacheOptions = {}) {
    this.retentionCap = options.retentionCap ?? DEFAULT_RETENTION_CAP;
    this.dbName = options.dbName ?? DB_NAME;
  }

  /** True when the persistent IndexedDB backend is usable. */
  get isPersistent(): boolean {
    return isIndexedDBAvailable();
  }

  private openDb(): Promise<IDBDatabase | null> {
    if (!isIndexedDBAvailable()) return Promise.resolve(null);
    if (this.dbPromise) return this.dbPromise;

    this.dbPromise = new Promise<IDBDatabase | null>((resolve) => {
      let request: IDBOpenDBRequest;
      try {
        request = indexedDB.open(this.dbName, DB_VERSION);
      } catch {
        resolve(null);
        return;
      }
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
          store.createIndex(INDEX_TIMESTAMP, "timestamp", { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    });

    return this.dbPromise;
  }

  /** Persists a batch of observed transactions, evicting oldest beyond the cap. */
  async putMany(txs: Transaction[]): Promise<void> {
    if (txs.length === 0) return;
    const normalized = txs.map(normalizeTx);

    const db = await this.openDb();
    if (!db) {
      for (const tx of normalized) this.memory.set(tx.id, tx);
      this.evictMemory();
      return;
    }

    try {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      for (const record of normalized) store.put(record);
      await transactionDone(tx);
      await this.evictDb(db);
    } catch {
      // Fall back to memory if the write fails for any reason.
      for (const record of normalized) this.memory.set(record.id, record);
      this.evictMemory();
    }
  }

  /** Returns all cached transactions, newest first. */
  async getAll(): Promise<Transaction[]> {
    const db = await this.openDb();
    if (!db) {
      return Array.from(this.memory.values()).sort((a, b) => b.timestamp - a.timestamp);
    }
    try {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const records = await requestToPromise<Transaction[]>(store.getAll());
      return records.sort((a, b) => b.timestamp - a.timestamp);
    } catch {
      return Array.from(this.memory.values()).sort((a, b) => b.timestamp - a.timestamp);
    }
  }

  /** Removes every cached record. */
  async clear(): Promise<void> {
    this.memory.clear();
    const db = await this.openDb();
    if (!db) return;
    try {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).clear();
      await transactionDone(tx);
    } catch {
      // Nothing else to do; memory is already cleared.
    }
  }

  private evictMemory(): void {
    if (this.memory.size <= this.retentionCap) return;
    const ordered = Array.from(this.memory.values()).sort((a, b) => a.timestamp - b.timestamp);
    const excess = this.memory.size - this.retentionCap;
    for (let i = 0; i < excess; i++) this.memory.delete(ordered[i].id);
  }

  private async evictDb(db: IDBDatabase): Promise<void> {
    const countTx = db.transaction(STORE_NAME, "readonly");
    const count = await requestToPromise<number>(countTx.objectStore(STORE_NAME).count());
    if (count <= this.retentionCap) return;

    const excess = count - this.retentionCap;
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const index = store.index(INDEX_TIMESTAMP);
    let removed = 0;
    await new Promise<void>((resolve, reject) => {
      const cursorReq = index.openCursor();
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor || removed >= excess) {
          resolve();
          return;
        }
        cursor.delete();
        removed++;
        cursor.continue();
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    });
    await transactionDone(tx);
  }
}

/** Shared default cache instance used by the live transaction pipeline. */
export const txCache = new TxCache();
