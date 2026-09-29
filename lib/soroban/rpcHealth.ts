import { rpc } from "@stellar/stellar-sdk";

/**
 * Server-side Soroban RPC connectivity check.
 *
 * Kept out of the route file so it can be unit tested against an injected
 * fetcher, and so the client bundle never imports the RPC SDK for a check that
 * only ever runs on the server.
 */

export interface RpcHealth {
  /** Whether the endpoint answered within the timeout. */
  reachable: boolean;
  /** The endpoint that was probed, so a misconfiguration is obvious in logs. */
  endpoint: string;
  /** Round-trip time in ms; absent when the call failed or timed out. */
  latencyMs?: number;
  /** Latest ledger reported, when the call succeeded. */
  latestLedger?: number;
  /** Why the check failed, for the alert body. */
  error?: string;
}

export const DEFAULT_RPC_URL = "https://soroban-testnet.stellar.org";

/** Long enough for a slow public endpoint, short enough to fail the monitor fast. */
export const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Probes the RPC endpoint with a real `getHealth` call.
 *
 * `getHealth` is used rather than a synthetic transaction simulation because it
 * needs no contract and no signature, so the check keeps working for a
 * mock-data build that has no contract deployed.
 */
export async function getHealth(
  options: {
    rpcUrl?: string;
    timeoutMs?: number;
    now?: () => number;
    fetchStatus?: typeof rpc.Server.prototype.getHealth;
  } = {}
): Promise<RpcHealth> {
  const endpoint = options.rpcUrl ?? process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ?? DEFAULT_RPC_URL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? (() => Date.now());

  const server = new rpc.Server(endpoint);
  const call = options.fetchStatus
    ? options.fetchStatus.bind(server)
    : server.getHealth.bind(server);

  const startedAt = now();
  try {
    // A hung endpoint has to fail the check, so the wait is bounded rather than
    // left to the fetch default.
    const health = await withTimeout(call(), timeoutMs);
    const latencyMs = now() - startedAt;

    // `latestLedger` is absent on some providers even on success; only treat a
    // missing value as informational, not as a failure.
    return {
      reachable: true,
      endpoint,
      latencyMs,
      ...(typeof health.latestLedger === "number" ? { latestLedger: health.latestLedger } : {}),
    };
  } catch (error) {
    return {
      reachable: false,
      endpoint,
      error: describeError(error),
    };
  }
}

/** Rejects with a recognisable message if `promise` outlives `timeoutMs`. */
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new TimeoutError(timeoutMs));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export class TimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`RPC did not respond within ${timeoutMs}ms`);
    this.name = "TimeoutError";
  }
}

/**
 * Turns an unknown throw into a short, alert-friendly string.
 *
 * The endpoint's own error text goes into a monitoring payload, so it is
 * truncated rather than passed through unbounded.
 */
function describeError(error: unknown): string {
  if (error instanceof TimeoutError) return error.message;
  if (error instanceof Error) return truncate(error.message);
  return truncate(String(error));
}

function truncate(value: string, max = 200): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
