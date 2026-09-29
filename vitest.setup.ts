import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

vi.mock("@stellar/freighter-api", () => ({
  getAddress: vi
    .fn()
    .mockResolvedValue({ address: "GBZXN7PIRZGNMHGA728RGRYA72R6UGRM6X8J73V2S8L7D2Z5V5P8K3M4" }),
  getNetwork: vi.fn().mockResolvedValue("TESTNET"),
  isConnected: vi.fn().mockResolvedValue(true),
  isAllowed: vi.fn().mockResolvedValue(true),
  requestAccess: vi
    .fn()
    .mockResolvedValue({ address: "GBZXN7PIRZGNMHGA728RGRYA72R6UGRM6X8J73V2S8L7D2Z5V5P8K3M4" }),
  signAuthEntry: vi.fn().mockResolvedValue({ signedAuthEntry: "AAAA..." }),
  signMessage: vi.fn().mockResolvedValue({ signedMessage: "AAAA..." }),
  signTransaction: vi.fn().mockResolvedValue({ signedTxXdr: "AAAA..." }),
  default: {
    getAddress: vi
      .fn()
      .mockResolvedValue({ address: "GBZXN7PIRZGNMHGA728RGRYA72R6UGRM6X8J73V2S8L7D2Z5V5P8K3M4" }),
    getNetwork: vi.fn().mockResolvedValue("TESTNET"),
    isConnected: vi.fn().mockResolvedValue(true),
    isAllowed: vi.fn().mockResolvedValue(true),
    requestAccess: vi
      .fn()
      .mockResolvedValue({ address: "GBZXN7PIRZGNMHGA728RGRYA72R6UGRM6X8J73V2S8L7D2Z5V5P8K3M4" }),
    signAuthEntry: vi.fn().mockResolvedValue({ signedAuthEntry: "AAAA..." }),
    signMessage: vi.fn().mockResolvedValue({ signedMessage: "AAAA..." }),
    signTransaction: vi.fn().mockResolvedValue({ signedTxXdr: "AAAA..." }),
  },
}));
