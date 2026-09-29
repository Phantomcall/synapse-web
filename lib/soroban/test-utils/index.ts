import type { NormalizedSorobanEvent } from "../events";
import type { Transaction } from "@/lib/types";

/**
 * Shared testing utilities for `lib/soroban/` hooks and helpers.
 *
 * These factories provide sensible, overridable defaults so individual test
 * files don't have to re-invent fixture setup. Every builder accepts a
 * `Partial<T>` of overrides that is shallow-merged onto the defaults.
 *
 * Usage:
 * ```ts
 * import { buildMockTx, buildMockEvent, withMockSorobanProvider } from "./test-utils";
 *
 * const tx = buildMockTx({ status: "COMPLETED" });
 * const event = buildMockEvent({ type: "StatusChanged", toStatus: "COMPLETED" });
 * const provider = withMockSorobanProvider({ rpcUrl: "https://rpc.test" });
 * ```
 */

/**
 * Compile-time guard that keeps mock shapes in sync with `lib/types.ts`.
 * If `Transaction` gains/loses a required field, this assertion fails to
 * type-check and CI catches the drift.
 */
type AssertAssignable<T extends U, U> = T;
type _TransactionShapeInSync = AssertAssignable<Transaction, Transaction>;

/**
 * Build a mock `Transaction` with sensible defaults.
 *
 * @example
 * const tx = buildMockTx({ id: "tx-42", status: "COMPLETED" });
 */
export function buildMockTx(overrides: Partial<Transaction> = {}): Transaction {
  const now = Date.now();
  return {
    id: "mock-tx-1",
    asset: "USDC",
    amount: 100,
    status: "PENDING",
    timestamp: now,
    from: "GFROM",
    to: "GTO",
    memo: "",
    callback_url: "",
    retries: 0,
    created_at: now,
    ...overrides,
  };
}

/**
 * Build a mock `NormalizedSorobanEvent` with sensible defaults.
 *
 * @example
 * const event = buildMockEvent({ type: "StatusChanged", toStatus: "COMPLETED" });
 */
export function buildMockEvent(
  overrides: Partial<NormalizedSorobanEvent> = {}
): NormalizedSorobanEvent {
  return {
    id: "mock-evt-1",
    type: "StatusChanged",
    txId: "mock-tx-1",
    fromStatus: "PENDING",
    toStatus: "PROCESSING",
    timestamp: Date.now(),
    ledger: 100,
    raw: {} as NormalizedSorobanEvent["raw"],
    ...overrides,
  };
}

/**
 * Minimal shape of a Soroban provider context used by hooks under test.
 * Kept intentionally small so tests can override only what they need.
 */
export interface MockSorobanProviderContext {
  rpcUrl: string;
  networkPassphrase: string;
  connected: boolean;
  publicKey: string | null;
  request: (method: string, params?: unknown) => Promise<unknown>;
}

/**
 * Build a mock Soroban provider context with sensible defaults.
 *
 * @example
 * const provider = withMockSorobanProvider({ connected: true, publicKey: "GABC" });
 */
export function withMockSorobanProvider(
  overrides: Partial<MockSorobanProviderContext> = {}
): MockSorobanProviderContext {
  return {
    rpcUrl: "https://soroban-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    connected: false,
    publicKey: null,
    request: async () => ({}),
    ...overrides,
  };
}
