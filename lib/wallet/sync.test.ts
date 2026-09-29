import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { broadcastWalletEvent, subscribeWalletSync, type WalletSyncMessage } from "./sync";

describe("Cross-Tab Wallet Synchronization", () => {
  let messageListeners: Array<(event: MessageEvent) => void> = [];
  let storageListeners: Array<(event: StorageEvent) => void> = [];
  let mockPostMessage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    messageListeners = [];
    storageListeners = [];
    mockPostMessage = vi.fn();

    // Mock BroadcastChannel
    globalThis.BroadcastChannel = vi.fn().mockImplementation(() => ({
      postMessage: mockPostMessage,
      addEventListener: (type: string, listener: any) => {
        if (type === "message") messageListeners.push(listener);
      },
      removeEventListener: (type: string, listener: any) => {
        messageListeners = messageListeners.filter((l) => l !== listener);
      },
      close: vi.fn(),
    })) as any;

    // Spy on window storage event listeners
    vi.spyOn(window, "addEventListener").mockImplementation((type, listener) => {
      if (type === "storage") storageListeners.push(listener as any);
    });

    vi.spyOn(window, "removeEventListener").mockImplementation((type, listener) => {
      if (type === "storage") {
        storageListeners = storageListeners.filter((l) => l !== listener);
      }
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("broadcasts CONNECTED event via BroadcastChannel and localStorage", () => {
    const message: WalletSyncMessage = {
      type: "CONNECTED",
      address: "GBZXN7PIRZGNMHGA728RGRYA72R6UGRM6X8J73V2S8L7D2Z5V5P8K3M4",
      walletId: "freighter",
    };

    broadcastWalletEvent(message);

    expect(mockPostMessage).toHaveBeenCalledWith(message);
    const stored = localStorage.getItem("synapse_wallet_sync_event");
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored!)).toMatchObject(message);
  });

  it("broadcasts DISCONNECTED event", () => {
    const message: WalletSyncMessage = { type: "DISCONNECTED" };
    broadcastWalletEvent(message);

    expect(mockPostMessage).toHaveBeenCalledWith(message);
    const stored = localStorage.getItem("synapse_wallet_sync_event");
    expect(JSON.parse(stored!)).toMatchObject({ type: "DISCONNECTED" });
  });

  it("receives broadcast messages via subscription", () => {
    const callback = vi.fn();
    const unsubscribe = subscribeWalletSync(callback);

    const message: WalletSyncMessage = {
      type: "CONNECTED",
      address: "GA2C5RFPE6GCKMY3US5PAB6UZLKIGAHWKXX2G6EXO2Z6K3M4GBZXN7P",
    };

    messageListeners.forEach((listener) => {
      listener({ data: message } as MessageEvent);
    });

    expect(callback).toHaveBeenCalledWith(message);

    unsubscribe();
  });

  it("receives fallback messages via storage event", () => {
    const callback = vi.fn();
    subscribeWalletSync(callback);

    const message: WalletSyncMessage = {
      type: "ACCOUNT_CHANGED",
      address: "GA2C5RFPE6GCKMY3US5PAB6UZLKIGAHWKXX2G6EXO2Z6K3M4GBZXN7P",
    };

    const storageEvent = new StorageEvent("storage", {
      key: "synapse_wallet_sync_event",
      newValue: JSON.stringify(message),
    });

    storageListeners.forEach((listener) => {
      listener(storageEvent);
    });

    expect(callback).toHaveBeenCalledWith(message);
  });
});
