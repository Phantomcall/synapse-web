export type Politeness = "polite" | "assertive";

export interface Announcement {
  id: string;
  message: string;
  politeness: Politeness;
  timestamp: number;
}

type AnnouncementListener = (announcement: Announcement) => void;

const listeners: Set<AnnouncementListener> = new Set();
let pendingBatch: string[] = [];
let batchTimeout: NodeJS.Timeout | null = null;
const BATCH_DEBOUNCE_MS = 250;

/**
 * Dispatches an immediate or batched announcement to all active live regions.
 */
export function announce(
  message: string,
  politeness: Politeness = "polite",
  options: { immediate?: boolean } = {}
): void {
  if (!message || typeof message !== "string") return;

  if (politeness === "assertive" || options.immediate) {
    const announcement: Announcement = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      message,
      politeness,
      timestamp: Date.now(),
    };
    listeners.forEach((listener) => listener(announcement));
    return;
  }

  // Batch polite announcements to avoid flooding screen readers
  pendingBatch.push(message);

  if (batchTimeout) {
    clearTimeout(batchTimeout);
  }

  batchTimeout = setTimeout(() => {
    if (pendingBatch.length === 0) return;

    let batchedMessage: string;
    if (pendingBatch.length === 1) {
      batchedMessage = pendingBatch[0];
    } else {
      batchedMessage = `${pendingBatch.length} updates: ${pendingBatch.join("; ")}`;
    }

    const announcement: Announcement = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      message: batchedMessage,
      politeness: "polite",
      timestamp: Date.now(),
    };

    pendingBatch = [];
    batchTimeout = null;
    listeners.forEach((listener) => listener(announcement));
  }, BATCH_DEBOUNCE_MS);
}

/**
 * Subscribes to live announcements. Returns an unsubscribe cleanup function.
 */
export function subscribeAnnouncements(listener: AnnouncementListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
