import { describe, it, expect } from "vitest";
import {
  mergeTransactionEvents,
  nativeToTransaction,
  applyOptimisticOverlay,
  pruneOptimisticTransitions,
  OPTIMISTIC_TIMEOUT_MS,
  PLACEHOLDER_MARKER,
  type OptimisticTransition,
} from "./transactionMerge";
import { MOCK_TXS } from "@/lib/mock-data";
import type { NormalizedSorobanEvent } from "./events";
import type { Transaction } from "@/lib/types";

const KNOWN_TX_ID = MOCK_TXS[0]!.id;

function statusChangedEvent(
  overrides: Partial<NormalizedSorobanEvent> = {}
): NormalizedSorobanEvent {
  return {
    id: "evt-1",
    type: "StatusChanged",
    txId: KNOWN_TX_ID,
    fromStatus: "PENDING",
    toStatus: "PROCESSING",
    timestamp: Date.now(),
    ledger: 100,
    raw: {} as NormalizedSorobanEvent["raw"],
    ...overrides,
  };
}

function registeredEvent(overrides: Partial<NormalizedSorobanEvent> = {}): NormalizedSorobanEvent {
  return {
    id: "evt-2",
    type: "TransactionRegistered",
    txId: "brand-new-tx-id",
    timestamp: Date.now(),
    ledger: 101,
    raw: {} as NormalizedSorobanEvent["raw"],
    ...overrides,
  };
}

describe("mergeTransactionEvents", () => {
  it("returns the mock baseline unchanged when there are no events", () => {
    expect(mergeTransactionEvents([])).toEqual(MOCK_TXS);
  });

  it("updates the status of a known transaction on StatusChanged", () => {
    const result = mergeTransactionEvents([statusChangedEvent()]);
    const updated = result.find((tx) => tx.id === KNOWN_TX_ID);
    expect(updated?.status).toBe("PROCESSING");
  });

  it("ignores StatusChanged events for unknown tx ids", () => {
    const event = statusChangedEvent({ txId: "does-not-exist" });
    expect(mergeTransactionEvents([event])).toEqual(MOCK_TXS);
  });

  it("inserts a placeholder row for a new TransactionRegistered id", () => {
    const result = mergeTransactionEvents([registeredEvent()]);
    expect(result).toHaveLength(MOCK_TXS.length + 1);
    const placeholder = result.find((tx) => tx.id === "brand-new-tx-id");
    expect(placeholder).toMatchObject({
      asset: PLACEHOLDER_MARKER,
      status: "PENDING",
      from: PLACEHOLDER_MARKER,
      to: PLACEHOLDER_MARKER,
    });
  });

  it("does not duplicate a placeholder for an id that already exists", () => {
    const event = registeredEvent({ txId: KNOWN_TX_ID });
    const result = mergeTransactionEvents([event]);
    expect(result).toHaveLength(MOCK_TXS.length);
  });

  it("applies multiple events in order", () => {
    const result = mergeTransactionEvents([
      registeredEvent(),
      statusChangedEvent({ txId: "brand-new-tx-id", toStatus: "COMPLETED" }),
    ]);
    const tx = result.find((t) => t.id === "brand-new-tx-id");
    expect(tx?.status).toBe("COMPLETED");
  });
});

describe("nativeToTransaction", () => {
  const fallback: Transaction = {
    id: "tx-1",
    asset: PLACEHOLDER_MARKER,
    amount: 0,
    status: "PENDING",
    timestamp: 1000,
    from: PLACEHOLDER_MARKER,
    to: PLACEHOLDER_MARKER,
    memo: "",
    callback_url: "",
    retries: 0,
    created_at: 1000,
  };

  it("maps matching fields from the decoded struct", () => {
    const native = {
      asset: "USDC",
      amount: 42,
      status: "completed",
      from: "GFROM",
      to: "GTO",
      memo: "hello",
      callback_url: "https://cb",
      retries: 2,
      created_at: 500,
    };
    expect(nativeToTransaction("tx-1", native, fallback)).toEqual({
      id: "tx-1",
      asset: "USDC",
      amount: 42,
      status: "COMPLETED",
      timestamp: fallback.timestamp,
      from: "GFROM",
      to: "GTO",
      memo: "hello",
      callback_url: "https://cb",
      retries: 2,
      created_at: 500,
    });
  });

  it("falls back to placeholder fields when the decoded value isn't an object", () => {
    expect(nativeToTransaction("tx-1", "not-an-object", fallback)).toEqual(fallback);
    expect(nativeToTransaction("tx-1", null, fallback)).toEqual(fallback);
  });

  it("falls back field-by-field when types don't match", () => {
    const native = { asset: 123, amount: "not-a-number" };
    const result = nativeToTransaction("tx-1", native, fallback);
    expect(result.asset).toBe(fallback.asset);
    expect(result.amount).toBe(fallback.amount);
  });
});

describe("applyOptimisticOverlay", () => {
  const base: Transaction = {
    id: "tx-opt",
    asset: "USDC",
    amount: 10,
    status: "PENDING",
    timestamp: 1000,
    from: "GFROM",
    to: "GTO",
    memo: "",
    callback_url: "",
    retries: 0,
    created_at: 1000,
  };

  function transition(overrides: Partial<OptimisticTransition> = {}): OptimisticTransition {
    return {
      txId: "tx-opt",
      expectedStatus: "PROCESSING",
      previousStatus: "PENDING",
      submittedAt: 1000,
      ...overrides,
    };
  }

  it("returns the input unchanged when there are no transitions", () => {
    expect(applyOptimisticOverlay([base], [])).toEqual([base]);
  });

  it("applies the expected status immediately on submission", () => {
    const result = applyOptimisticOverlay([base], [transition()], 1000);
    expect(result[0]!.status).toBe("PROCESSING");
  });

  it("reconciles with the poller-confirmed status once it matches", () => {
    const confirmed: Transaction = { ...base, status: "PROCESSING" };
    const result = applyOptimisticOverlay([confirmed], [transition()], 1000);
    expect(result[0]!.status).toBe("PROCESSING");
  });

  it("rolls back to the previous status when the submission fails", () => {
    const result = applyOptimisticOverlay(
      [base],
      [transition({ failed: true, error: "reverted" })],
      1000
    );
    expect(result[0]!.status).toBe("PENDING");
  });

  it("rolls back after the timeout when the poller never confirms", () => {
    const result = applyOptimisticOverlay(
      [base],
      [transition()],
      1000 + OPTIMISTIC_TIMEOUT_MS + 1
    );
    expect(result[0]!.status).toBe("PENDING");
  });

  it("leaves unrelated transactions untouched", () => {
    const other: Transaction = { ...base, id: "tx-other" };
    const result = applyOptimisticOverlay([base, other], [transition()], 1000);
    expect(result[1]).toEqual(other);
  });
});

describe("pruneOptimisticTransitions", () => {
  const base: Transaction = {
    id: "tx-opt",
    asset: "USDC",
    amount: 10,
    status: "PENDING",
    timestamp: 1000,
    from: "GFROM",
    to: "GTO",
    memo: "",
    callback_url: "",
    retries: 0,
    created_at: 1000,
  };

  function transition(overrides: Partial<OptimisticTransition> = {}): OptimisticTransition {
    return {
      txId: "tx-opt",
      expectedStatus: "PROCESSING",
      previousStatus: "PENDING",
      submittedAt: 1000,
      ...overrides,
    };
  }

  it("keeps a transition that is still pending confirmation", () => {
    expect(pruneOptimisticTransitions([base], [transition()], 1000)).toHaveLength(1);
  });

  it("drops a transition once the poller confirms the expected status", () => {
    const confirmed: Transaction = { ...base, status: "PROCESSING" };
    expect(pruneOptimisticTransitions([confirmed], [transition()], 1000)).toHaveLength(0);
  });

  it("drops a failed transition", () => {
    expect(
      pruneOptimisticTransitions([base], [transition({ failed: true })], 1000)
    ).toHaveLength(0);
  });

  it("drops a transition that has timed out", () => {
    expect(
      pruneOptimisticTransitions([base], [transition()], 1000 + OPTIMISTIC_TIMEOUT_MS + 1)
    ).toHaveLength(0);
  });
});
