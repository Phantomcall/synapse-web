import { NextResponse } from "next/server";

import { getHealth } from "@/lib/soroban/rpcHealth";

/**
 * Synthetic health endpoint for the deployed dashboard.
 *
 * The external monitor polls this on a schedule. Two things are checked
 * separately, because they need different responses:
 *
 * - **app** — this route and the deployment answering at all.
 * - **rpc** — a real `getHealth` call to the configured Soroban endpoint, so an
 *   RPC provider outage is detected here rather than being reported as the
 *   dashboard being down.
 *
 * The two are reported independently in the body, and the status code reflects
 * the app only: a reachable app with a dead RPC is still a reachable app, and
 * monitoring the deployment's availability by proxying an upstream provider's
 * uptime would produce false "site is down" pages.
 *
 * Never cached: a cached 200 would hide exactly the outage this exists to catch.
 */

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  // If this line runs at all, the deployment is serving.
  const rpc = await getHealth();

  const body = {
    status: rpc.reachable ? "ok" : "degraded",
    app: { reachable: true },
    rpc,
    checkedAt: new Date().toISOString(),
  };

  return NextResponse.json(body, {
    // 200 while the app is up even if the RPC is not: see the note above.
    status: 200,
    headers: {
      "cache-control": "no-store, no-cache, must-revalidate",
    },
  });
}
