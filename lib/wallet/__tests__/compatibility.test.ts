import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ensureWalletKitInitialized,
  StellarWalletsKit,
  SUPPORTED_WALLETS,
  type SupportedWalletId,
} from "../kit";
import { getStoredWalletId, storeSelectedWalletId, clearSelectedWalletId } from "../storage";

describe("Wallet-Kit Compatibility Suite Across Supported Wallets", () => {
  const mockAddress = "GBZXN7PIRZGNMHGA728RGRYA72R6UGRM6X8J73V2S8L7D2Z5V5P8K3M4";
  const mockSecondaryAddress = "GA2C5RFPE6GCKMY3US5PAB6UZLKIGAHWKXX2G6EXO2Z6K3M4GBZXN7P";

  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  describe("Supported Wallets Registry", () => {
    it("includes Freighter, xBull, Ledger, and WalletConnect", () => {
      const walletIds = SUPPORTED_WALLETS.map((w) => w.id);
      expect(walletIds).toContain("freighter");
      expect(walletIds).toContain("xbull");
      expect(walletIds).toContain("ledger");
      expect(walletIds).toContain("walletconnect");
    });
  });

  const wallets: { id: SupportedWalletId; name: string }[] = [
    { id: "freighter", name: "Freighter" },
    { id: "xbull", name: "xBull" },
    { id: "ledger", name: "Ledger" },
    { id: "walletconnect", name: "WalletConnect" },
  ];

  wallets.forEach(({ id, name }) => {
    describe(`Wallet Flow: ${name} (${id})`, () => {
      it(`initializes and connects successfully via ${name}`, async () => {
        vi.spyOn(StellarWalletsKit, "init").mockImplementation(() => {});
        vi.spyOn(StellarWalletsKit, "authModal").mockResolvedValue(undefined as any);
        vi.spyOn(StellarWalletsKit, "getAddress").mockResolvedValue({ address: mockAddress });

        ensureWalletKitInitialized();
        await StellarWalletsKit.authModal({});
        const res = await StellarWalletsKit.getAddress();

        expect(res.address).toBe(mockAddress);
        storeSelectedWalletId(id);
        expect(getStoredWalletId()).toBe(id);
      });

      it(`signs transaction XDR payload for ${name}`, async () => {
        const mockXdr = "AAAAAGX8...testxdr...";
        const mockSignedXdr = "AAAAAGX8...signedxdr...";

        const signSpy = vi
          .spyOn(StellarWalletsKit as any, "signTransaction")
          .mockResolvedValue({ signedXDR: mockSignedXdr });

        const result = await (StellarWalletsKit as any).signTransaction(mockXdr);
        expect(result.signedXDR).toBe(mockSignedXdr);
        expect(signSpy).toHaveBeenCalledWith(mockXdr);
      });

      it(`handles user rejection during sign transaction for ${name}`, async () => {
        vi.spyOn(StellarWalletsKit as any, "signTransaction").mockRejectedValue(
          new Error("User rejected transaction signing")
        );

        await expect((StellarWalletsKit as any).signTransaction("AAAAA...")).rejects.toThrow(
          "User rejected transaction signing"
        );
      });

      it(`handles account switch for ${name}`, async () => {
        storeSelectedWalletId(id);
        vi.spyOn(StellarWalletsKit, "getAddress").mockResolvedValue({
          address: mockSecondaryAddress,
        });

        const updated = await StellarWalletsKit.getAddress();
        expect(updated.address).toBe(mockSecondaryAddress);
        expect(getStoredWalletId()).toBe(id);
      });

      it(`handles disconnect cleanly for ${name}`, async () => {
        storeSelectedWalletId(id);
        const disconnectSpy = vi
          .spyOn(StellarWalletsKit, "disconnect")
          .mockResolvedValue(undefined as any);

        await StellarWalletsKit.disconnect();
        clearSelectedWalletId();

        expect(getStoredWalletId()).toBeUndefined();
        expect(disconnectSpy).toHaveBeenCalled();
      });

      it(`handles network switch configuration for ${name}`, () => {
        const setNetworkSpy = vi
          .spyOn(StellarWalletsKit as any, "setNetwork")
          .mockImplementation(() => {});

        (StellarWalletsKit as any).setNetwork("TESTNET");
        expect(setNetworkSpy).toHaveBeenCalledWith("TESTNET");

        (StellarWalletsKit as any).setNetwork("PUBLIC");
        expect(setNetworkSpy).toHaveBeenCalledWith("PUBLIC");
      });
    });
  });
});
