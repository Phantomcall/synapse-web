'use client';

import { useMemo } from 'react';
import { useSorobanStatus } from '@/lib/soroban/useSorobanStatus';

type HealthState = 'healthy' | 'degraded' | 'down';

interface HealthWidgetProps {
  /** Optional override for the freshness threshold (ms) before the poller is considered stale. */
  staleAfterMs?: number;
  /** Optional override for the latency threshold (ms) before RPC is considered degraded. */
  slowLatencyMs?: number;
}

const DEFAULT_STALE_AFTER_MS = 30_000;
const DEFAULT_SLOW_LATENCY_MS = 1_500;

const STATE_STYLES: Record<HealthState, { label: string; dot: string; badge: string; text: string }> = {
  healthy: {
    label: 'Healthy',
    dot: 'bg-emerald-500',
    badge: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30',
    text: 'text-emerald-600 dark:text-emerald-400',
  },
  degraded: {
    label: 'Degraded',
    dot: 'bg-amber-500',
    badge: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30',
    text: 'text-amber-600 dark:text-amber-400',
  },
  down: {
    label: 'Down',
    dot: 'bg-red-500',
    badge: 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/30',
    text: 'text-red-600 dark:text-red-400',
  },
};

function formatLatency(latencyMs: number | null | undefined): string {
  if (latencyMs === null || latencyMs === undefined || Number.isNaN(latencyMs)) {
    return '—';
  }
  if (latencyMs < 1000) {
    return `${Math.round(latencyMs)} ms`;
  }
  return `${(latencyMs / 1000).toFixed(2)} s`;
}

function formatSince(timestamp: number | null | undefined): string {
  if (!timestamp) {
    return 'never';
  }
  const deltaMs = Date.now() - timestamp;
  if (deltaMs < 0) {
    return 'just now';
  }
  const seconds = Math.floor(deltaMs / 1000);
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

/**
 * At-a-glance platform/RPC health widget.
 *
 * Combines RPC reachability/latency with event-poller freshness into a single
 * unified status enum so users can tell whether their connection to the chain
 * is healthy right now. Point-in-time only — no historical charting.
 */
export default function HealthWidget({
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
  slowLatencyMs = DEFAULT_SLOW_LATENCY_MS,
}: HealthWidgetProps) {
  const status = useSorobanStatus();

  const { state, rpcReachable, latencyMs, lastEventAt } = useMemo(() => {
    const reachable = status?.rpcReachable ?? status?.isConnected ?? false;
    const latency = status?.latencyMs ?? null;
    const lastEvent = status?.lastEventAt ?? status?.lastProcessedEventAt ?? null;

    let next: HealthState;
    if (!reachable) {
      next = 'down';
    } else if (
      (latency !== null && latency > slowLatencyMs) ||
      !lastEvent ||
      Date.now() - lastEvent > staleAfterMs
    ) {
      next = 'degraded';
    } else {
      next = 'healthy';
    }

    return { state: next, rpcReachable: reachable, latencyMs: latency, lastEventAt: lastEvent };
  }, [status, staleAfterMs, slowLatencyMs]);

  const styles = STATE_STYLES[state];

  return (
    <section
      aria-label="Platform health"
      className="rounded-lg border border-border bg-card p-4 shadow-sm"
    >
      <header className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">Platform Health</h3>
        <span
          className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${styles.badge}`}
          role="status"
          aria-live="polite"
        >
          <span className={`h-2 w-2 rounded-full ${styles.dot}`} aria-hidden="true" />
          {styles.label}
        </span>
      </header>

      <dl className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt className="text-xs text-muted-foreground">RPC</dt>
          <dd className={`font-medium ${rpcReachable ? 'text-foreground' : styles.text}`}>
            {rpcReachable ? 'Reachable' : 'Unreachable'}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Latency</dt>
          <dd className="font-medium text-foreground">{formatLatency(latencyMs)}</dd>
        </div>
        <div className="col-span-2">
          <dt className="text-xs text-muted-foreground">Last processed event</dt>
          <dd className="font-medium text-foreground">{formatSince(lastEventAt)}</dd>
        </div>
      </dl>
    </section>
  );
}
