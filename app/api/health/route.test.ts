import { describe, expect, it, vi } from "vitest";

/**
 * Tests for the synthetic health endpoint's contract.
 *
 * The important property is the split between app availability and RPC
 * availability: a reachable app with a dead RPC must still return 200 and
 * `app.reachable: true`, otherwise an upstream provider outage would be
 * reported as the dashboard being down and send someone to the wrong incident.
 */

const REACHABLE = {
  reachable: true,
  endpoint: "https://rpc.example.com",
  latencyMs: 12,
  latestLedger: 99,
};
const UNREACHABLE = {
  reachable: false,
  endpoint: "https://rpc.example.com",
  error: "connection refused",
};

async function callRoute(getHealth: () => Promise<unknown>) {
  vi.resetModules();
  vi.doMock("@/lib/soroban/rpcHealth", () => ({ getHealth }));

  const { GET } = await import("./route");
  const response = await GET();
  const body = await response.json();
  return { status: response.status, body, headers: response.headers };
}

describe("GET /api/health", () => {
  it("returns 200 with both states reported when healthy", async () => {
    const { status, body } = await callRoute(async () => REACHABLE);

    expect(status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.app.reachable).toBe(true);
    expect(body.rpc.reachable).toBe(true);
    expect(body.rpc.latestLedger).toBe(99);
  });

  it("still returns 200 when only the RPC is down", async () => {
    // The critical case: the deployment is fine, the provider is not.
    const { status, body } = await callRoute(async () => UNREACHABLE);

    expect(status).toBe(200);
    expect(body.status).toBe("degraded");
    expect(body.app.reachable).toBe(true);
    expect(body.rpc.reachable).toBe(false);
    expect(body.rpc.error).toBe("connection refused");
  });

  it("forbids caching so an outage cannot be masked by a cached 200", async () => {
    const { headers } = await callRoute(async () => REACHABLE);

    expect(headers.get("cache-control")).toContain("no-store");
  });

  it("includes a timestamp for the alert payload", async () => {
    const { body } = await callRoute(async () => REACHABLE);

    expect(Number.isNaN(Date.parse(body.checkedAt))).toBe(false);
  });

  it("echoes the probed endpoint so a misconfiguration is visible", async () => {
    const { body } = await callRoute(async () => UNREACHABLE);

    expect(body.rpc.endpoint).toBe("https://rpc.example.com");
  });
});
