import { rpc } from "@stellar/stellar-sdk";

// The endpoint is supplied by the validated config layer rather than defaulted
// here. A hardcoded fallback in this file would silently override
// NEXT_PUBLIC_NETWORK: a futurenet build with no explicit RPC URL would poll
// testnet and render the wrong chain's data without any visible error.
const POLL_INTERVAL_MS = 5000;
const CURSOR_STORAGE_KEY = "soroban-event-cursor";

export type SorobanEventType = "TransactionRegistered" | "StatusChanged";

export interface NormalizedSorobanEvent {
  id: string;
  type: SorobanEventType;
  promptId?: string;
  txId?: string;
  fromStatus?: string;
  toStatus?: string;
  timestamp: number;
  ledger: number;
  raw: rpc.Api.EventResponse;
}

export interface RpcHealth {
  connected: boolean;
  lastCheck: number;
  lastEventTimestamp: number | null;
  error: string | null;
}

function getStoredCursor(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(CURSOR_STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeCursor(cursor: string): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(CURSOR_STORAGE_KEY, cursor);
  } catch {}
}

export function createSorobanEventPoller(rpcUrl: string, contractId?: string) {
  if (!rpcUrl) {
    throw new Error(
      "createSorobanEventPoller requires an RPC url. Use appConfig.rpcUrl from " +
        "@/lib/config, which resolves the correct endpoint for the configured network."
    );
  }

  const server = new rpc.Server(rpcUrl);
  let cursor: string | null = getStoredCursor();
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  const health: RpcHealth = {
    connected: false,
    lastCheck: 0,
    lastEventTimestamp: null,
    error: null,
  };
  let healthListeners: Array<(h: RpcHealth) => void> = [];
  let eventListeners: Array<(events: NormalizedSorobanEvent[]) => void> = [];

  function notifyHealth() {
    healthListeners.forEach((fn) => fn({ ...health }));
  }

  function notifyEvents(events: NormalizedSorobanEvent[]) {
    if (events.length > 0) {
      health.lastEventTimestamp = Date.now();
    }
    eventListeners.forEach((fn) => fn(events));
  }

  function normalizeEvent(raw: rpc.Api.EventResponse): NormalizedSorobanEvent | null {
    try {
      const topics = raw.topic ?? [];
      const typeStr = topics[0]?.toString() ?? "";
      const timestamp = raw.ledgerClosedAt ? new Date(raw.ledgerClosedAt).getTime() : Date.now();

      if (typeStr.includes("TransactionRegistered")) {
        return {
          id: raw.id,
          type: "TransactionRegistered",
          txId: topics[1]?.toString(),
          timestamp,
          ledger: raw.ledger,
          raw,
        };
      }

      if (typeStr.includes("StatusChanged")) {
        return {
          id: raw.id,
          type: "StatusChanged",
          txId: topics[1]?.toString(),
          fromStatus: topics[2]?.toString(),
          toStatus: topics[3]?.toString(),
          timestamp,
          ledger: raw.ledger,
          raw,
        };
      }

      return null;
    } catch {
      return null;
    }
  }

  async function poll(): Promise<void> {
    try {
      health.lastCheck = Date.now();
      health.connected = true;
      health.error = null;

      const filters: rpc.Api.EventFilter[] = contractId
        ? [{ contractIds: [contractId], type: "contract" }]
        : [];

      const request: rpc.Api.GetEventsRequest = cursor
        ? { filters, cursor, limit: 100 }
        : { filters, startLedger: (await server.getLatestLedger()).sequence, limit: 100 };

      const response = await server.getEvents(request);

      if (response && response.events) {
        const normalized: NormalizedSorobanEvent[] = [];
        for (const event of response.events) {
          const n = normalizeEvent(event);
          if (n) normalized.push(n);
        }

        const lastEvent = response.events[response.events.length - 1];
        if (lastEvent) {
          cursor = lastEvent.id;
          storeCursor(cursor);
        }

        notifyEvents(normalized);
      }

      notifyHealth();
    } catch (err) {
      health.connected = false;
      health.error = err instanceof Error ? err.message : "Unknown RPC error";
      notifyHealth();
    }
  }

  function start(): void {
    if (pollTimer) return;
    poll();
    pollTimer = setInterval(poll, POLL_INTERVAL_MS);
  }

  function stop(): void {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function onHealth(fn: (h: RpcHealth) => void): () => void {
    healthListeners.push(fn);
    return () => {
      healthListeners = healthListeners.filter((l) => l !== fn);
    };
  }

  function onEvents(fn: (events: NormalizedSorobanEvent[]) => void): () => void {
    eventListeners.push(fn);
    return () => {
      eventListeners = eventListeners.filter((l) => l !== fn);
    };
  }

  function getHealth(): RpcHealth {
    return { ...health };
  }

  function getCursor(): string | null {
    return cursor;
  }

  function resetCursor(): void {
    cursor = null;
    storeCursor("");
  }

  return {
    start,
    stop,
    poll,
    onHealth,
    onEvents,
    getHealth,
    getCursor,
    resetCursor,
  };
}

export type SorobanEventPoller = ReturnType<typeof createSorobanEventPoller>;
