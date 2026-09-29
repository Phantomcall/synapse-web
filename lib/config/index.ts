/**
 * The app's validated configuration, resolved once.
 *
 * Import this instead of reading `process.env` directly. Every `NEXT_PUBLIC_*`
 * read in the codebase goes through `lib/config/env.ts`, so a malformed value or
 * a network/RPC mismatch is reported once, with an actionable message, instead of
 * showing up later as a dashboard silently rendering the wrong chain's data.
 *
 * Scope boundary, stated explicitly because it is easy to get wrong: this app
 * has **no server-side secrets**. Every variable in the schema is `NEXT_PUBLIC_*`
 * (or a platform build variable), and `NEXT_PUBLIC_*` values are inlined into the
 * shipped JavaScript bundle. Nothing in `.env*` should ever hold a credential.
 */

import { readConfig, resolveNetwork, resolveRpcUrl, type Env } from "./env";

export interface AppConfig {
  /** Validated environment. */
  env: Env;
  /** Effective RPC endpoint — the override, or the network's canonical one. */
  rpcUrl: string;
  /** Deployed contract id, or undefined for a mock-data build. */
  contractId: string | undefined;
  /** Target network metadata, including the network passphrase. */
  network: ReturnType<typeof resolveNetwork>;
  /** Published origin of this deployment, if one is configured. */
  siteUrl: string | undefined;
}

function build(): AppConfig {
  const env = readConfig();
  return {
    env,
    rpcUrl: resolveRpcUrl(env),
    contractId: env.NEXT_PUBLIC_CONTRACT_ID,
    network: resolveNetwork(env),
    siteUrl: env.NEXT_PUBLIC_SITE_URL ?? (env.VERCEL_URL ? `https://${env.VERCEL_URL}` : undefined),
  };
}

let cached: AppConfig | undefined;

/**
 * The validated config.
 *
 * Memoised: the environment cannot change within a process, and re-parsing per
 * import site would re-run the same validation several times.
 *
 * Throws a `ConfigError` listing every problem at once when configuration is
 * invalid. In practice `next.config.ts` has already validated this at build
 * time, so a throw here means the build check was bypassed.
 */
export function getAppConfig(): AppConfig {
  cached ??= build();
  return cached;
}

/**
 * Eagerly-resolved config for module-scope constants.
 *
 * Convenient at import time, which is where the existing call sites need it
 * (`const RPC_URL = appConfig.rpcUrl`). The tradeoff is that this validates on
 * first import rather than on first use — intentional here, so a bad config
 * surfaces immediately instead of at the moment some component happens to read
 * it.
 */
export const appConfig: AppConfig = getAppConfig();

export {
  ConfigError,
  NETWORKS,
  loadConfig,
  readConfig,
  resolveNetwork,
  resolveRpcUrl,
} from "./env";
export type { Env, NetworkId } from "./env";
