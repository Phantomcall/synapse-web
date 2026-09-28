"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { scValToNative } from "@stellar/stellar-sdk";
import { useSorobanEvents } from "./SorobanProvider";
import { simulateContractCall, stringArg } from "./contract";
import {
  mergeTransactionEvents,
  nativeToTransaction,
  PLACEHOLDER_MARKER,
} from "./transactionMerge";
import { useWallet } from "@/lib/wallet/WalletProvider";
import type { Transaction } from "@/lib/types";
import { appConfig } from "@/lib/config";

// Resolved once, through the validated config module, so the network/RPC
// pairing has already been checked and the testnet endpoint is not hardcoded
// in five places.
const RPC_URL = appConfig.rpcUrl;
const CONTRACT_ID = appConfig.contractId;

/**
 * Merges the mock baseline with live events from the RPC event poller (see
 * mergeTransactionEvents). When a wallet is connected and a real contract is
 * configured, placeholder rows are enriched with full details via a
 * get_transaction() read-only call.
 */
export function useLiveTransactions(): Transaction[] {
  const events = useSorobanEvents();
  const { address } = useWallet();
  const [enriched, setEnriched] = useState<Record<string, Transaction>>({});
  const fetchedIds = useRef<Set<string>>(new Set());

  const baseline = useMemo(() => mergeTransactionEvents(events), [events]);

  useEffect(() => {
    if (!address || !CONTRACT_ID) return;

    const toFetch = baseline.filter(
      (tx) => tx.asset === PLACEHOLDER_MARKER && !fetchedIds.current.has(tx.id)
    );
    if (toFetch.length === 0) return;

    for (const tx of toFetch) {
      fetchedIds.current.add(tx.id);
      simulateContractCall(RPC_URL, CONTRACT_ID, address, "get_transaction", [stringArg(tx.id)])
        .then((simulated) => {
          if (!simulated.result) return;
          const native = scValToNative(simulated.result.retval);
          setEnriched((prev) => ({ ...prev, [tx.id]: nativeToTransaction(tx.id, native, tx) }));
        })
        .catch(() => {
          // Leave the placeholder row in place; enrichment is best-effort.
        });
    }
  }, [baseline, address]);

  return useMemo(() => baseline.map((tx) => enriched[tx.id] ?? tx), [baseline, enriched]);
}
