import type { ContractCallResult } from "./soroban/contract";

export interface E2EMocks {
  wallet?: {
    authModal: () => Promise<void>;
    getAddress: () => Promise<{ address: string }>;
    disconnect: () => Promise<void>;
    selectedModule: { productId: string };
  };
  simulateContractCall?: (method: string) => Promise<string>;
  invokeContract?: (method: string) => Promise<ContractCallResult>;
}

declare global {
  interface Window {
    __SYNAPSE_E2E__?: E2EMocks;
  }
}

export function getE2EMocks(): E2EMocks | undefined {
  if (process.env.NEXT_PUBLIC_E2E_TEST_MODE !== "1" || typeof window === "undefined") {
    return undefined;
  }
  return window.__SYNAPSE_E2E__;
}
