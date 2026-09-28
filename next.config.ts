import type { NextConfig } from "next";

import { loadConfig } from "./lib/config/env";

/**
 * Validate the environment at build time.
 *
 * The app reads every `NEXT_PUBLIC_*` value in the browser bundle, so a
 * misconfigured value is invisible until a deployed instance quietly shows the
 * wrong chain's data. Catching it here turns that into a failed build with an
 * actionable message, instead of a production incident.
 *
 * `next.config.ts` is TypeScript, so the config module is imported directly and
 * shares the same schema the client uses -- there is no second, drifting copy of
 * the rules.
 */
function validateEnvironment(): void {
  const result = loadConfig(
    process.env as Record<string, string>,
    process.env.NODE_ENV === "production"
  );

  if (result.ok) {
    if (result.missingForProduction.length === 0) {
      console.log(
        `[config] ok: network=${result.env?.NEXT_PUBLIC_NETWORK} ` +
          `contract=${result.env?.NEXT_PUBLIC_CONTRACT_ID ?? "(none — mock data)"}`
      );
    }
    return;
  }

  const message = [
    "",
    "┌─ Invalid environment configuration ─────────────────────────────────",
    ...result.errors.map((e) => `│ ${e}`),
    "│",
    "│ See .env.example for the full list of supported values.",
    "└──────────────────────────────────────────────────────────────────────",
    "",
  ].join("\n");

  throw new Error(message);
}

validateEnvironment();

const nextConfig: NextConfig = {/* config options here */};

export default nextConfig;
