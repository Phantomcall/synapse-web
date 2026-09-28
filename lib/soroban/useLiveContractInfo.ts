"use client";
import { useEffect, useState } from "react";
import { scValToNative } from "@stellar/stellar-sdk";
import { simulateContractCall } from "./contract";
import { useWallet } from "@/lib/wallet/WalletProvider";
import { MOCK_CONTRACT_INFO } from "@/lib/mock-data";
import type { ContractInfo } from "@/lib/types";
import { appConfig } from "@/lib/config";

// Resolved once, through the validated config module, so the network/RPC
// pairing has already been checked and the testnet endpoint is not hardcoded
// in five places.
const RPC_URL = appConfig.rpcUrl;
const CONTRACT_ID = appConfig.contractId;

/**
 * Reads health() and version() from a real contract via read-only
 * simulation once a wallet is connected. Falls back to the mock baseline
 * (and stays there) when no contract is configured or no wallet is
 * connected — there's no getter for admin/relay_signer in the current
 * ABI, so those fields always come from the mock/env baseline.
 */
export function useLiveContractInfo(): ContractInfo {
  const { address } = useWallet();
  const [live, setLive] = useState<Partial<ContractInfo>>({});

  useEffect(() => {
    if (!address || !CONTRACT_ID) return;
    let cancelled = false;

    async function readField(method: "health" | "version") {
      try {
        const simulated = await simulateContractCall(RPC_URL, CONTRACT_ID!, address!, method);
        if (cancelled || !simulated.result) return;
        const value = scValToNative(simulated.result.retval);
        if (typeof value === "string") {
          setLive((prev) => ({ ...prev, [method]: value }));
        }
      } catch {
        // Leave the mock value in place; this is best-effort.
      }
    }

    readField("health");
    readField("version");

    return () => {
      cancelled = true;
    };
  }, [address]);

  return {
    ...MOCK_CONTRACT_INFO,
    address: CONTRACT_ID ?? MOCK_CONTRACT_INFO.address,
    ...live,
  };
}
