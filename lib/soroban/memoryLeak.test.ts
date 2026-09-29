import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSorobanEventPoller } from "./events";

describe("Long-Lived Polling Hooks Memory Leak Suite", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("properly stops interval and removes all listeners on stop/unmount", () => {
    const poller = createSorobanEventPoller("https://soroban-testnet.stellar.org");
    const healthListener = vi.fn();
    const eventListener = vi.fn();

    const unsubscribeHealth = poller.onHealth(healthListener);
    const unsubscribeEvents = poller.onEvents(eventListener);

    poller.start();

    // Fast-forward multiple polling cycles
    vi.advanceTimersByTime(15000);

    unsubscribeHealth();
    unsubscribeEvents();
    poller.stop();

    // Verify after stop and unsubscribe, no additional listener calls happen
    const callsHealthBefore = healthListener.mock.calls.length;
    vi.advanceTimersByTime(20000);
    expect(healthListener.mock.calls.length).toBe(callsHealthBefore);
  });
});
