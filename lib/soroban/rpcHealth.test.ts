import { describe, expect, it, vi } from "vitest";

import { DEFAULT_TIMEOUT_MS, TimeoutError, getHealth, withTimeout } from "./rpcHealth";

/** A monotonic clock the test advances, so latency assertions are deterministic. */
function fakeClock() {
  let t = 1_000;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("getHealth", () => {
  it("reports reachable with the latest ledger on a healthy endpoint", async () => {
    const clock = fakeClock();
    const fetchStatus = vi.fn(async () => ({ latestLedger: 1234 })) as never;

    const result = await getHealth({
      rpcUrl: "https://rpc.example.com",
      now: clock.now,
      fetchStatus,
    });

    expect(result.reachable).toBe(true);
    expect(result.endpoint).toBe("https://rpc.example.com");
    expect(result.latestLedger).toBe(1234);
    expect(result.error).toBeUndefined();
  });

  it("treats a missing latestLedger as healthy, not as a failure", async () => {
    // Some providers omit the field on success. Failing here would report a
    // healthy endpoint as down.
    const fetchStatus = vi.fn(async () => ({})) as never;

    const result = await getHealth({ rpcUrl: "https://rpc.example.com", fetchStatus });

    expect(result.reachable).toBe(true);
    expect(result.latestLedger).toBeUndefined();
  });

  it("records latency", async () => {
    const clock = fakeClock();
    const fetchStatus = vi.fn(async () => {
      clock.advance(42);
      return { latestLedger: 1 };
    }) as never;

    const result = await getHealth({ now: clock.now, fetchStatus });

    expect(result.latencyMs).toBe(42);
  });

  it("reports unreachable when the endpoint throws", async () => {
    const fetchStatus = vi.fn(async () => {
      throw new Error("connection refused");
    }) as never;

    const result = await getHealth({ rpcUrl: "https://rpc.example.com", fetchStatus });

    expect(result.reachable).toBe(false);
    expect(result.error).toBe("connection refused");
    // The endpoint is echoed so a misconfigured URL is visible in the alert.
    expect(result.endpoint).toBe("https://rpc.example.com");
  });

  it("times out a hung endpoint instead of hanging forever", async () => {
    // Never resolves. Without the timeout the monitor would wait indefinitely
    // and a hung provider would look identical to a healthy one.
    const fetchStatus = vi.fn(() => new Promise<never>(() => {})) as never;

    const result = await getHealth({
      rpcUrl: "https://rpc.example.com",
      timeoutMs: 20,
      fetchStatus,
    });

    expect(result.reachable).toBe(false);
    expect(result.error).toMatch(/did not respond within 20ms/);
  });

  it("truncates a very long provider error", async () => {
    const fetchStatus = vi.fn(async () => {
      throw new Error("x".repeat(5_000));
    }) as never;

    const result = await getHealth({ fetchStatus });

    // The error text goes into a monitoring payload, so it is bounded.
    expect(result.error!.length).toBeLessThanOrEqual(200);
  });

  it("handles a non-Error throw", async () => {
    const fetchStatus = vi.fn(async () => {
      throw "a bare string";
    }) as never;

    const result = await getHealth({ fetchStatus });

    expect(result.reachable).toBe(false);
    expect(result.error).toBe("a bare string");
  });
});

describe("withTimeout", () => {
  it("resolves when the promise settles in time", async () => {
    await expect(withTimeout(Promise.resolve("ok"), 50)).resolves.toBe("ok");
  });

  it("propagates a rejection", async () => {
    await expect(withTimeout(Promise.reject(new Error("boom")), 50)).rejects.toThrow("boom");
  });

  it("rejects with TimeoutError after the limit", async () => {
    const promise = withTimeout(new Promise<never>(() => {}), 10);

    await expect(promise).rejects.toBeInstanceOf(TimeoutError);
  });

  it("does not reject once the promise has already settled", async () => {
    // A slow-but-successful call must not be reported as a timeout.
    const result = await withTimeout(
      new Promise<string>((resolve) => setTimeout(() => resolve("slow"), 5)),
      200
    );

    expect(result).toBe("slow");
  });
});

describe("defaults", () => {
  it("uses a bounded default timeout", () => {
    expect(DEFAULT_TIMEOUT_MS).toBeGreaterThan(0);
    expect(DEFAULT_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
  });
});
