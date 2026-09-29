#!/usr/bin/env node
// Canary rollout controller (#156).
//
// Traffic splitting is Vercel's native Rolling Releases feature. This script
// supplies the automated judgement Vercel leaves to a human: each poll it
// probes the canary, pulls real-user health signals, asks canary-policy.mjs
// what to do, and approves the next stage, completes the release, or rolls
// production back to the previous deployment.
//
//   node scripts/deploy/canary-controller.mjs run --canary <dpl_id> [--drill]
//   node scripts/deploy/canary-controller.mjs rollback [--reason "..."]
//   node scripts/deploy/canary-controller.mjs promote
//   node scripts/deploy/canary-controller.mjs status
//
// Environment:
//   VERCEL_TOKEN, VERCEL_PROJECT_ID, VERCEL_ORG_ID   required
//   CANARY_SIGNALS_URL, CANARY_SIGNALS_TOKEN         optional RUM endpoint (docs/deploy/canary-rollout.md)
//   VERCEL_AUTOMATION_BYPASS_SECRET                  optional, for protected deployment URLs
//   CANARY_POLICY                                    default .github/canary-policy.json
//
// Exit codes: 0 promoted (or override applied), 1 rolled back / aborted / error.

import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { decide, validatePolicy } from "./canary-policy.mjs";

/** Probe path used by `--drill`. It must 404, which counts as a failed probe. */
export const DRILL_PROBE_PATH = "/__canary-drill__/intentionally-missing";

/**
 * @typedef {{
 *   state: "ACTIVE" | "COMPLETE" | "ABORTED",
 *   activeStage: { index: number, targetPercentage: number, isFinalStage: boolean } | null,
 *   nextStage: { index: number, targetPercentage: number, isFinalStage: boolean } | null,
 *   canaryDeployment: { id: string, url: string } | null,
 *   currentDeployment: { id: string, url: string } | null,
 * }} RollingRelease
 *
 * @typedef {{
 *   getRelease(): Promise<RollingRelease | null>,
 *   approveStage(canaryId: string, nextStageIndex: number): Promise<void>,
 *   complete(canaryId: string): Promise<void>,
 *   rollback(toDeploymentId: string, reason: string): Promise<void>,
 * }} Platform
 */

/**
 * Drives one rolling release to completion or rollback.
 *
 * @param {{
 *   canaryDeploymentId: string,
 *   policy: any,
 *   platform: Platform,
 *   probe: (url: string) => Promise<import("./canary-policy.mjs").Probe>,
 *   signals?: ((deploymentId: string, sinceMs: number) => Promise<import("./canary-policy.mjs").RumSignals | null>) | null,
 *   now?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 *   log?: (line: string) => void,
 *   drill?: boolean,
 * }} opts
 * @returns {Promise<{ outcome: "promoted" | "rolled-back" | "aborted-externally" | "superseded", reasons: string[] }>}
 */
export async function runCanary({
  canaryDeploymentId,
  policy,
  platform,
  probe,
  signals = null,
  now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  log = console.log,
  drill = false,
}) {
  validatePolicy(policy);
  const probePaths = drill ? [DRILL_PROBE_PATH] : policy.probe.paths;
  if (drill)
    log(`DRILL: probing ${DRILL_PROBE_PATH}, which must 404, to prove automated rollback fires`);

  /** @type {number | null} */
  let stageIndex = null;
  let stageStart = now();
  /** @type {import("./canary-policy.mjs").Probe[]} */
  let probes = [];

  for (;;) {
    const rr = await platform.getRelease();
    if (!rr || rr.state === "COMPLETE") {
      log("Rolling release is complete; canary is serving 100% of production traffic.");
      return { outcome: "promoted", reasons: [] };
    }
    if (rr.state === "ABORTED") {
      log(
        "Rolling release was aborted outside this controller (manual override or Instant Rollback)."
      );
      return { outcome: "aborted-externally", reasons: ["aborted outside the controller"] };
    }
    if (rr.canaryDeployment?.id !== canaryDeploymentId) {
      log(
        `Active rolling release is for ${rr.canaryDeployment?.id}, not ${canaryDeploymentId}; stopping.`
      );
      return {
        outcome: "superseded",
        reasons: [`release now belongs to ${rr.canaryDeployment?.id}`],
      };
    }
    if (!rr.activeStage) throw new Error("Active rolling release has no activeStage");

    if (rr.activeStage.index !== stageIndex) {
      stageIndex = rr.activeStage.index;
      stageStart = now();
      probes = [];
      log(
        `Stage ${stageIndex}: canary receives ${rr.activeStage.targetPercentage}% of production traffic.`
      );
    }

    for (const path of probePaths)
      probes.push(await probe(`https://${rr.canaryDeployment.url}${path}`));

    let canary = null;
    let baseline = null;
    if (signals) {
      try {
        [canary, baseline] = await Promise.all([
          signals(rr.canaryDeployment.id, stageStart),
          rr.currentDeployment
            ? signals(rr.currentDeployment.id, stageStart)
            : Promise.resolve(null),
        ]);
      } catch (err) {
        log(
          `WARN: health signals unavailable this poll: ${err instanceof Error ? err.message : err}`
        );
      }
    }

    const elapsed = now() - stageStart;
    const decision = decide({ policy, stageElapsedMs: elapsed, probes, canary, baseline });
    log(
      `[stage ${stageIndex} +${Math.round(elapsed / 1000)}s] ${decision.action}: ${[...decision.reasons, ...decision.notes].join("; ")}`
    );

    if (
      decision.action === "rollback" ||
      (decision.action === "wait" && elapsed > policy.maxStageMinutes * 60_000)
    ) {
      const reasons =
        decision.action === "rollback"
          ? decision.reasons
          : [`no promote decision within ${policy.maxStageMinutes} min at stage ${stageIndex}`];
      if (!rr.currentDeployment)
        throw new Error("Cannot roll back: rolling release has no current (base) deployment");
      await platform.rollback(
        rr.currentDeployment.id,
        `Automated canary rollback: ${reasons.join("; ")}`.slice(0, 250)
      );
      log(`ROLLED BACK to ${rr.currentDeployment.id}: ${reasons.join("; ")}`);
      return { outcome: "rolled-back", reasons };
    }

    if (decision.action === "advance") {
      if (!rr.nextStage || rr.nextStage.isFinalStage) {
        await platform.complete(canaryDeploymentId);
        log("Promoted canary to 100% of production traffic.");
        return { outcome: "promoted", reasons: [] };
      }
      await platform.approveStage(canaryDeploymentId, rr.nextStage.index);
      log(`Approved stage ${rr.nextStage.index} (${rr.nextStage.targetPercentage}%).`);
      continue;
    }

    await sleep(policy.pollSeconds * 1000);
  }
}

// ── Vercel adapter ─────────────────────────────────────────────────────────────

/**
 * @param {{ token: string, projectId: string, orgId?: string, fetchImpl?: typeof fetch }} cfg
 * @returns {Platform}
 */
export function vercelPlatform({ token, projectId, orgId, fetchImpl = fetch }) {
  // Personal accounts have a user id here, and teamId must be omitted for them.
  const team = orgId?.startsWith("team_") ? `teamId=${encodeURIComponent(orgId)}` : "";
  const project = encodeURIComponent(projectId);
  const call = async (method, path, body) => {
    const sep = path.includes("?") ? "&" : "?";
    const res = await fetchImpl(`https://api.vercel.com${path}${team ? sep + team : ""}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok)
      throw new Error(`Vercel ${method} ${path} → HTTP ${res.status}: ${text.slice(0, 500)}`);
    return text ? JSON.parse(text) : {};
  };
  return {
    async getRelease() {
      return (await call("GET", `/v1/projects/${project}/rolling-release`)).rollingRelease ?? null;
    },
    async approveStage(canaryDeploymentId, nextStageIndex) {
      await call("POST", `/v1/projects/${project}/rolling-release/approve-stage`, {
        canaryDeploymentId,
        nextStageIndex,
      });
    },
    async complete(canaryDeploymentId) {
      await call("POST", `/v1/projects/${project}/rolling-release/complete`, {
        canaryDeploymentId,
      });
    },
    async rollback(toDeploymentId, reason) {
      const q = `description=${encodeURIComponent(reason)}`;
      await call(
        "POST",
        `/v1/projects/${project}/rollback/${encodeURIComponent(toDeploymentId)}?${q}`
      );
    },
  };
}

/** Starts (idempotently) a rolling release for a freshly built production deployment. */
export async function startRelease({
  token,
  projectId,
  orgId,
  canaryDeploymentId,
  fetchImpl = fetch,
}) {
  const team = orgId?.startsWith("team_") ? `?teamId=${encodeURIComponent(orgId)}` : "";
  const res = await fetchImpl(
    `https://api.vercel.com/v1/projects/${encodeURIComponent(projectId)}/rolling-release/start${team}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ canaryDeploymentId }),
    }
  );
  if (!res.ok)
    throw new Error(
      `Starting rolling release failed: HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`
    );
}

// ── Signal sources ─────────────────────────────────────────────────────────────

/**
 * Synthetic probe: any 2xx/3xx within the timeout is healthy.
 *
 * @param {{ timeoutMs: number, bypassSecret?: string, fetchImpl?: typeof fetch }} opts
 */
export function httpProbe({ timeoutMs, bypassSecret, fetchImpl = fetch }) {
  return async (url) => {
    const started = Date.now();
    try {
      const res = await fetchImpl(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          "user-agent": "synapse-canary-probe",
          ...(bypassSecret ? { "x-vercel-protection-bypass": bypassSecret } : {}),
        },
      });
      return { ok: res.status < 400, status: res.status, durationMs: Date.now() - started };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.name + ": " + err.message : String(err),
        durationMs: Date.now() - started,
      };
    }
  };
}

/**
 * RUM signals endpoint contract (docs/deploy/canary-rollout.md):
 *   GET <url>?deploymentId=dpl_…&since=<ISO-8601>
 *   → { requests, errors, webVitals: { lcp: { p75, samples }, inp: {…}, cls: {…} } }
 *
 * @param {{ url: string, token?: string, fetchImpl?: typeof fetch }} opts
 */
export function httpSignals({ url, token, fetchImpl = fetch }) {
  return async (deploymentId, sinceMs) => {
    const u = new URL(url);
    u.searchParams.set("deploymentId", deploymentId);
    u.searchParams.set("since", new Date(sinceMs).toISOString());
    const res = await fetchImpl(u, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`signals endpoint HTTP ${res.status}`);
    const body = await res.json();
    if (typeof body?.requests !== "number" || typeof body?.errors !== "number")
      throw new Error("signals endpoint returned an unexpected payload");
    return body;
  };
}

// ── CLI ────────────────────────────────────────────────────────────────────────

function env(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

function summary(line) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, line + "\n");
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const flag = (name) => rest.includes(`--${name}`);
  const opt = (name) => {
    const i = rest.indexOf(`--${name}`);
    return i === -1 ? undefined : rest[i + 1];
  };
  const cfg = {
    token: env("VERCEL_TOKEN"),
    projectId: env("VERCEL_PROJECT_ID"),
    orgId: process.env.VERCEL_ORG_ID,
  };
  const platform = vercelPlatform(cfg);

  if (command === "start") {
    await startRelease({
      ...cfg,
      canaryDeploymentId: opt("canary") ?? env("CANARY_DEPLOYMENT_ID"),
    });
    console.log("Rolling release started.");
    return 0;
  }

  if (command === "status") {
    console.log(JSON.stringify(await platform.getRelease(), null, 2));
    return 0;
  }

  if (command === "rollback" || command === "promote") {
    const rr = await platform.getRelease();
    const reason = `Manual rollback: ${opt("reason") || "operator override"}`.slice(0, 250);
    if (!rr || rr.state !== "ACTIVE" || !rr.canaryDeployment) {
      // Already fully promoted: rolling back needs an explicit target.
      const to = opt("to");
      if (command === "rollback" && to) {
        await platform.rollback(to, reason);
        summary(`Manually rolled production back to \`${to}\`. ${reason}`);
        console.log("rollback applied.");
        return 0;
      }
      const msg =
        command === "rollback"
          ? "No active rolling release. To roll back a completed release, pass the previous production deployment id (workflow input `to_deployment`)."
          : "No active rolling release; nothing to promote.";
      console.log(msg);
      summary(msg);
      return command === "rollback" ? 1 : 0;
    }
    if (command === "promote") {
      await platform.complete(rr.canaryDeployment.id);
      summary(`Manually promoted \`${rr.canaryDeployment.id}\` to 100%.`);
    } else {
      if (!rr.currentDeployment)
        throw new Error("Active release has no base deployment to roll back to");
      await platform.rollback(rr.currentDeployment.id, reason);
      summary(`Manually rolled back to \`${rr.currentDeployment.id}\`. ${reason}`);
    }
    console.log(`${command} applied.`);
    return 0;
  }

  if (command === "run") {
    const policy = JSON.parse(
      readFileSync(process.env.CANARY_POLICY || ".github/canary-policy.json", "utf8")
    );
    const lines = [];
    const result = await runCanary({
      canaryDeploymentId: opt("canary") ?? env("CANARY_DEPLOYMENT_ID"),
      policy,
      platform,
      drill: flag("drill"),
      probe: httpProbe({
        timeoutMs: policy.probe.timeoutMs,
        bypassSecret: process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
      }),
      signals: process.env.CANARY_SIGNALS_URL
        ? httpSignals({
            url: process.env.CANARY_SIGNALS_URL,
            token: process.env.CANARY_SIGNALS_TOKEN,
          })
        : null,
      log: (l) => {
        console.log(l);
        lines.push(l);
      },
    });
    summary(`## Canary rollout: ${result.outcome}\n\n\`\`\`\n${lines.join("\n")}\n\`\`\``);
    if (result.outcome !== "promoted") {
      console.log(`::error title=Canary ${result.outcome}::${result.reasons.join("; ")}`);
      return 1;
    }
    return 0;
  }

  console.error(
    "usage: canary-controller.mjs <start|run|rollback|promote|status> [--canary dpl_…] [--drill] [--reason …] [--to dpl_…]"
  );
  return 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(
        `::error title=Canary controller failed::${err instanceof Error ? err.message : err}`
      );
      process.exit(1);
    }
  );
}
