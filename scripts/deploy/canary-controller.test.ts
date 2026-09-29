import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DRILL_PROBE_PATH,
  httpProbe,
  httpSignals,
  runCanary,
  startRelease,
  vercelPlatform,
} from "./canary-controller.mjs";

const policy = JSON.parse(
  readFileSync(path.join(__dirname, "..", "..", ".github", "canary-policy.json"), "utf8")
);

const CANARY = { id: "dpl_canary", url: "synapse-canary.vercel.app" };
const BASE = { id: "dpl_base", url: "synapse-base.vercel.app" };
const STAGES = [5, 25, 100];

/** In-memory stand-in for a Vercel project with Rolling Releases (manual approval, 5 → 25 → 100). */
function simulatedVercel() {
  const calls: string[] = [];
  let state: "ACTIVE" | "COMPLETE" | "ABORTED" = "ACTIVE";
  let index = 0;
  let production = BASE.id;
  const stage = (i: number) =>
    i < STAGES.length
      ? { index: i, targetPercentage: STAGES[i]!, isFinalStage: STAGES[i] === 100 }
      : null;
  return {
    calls,
    get production() {
      return production;
    },
    abortExternally() {
      state = "ABORTED";
    },
    platform: {
      async getRelease() {
        if (state === "COMPLETE") return null;
        return {
          state,
          activeStage: state === "ACTIVE" ? stage(index) : null,
          nextStage: state === "ACTIVE" ? stage(index + 1) : null,
          canaryDeployment: CANARY,
          currentDeployment: BASE,
        };
      },
      async approveStage(canaryId: string, next: number) {
        calls.push(`approve ${canaryId} ${next}`);
        index = next;
      },
      async complete(canaryId: string) {
        calls.push(`complete ${canaryId}`);
        state = "COMPLETE";
        production = canaryId;
      },
      async rollback(to: string, reason: string) {
        calls.push(`rollback ${to}: ${reason}`);
        state = "ABORTED";
        production = to;
      },
    },
  };
}

function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

const healthyProbe = async () => ({ ok: true, status: 200 });

describe("runCanary", () => {
  it("promotes a healthy canary through every stage", async () => {
    const vercel = simulatedVercel();
    const result = await runCanary({
      canaryDeploymentId: CANARY.id,
      policy,
      platform: vercel.platform,
      probe: healthyProbe,
      ...fakeClock(),
      log: () => {},
    });
    expect(result.outcome).toBe("promoted");
    expect(vercel.calls).toEqual(["approve dpl_canary 1", "complete dpl_canary"]);
    expect(vercel.production).toBe(CANARY.id);
  });

  it("rolls back automatically when the canary's error rate spikes (deliberate regression)", async () => {
    const vercel = simulatedVercel();
    const clock = fakeClock();
    // Healthy at 5%; at 25% the canary starts failing 8% of real-user requests.
    const signals = async (deploymentId: string) => {
      const release = await vercel.platform.getRelease();
      const atSecondStage = release?.activeStage?.index === 1;
      if (deploymentId === CANARY.id && atSecondStage) return { requests: 500, errors: 40 };
      return { requests: 500, errors: 1 };
    };
    const log: string[] = [];
    const result = await runCanary({
      canaryDeploymentId: CANARY.id,
      policy,
      platform: vercel.platform,
      probe: healthyProbe,
      signals,
      ...clock,
      log: (l: string) => log.push(l),
    });
    expect(result.outcome).toBe("rolled-back");
    expect(result.reasons[0]).toMatch(/error rate: canary 8\.00%/);
    expect(vercel.calls[0]).toBe("approve dpl_canary 1");
    expect(vercel.calls[1]).toMatch(/^rollback dpl_base: Automated canary rollback: error rate/);
    expect(vercel.production).toBe(BASE.id);
    // Detected on the first poll of the bad stage, not after the bake.
    expect(clock.now()).toBe(policy.bakeMinutes * 60_000);
  });

  it("drill mode probes a missing path and rolls back within the consecutive-failure limit", async () => {
    const vercel = simulatedVercel();
    const clock = fakeClock();
    const probed: string[] = [];
    const fetchImpl = (async (url: string) => {
      probed.push(url);
      return new Response("not found", { status: url.endsWith(DRILL_PROBE_PATH) ? 404 : 200 });
    }) as unknown as typeof fetch;
    const result = await runCanary({
      canaryDeploymentId: CANARY.id,
      policy,
      platform: vercel.platform,
      probe: httpProbe({ timeoutMs: 1000, fetchImpl }),
      drill: true,
      ...clock,
      log: () => {},
    });
    expect(result.outcome).toBe("rolled-back");
    expect(probed[0]).toBe(`https://${CANARY.url}${DRILL_PROBE_PATH}`);
    expect(probed).toHaveLength(policy.synthetic.consecutiveFailures);
    expect(clock.now()).toBe(
      (policy.synthetic.consecutiveFailures - 1) * policy.pollSeconds * 1000
    );
    expect(vercel.production).toBe(BASE.id);
  });

  it("stops when an operator aborts the release outside the controller", async () => {
    const vercel = simulatedVercel();
    let polls = 0;
    const result = await runCanary({
      canaryDeploymentId: CANARY.id,
      policy,
      platform: vercel.platform,
      probe: async () => {
        if (++polls === 3) vercel.abortExternally();
        return { ok: true, status: 200 };
      },
      ...fakeClock(),
      log: () => {},
    });
    expect(result.outcome).toBe("aborted-externally");
    expect(vercel.calls).toEqual([]);
  });

  it("refuses to drive a release that belongs to a different deployment", async () => {
    const vercel = simulatedVercel();
    const result = await runCanary({
      canaryDeploymentId: "dpl_other",
      policy,
      platform: vercel.platform,
      probe: healthyProbe,
      ...fakeClock(),
      log: () => {},
    });
    expect(result.outcome).toBe("superseded");
    expect(vercel.calls).toEqual([]);
  });

  it("keeps deciding on synthetic probes when the signals endpoint is down", async () => {
    const vercel = simulatedVercel();
    const log: string[] = [];
    const result = await runCanary({
      canaryDeploymentId: CANARY.id,
      policy,
      platform: vercel.platform,
      probe: healthyProbe,
      signals: async () => {
        throw new Error("ECONNREFUSED");
      },
      ...fakeClock(),
      log: (l: string) => log.push(l),
    });
    expect(result.outcome).toBe("promoted");
    expect(log.some((l) => l.includes("health signals unavailable this poll: ECONNREFUSED"))).toBe(
      true
    );
  });
});

describe("vercelPlatform", () => {
  function recordingFetch(response: object = {}) {
    const requests: { url: string; method: string; body?: string }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      requests.push({ url, method: init.method ?? "GET", body: init.body as string | undefined });
      return new Response(JSON.stringify(response), { status: 200 });
    }) as unknown as typeof fetch;
    return { requests, fetchImpl };
  }

  it("calls the Rolling Releases endpoints with the team scope", async () => {
    const { requests, fetchImpl } = recordingFetch({ rollingRelease: null });
    const p = vercelPlatform({
      token: "t",
      projectId: "synapse-web",
      orgId: "team_123",
      fetchImpl,
    });
    await p.getRelease();
    await p.approveStage("dpl_c", 1);
    await p.complete("dpl_c");
    await p.rollback("dpl_b", "bad deploy");
    expect(requests).toEqual([
      {
        url: "https://api.vercel.com/v1/projects/synapse-web/rolling-release?teamId=team_123",
        method: "GET",
        body: undefined,
      },
      {
        url: "https://api.vercel.com/v1/projects/synapse-web/rolling-release/approve-stage?teamId=team_123",
        method: "POST",
        body: JSON.stringify({ canaryDeploymentId: "dpl_c", nextStageIndex: 1 }),
      },
      {
        url: "https://api.vercel.com/v1/projects/synapse-web/rolling-release/complete?teamId=team_123",
        method: "POST",
        body: JSON.stringify({ canaryDeploymentId: "dpl_c" }),
      },
      {
        url: "https://api.vercel.com/v1/projects/synapse-web/rollback/dpl_b?description=bad%20deploy&teamId=team_123",
        method: "POST",
        body: undefined,
      },
    ]);
  });

  it("omits teamId for personal accounts", async () => {
    const { requests, fetchImpl } = recordingFetch({ rollingRelease: null });
    await vercelPlatform({ token: "t", projectId: "p", orgId: "abc123", fetchImpl }).getRelease();
    expect(requests[0]!.url).toBe("https://api.vercel.com/v1/projects/p/rolling-release");
  });

  it("surfaces API errors with the status and body", async () => {
    const fetchImpl = (async () =>
      new Response("forbidden", { status: 403 })) as unknown as typeof fetch;
    await expect(
      vercelPlatform({ token: "t", projectId: "p", fetchImpl }).getRelease()
    ).rejects.toThrow(/HTTP 403: forbidden/);
  });

  it("starts a release for the new deployment", async () => {
    const { requests, fetchImpl } = recordingFetch();
    await startRelease({
      token: "t",
      projectId: "p",
      orgId: "team_1",
      canaryDeploymentId: "dpl_new",
      fetchImpl,
    });
    expect(requests[0]).toEqual({
      url: "https://api.vercel.com/v1/projects/p/rolling-release/start?teamId=team_1",
      method: "POST",
      body: JSON.stringify({ canaryDeploymentId: "dpl_new" }),
    });
  });
});

describe("signal sources", () => {
  it("treats network errors and 5xx as failed probes", async () => {
    const down = httpProbe({
      timeoutMs: 100,
      fetchImpl: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });
    expect(await down("https://x")).toMatchObject({ ok: false, error: "TypeError: fetch failed" });
    const erroring = httpProbe({
      timeoutMs: 100,
      fetchImpl: (async () => new Response("", { status: 502 })) as unknown as typeof fetch,
    });
    expect(await erroring("https://x")).toMatchObject({ ok: false, status: 502 });
  });

  it("queries the signals endpoint per deployment and validates the payload", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (u: URL) => {
      urls.push(String(u));
      return new Response(JSON.stringify({ requests: 10, errors: 1 }), { status: 200 });
    }) as unknown as typeof fetch;
    const signals = httpSignals({
      url: "https://signals.example/api/canary",
      token: "s",
      fetchImpl,
    });
    expect(await signals("dpl_c", Date.UTC(2026, 8, 29))).toEqual({ requests: 10, errors: 1 });
    expect(urls[0]).toBe(
      "https://signals.example/api/canary?deploymentId=dpl_c&since=2026-09-29T00%3A00%3A00.000Z"
    );

    const bad = httpSignals({
      url: "https://signals.example",
      fetchImpl: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
    });
    await expect(bad("dpl_c", 0)).rejects.toThrow(/unexpected payload/);
  });
});
