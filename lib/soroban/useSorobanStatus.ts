"use client";
import { useState, useEffect } from "react";
import { useSorobanHealth } from "./SorobanProvider";

export type ConnectionStatus = "connected" | "disconnected" | "error";

function formatAge(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.floor(seconds / 60)}m ago`;
}

export function useSorobanStatus() {
  const health = useSorobanHealth();
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    if (!health.lastEventTimestamp) return;
    const tick = () => setNow(Date.now());
    tick();
    const timer = setInterval(tick, 5000);
    return () => clearInterval(timer);
  }, [health.lastEventTimestamp]);

  const lastEventAge =
    health.lastEventTimestamp && now ? formatAge(now - health.lastEventTimestamp) : null;

  const status: ConnectionStatus = health.error
    ? "error"
    : health.connected
      ? "connected"
      : "disconnected";

  return {
    status,
    lastEventAge,
    health,
    // Multi-RPC failover surface (issue #124): expose the active endpoint and
    // the priority-ordered endpoint health so consumers can render failover
    // state without reaching into the provider internals.
    activeEndpoint: health.activeEndpoint ?? null,
    endpoints: health.endpoints ?? [],
    isFailingOver: Boolean(health.isFailingOver),
  };
}
