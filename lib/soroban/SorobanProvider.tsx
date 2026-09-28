"use client";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import {
  createSorobanEventPoller,
  type NormalizedSorobanEvent,
  type RpcHealth,
  type SorobanEventPoller,
} from "./events";

interface SorobanContextValue {
  events: NormalizedSorobanEvent[];
  health: RpcHealth;
  poller: SorobanEventPoller | null;
}

const SorobanContext = createContext<SorobanContextValue>({
  events: [],
  health: { connected: false, lastCheck: 0, lastEventTimestamp: null, error: null },
  poller: null,
});

export function useSoroban() {
  return useContext(SorobanContext);
}

interface SorobanProviderProps {
  children: ReactNode;
  /**
   * Required, and expected to come from `appConfig.rpcUrl` in
   * `app/layout.tsx`. It is deliberately not optional: an omitted URL used to
   * fall back to a hardcoded testnet endpoint, which silently pointed a
   * futurenet build at the wrong chain.
   */
  rpcUrl: string;
  /** Undefined for a mock-data build, in which case the poller stays idle. */
  contractId?: string;
}

export function SorobanProvider({ children, rpcUrl, contractId }: SorobanProviderProps) {
  const [events, setEvents] = useState<NormalizedSorobanEvent[]>([]);
  const [health, setHealth] = useState<RpcHealth>({
    connected: false,
    lastCheck: 0,
    lastEventTimestamp: null,
    error: null,
  });
  const [poller] = useState<SorobanEventPoller>(() => createSorobanEventPoller(rpcUrl, contractId));

  useEffect(() => {
    const unsubHealth = poller.onHealth(setHealth);
    const unsubEvents = poller.onEvents((newEvents) => {
      setEvents((prev) => {
        const combined = [...newEvents, ...prev];
        return combined.slice(0, 200);
      });
    });

    poller.start();

    return () => {
      poller.stop();
      unsubHealth();
      unsubEvents();
    };
  }, [poller]);

  return (
    <SorobanContext.Provider value={{ events, health, poller }}>{children}</SorobanContext.Provider>
  );
}

export function useSorobanEvents() {
  return useSoroban().events;
}

export function useSorobanHealth() {
  return useSoroban().health;
}
