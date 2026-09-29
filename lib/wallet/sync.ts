export type WalletSyncMessage =
  | { type: "CONNECTED"; address: string; walletId?: string }
  | { type: "DISCONNECTED" }
  | { type: "ACCOUNT_CHANGED"; address: string };

const CHANNEL_NAME = "synapse_wallet_sync";
const STORAGE_SYNC_KEY = "synapse_wallet_sync_event";

function getChannel(): BroadcastChannel | null {
  if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") {
    return null;
  }
  try {
    return new BroadcastChannel(CHANNEL_NAME);
  } catch {
    return null;
  }
}

/**
 * Broadcasts a wallet connection state change to all other open tabs.
 */
export function broadcastWalletEvent(message: WalletSyncMessage): void {
  if (typeof window === "undefined") return;

  const channel = getChannel();
  if (channel) {
    try {
      channel.postMessage(message);
      channel.close?.();
    } catch {
      // Channel post failed, fallback to storage event
    }
  }

  // Fallback / accompaniment via localStorage to trigger storage events across windows/tabs
  try {
    localStorage.setItem(STORAGE_SYNC_KEY, JSON.stringify({ ...message, _timestamp: Date.now() }));
  } catch {
    // Storage access unavailable
  }
}

/**
 * Subscribes to cross-tab wallet sync messages.
 * Returns a cleanup unsubscribe function.
 */
export function subscribeWalletSync(onMessage: (message: WalletSyncMessage) => void): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }

  const channel = getChannel();

  const handleBroadcastMessage = (event: MessageEvent) => {
    if (event.data && typeof event.data === "object" && "type" in event.data) {
      onMessage(event.data as WalletSyncMessage);
    }
  };

  const handleStorageEvent = (event: StorageEvent) => {
    if (event.key === STORAGE_SYNC_KEY && event.newValue) {
      try {
        const parsed = JSON.parse(event.newValue);
        if (parsed && "type" in parsed) {
          onMessage(parsed as WalletSyncMessage);
        }
      } catch {
        // Invalid payload
      }
    }
  };

  if (channel) {
    channel.addEventListener("message", handleBroadcastMessage);
  }
  window.addEventListener("storage", handleStorageEvent);

  return () => {
    if (channel) {
      channel.removeEventListener("message", handleBroadcastMessage);
      channel.close?.();
    }
    window.removeEventListener("storage", handleStorageEvent);
  };
}
