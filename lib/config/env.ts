import { z } from "zod";

/**
 * Validated environment configuration.
 *
 * Every `process.env` read in the app goes through here. The point is to fail
 * loudly at startup on a misconfiguration -- "the staging build is pointed at
 * the wrong contract" is a class of bug that otherwise shows up as a dashboard
 * silently showing testnet data in a futurenet deployment.
 *
 * Two categories of setting:
 *
 * - **Required in production, optional in development.** A missing contract id
 *   is a legitimate local-dev state (the app falls back to mock data), but a
 *   *deployed* build with no contract id is a broken deploy, so it is required
 *   once `NODE_ENV === "production"`.
 * - **Validated for shape, not just presence.** `NEXT_PUBLIC_*` values end up
 *   inlined into the client bundle, so a malformed URL is a real failure mode
 *   rather than a hypothetical.
 *
 * Scope boundary: this module handles *shape* and *requiredness* only. There are
 * no server-side secrets in this app -- every variable here is `NEXT_PUBLIC_*`
 * or a platform-provided build variable, and all of them end up in the shipped
 * JavaScript bundle. Nothing in `.env*` should ever hold a credential. Secrets
 * management is explicitly out of scope; if this app ever gains a server-side
 * secret, it needs a different mechanism, because a `NEXT_PUBLIC_` value is
 * not a place to put one.
 */

/** Stellar contract id: a `C...` StrKey. */
const CONTRACT_ID_RE = /^C[0-9A-Z]{55}$/;

/** Stellar public networks, with their canonical RPC endpoints. */
export const NETWORKS = {
  testnet: {
    id: "testnet",
    label: "Testnet",
    passphrase: "Test SDF Network ; September 2015",
    rpcUrl: "https://soroban-testnet.stellar.org",
    explorer: "https://testnet.stellar.expert/explorer",
  },
  futurenet: {
    id: "futurenet",
    label: "Futurenet",
    passphrase: "Test SDF Future Network ; October 2022",
    rpcUrl: "https://rpc-futurenet.stellar.org",
    explorer: "https://futurenet.stellar.expert/explorer",
  },
  local: {
    id: "local",
    label: "Local",
    passphrase: "Local testnet",
    rpcUrl: "http://localhost:8000",
    explorer: "",
  },
} as const;

export type NetworkId = keyof typeof NETWORKS;

/**
 * Narrows an arbitrary string to a known network id.
 *
 * Used by the cross-validation pass, which runs over unvalidated input and so
 * cannot assume the value is already a `NetworkId`.
 */
export function isNetworkId(value: unknown): value is NetworkId {
  return typeof value === "string" && Object.hasOwn(NETWORKS, value);
}

/** Whether a string is an absolute `http(s)` URL, which is all an RPC needs. */
function isAbsoluteHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) {
    return false;
  }
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

const envSchema = z.object({
  /** Which Stellar network this build targets. Defaults to testnet. */
  NEXT_PUBLIC_NETWORK: z.enum(["testnet", "futurenet", "local"]).default("testnet"),

  /**
   * RPC endpoint. Optional: when unset, the selected network's canonical
   * endpoint is used, so a testnet build works with no configuration at all.
   *
   * `superRefine` rather than `.url().refine(...)`: chaining both would report
   * two issues for a single malformed value, which reads as two separate
   * problems in the build output. One value should yield one message.
   */
  NEXT_PUBLIC_SOROBAN_RPC_URL: z
    .string()
    .superRefine((value, ctx) => {
      if (!isAbsoluteHttpUrl(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "must be an absolute http or https URL, e.g. https://soroban-testnet.stellar.org",
        });
      }
    })
    .optional(),

  /** Deployed contract. Required in production, optional in dev (mock fallback). */
  NEXT_PUBLIC_CONTRACT_ID: z
    .string()
    .regex(
      CONTRACT_ID_RE,
      "must be a Stellar contract id: a 'C' followed by 55 uppercase base32 characters (check for a stray leading or trailing space)"
    )
    .optional(),

  /** Published address of this deployment, used for the canonical origin. */
  NEXT_PUBLIC_SITE_URL: z
    .string()
    .url("must be an absolute URL, e.g. https://synapse.example.com")
    .optional(),

  /** Extra canonical origins, comma- or space-separated. */
  NEXT_PUBLIC_CANONICAL_ORIGINS: z.string().optional(),

  /** Vercel supplies this at build time; used only as an origin fallback. */
  VERCEL_URL: z.string().optional(),
});

export type RawEnv = z.input<typeof envSchema>;
export type Env = z.output<typeof envSchema>;

/** A required key that is missing once production defaults apply. */
export type MissingKey = keyof Env;

export interface ConfigResult {
  ok: boolean;
  env?: Env;
  /** Actionable, per-key problems. Empty when `ok` is true. */
  errors: string[];
  /** True when the only problems are keys that dev tolerates but prod does not. */
  missingForProduction: MissingKey[];
}

/**
 * Keys a *deployed* instance must set.
 *
 * Exported so the tests and the build-time check agree on the rule instead of
 * each restating it.
 */
export const PRODUCTION_REQUIRED_KEYS = [
  "NEXT_PUBLIC_CONTRACT_ID",
] as const satisfies readonly MissingKey[];

/**
 * Whether this configuration is a real deployment, as opposed to local
 * exploration.
 *
 * The distinction matters because the app has a documented and supported
 * "mock data" state: with no contract configured, the dashboard falls back to
 * `lib/mock-data.ts` so the UI is still explorable. Requiring a contract id
 * unconditionally would forbid that supported state, and would break a plain
 * `next build` in CI where no environment is set at all.
 *
 * A deployment is identified by an advertised origin -- `NEXT_PUBLIC_SITE_URL`,
 * or the `VERCEL_URL` Vercel injects. If the build claims to be reachable at a
 * published address, it had better name the contract it is talking to; if it
 * names no address, it is not being deployed anywhere and mocks are fine.
 */
export function isDeployment(env: Env): boolean {
  return Boolean(env.NEXT_PUBLIC_SITE_URL ?? env.VERCEL_URL);
}

function formatIssue(path: string, message: string): string {
  return path ? `${path}: ${message}` : message;
}

/**
 * Validate a raw env object.
 *
 * `isProduction` is a parameter rather than a read of `process.env.NODE_ENV` so
 * that the validation itself is a pure function and can be tested against
 * deliberately malformed fixtures without mutating global state.
 */
export function loadConfig(raw: RawEnv, isProduction: boolean): ConfigResult {
  const parsed = envSchema.safeParse(raw ?? {});
  const errors: string[] = [];

  if (!parsed.success) {
    errors.push(...parsed.error.issues.map((i) => formatIssue(i.path.join("."), i.message)));
  }

  // Cross-validation continues even when shape validation failed, so a single
  // run reports every problem rather than forcing a fix-and-rerun cycle per
  // error. The raw values are used as a best effort: a field that already failed
  // shape validation is reported above, and must not also throw here.
  const env = (parsed.success ? parsed.data : (raw ?? {})) as Env;

  // An explicit RPC URL has to agree with the declared network. Pointing
  // futurenet at the testnet RPC is exactly the silent misconfiguration this
  // module exists to prevent, and it is otherwise invisible: the dashboard
  // renders, it just shows the wrong chain's data.
  //
  // `local` is exempt because its endpoint is by definition whatever the
  // developer's local node happens to be.
  const override = env.NEXT_PUBLIC_SOROBAN_RPC_URL;
  const network = isNetworkId(env.NEXT_PUBLIC_NETWORK) ? env.NEXT_PUBLIC_NETWORK : null;
  if (override && network && network !== "local" && isAbsoluteHttpUrl(override)) {
    const host = new URL(override).hostname;
    const expected = new URL(NETWORKS[network].rpcUrl).hostname;
    if (host !== expected) {
      errors.push(
        `NEXT_PUBLIC_SOROBAN_RPC_URL: host "${host}" does not look like the ` +
          `${NETWORKS[network].label} endpoint ("${expected}"). If this build is meant to target ` +
          `${NETWORKS[network].label}, either drop the override so the canonical endpoint is used, ` +
          `or set NEXT_PUBLIC_NETWORK to the network this URL actually serves.`
      );
    }
  }

  const missingForProduction = (
    isProduction && isDeployment(env) ? PRODUCTION_REQUIRED_KEYS : []
  ).filter((k) => !env[k]) as MissingKey[];

  for (const key of missingForProduction) {
    errors.push(
      `${key} is required for a deployed build. This build advertises a public ` +
        `origin, so it must name the contract it reads -- a deployed dashboard with no ` +
        `contract silently renders mock data. Set ${key}, or unset ` +
        `NEXT_PUBLIC_SITE_URL/VERCEL_URL if this is a local mock-data build.`
    );
  }

  // Only hand back an `env` when it is fully valid; a partially-valid object
  // would let a caller use a value the errors already rejected.
  return {
    ok: errors.length === 0,
    env: errors.length === 0 && parsed.success ? env : undefined,
    errors,
    missingForProduction: [...missingForProduction],
  };
}

/** Raised when configuration is invalid, carrying every problem at once. */
export class ConfigError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(
      `Invalid environment configuration:\n${issues.map((i) => `  - ${i}`).join("\n")}\n\n` +
        `See .env.example for the expected variables and values.`
    );
    this.name = "ConfigError";
    this.issues = issues;
  }
}

/**
 * Read and validate `process.env`.
 *
 * Returns validated config, or throws a `ConfigError` listing every problem at
 * once rather than failing on the first -- fixing config one error per CI run is
 * miserable.
 */
export function readConfig(source: NodeJS.ProcessEnv = process.env): Env {
  const isProduction = source.NODE_ENV === "production";
  const result = loadConfig(source as RawEnv, isProduction);

  if (!result.ok || !result.env) {
    throw new ConfigError(result.errors);
  }
  return result.env;
}

/** The effective RPC URL: the explicit override, or the network's canonical one. */
export function resolveRpcUrl(env: Env): string {
  return env.NEXT_PUBLIC_SOROBAN_RPC_URL ?? NETWORKS[env.NEXT_PUBLIC_NETWORK].rpcUrl;
}

/** The configured network's metadata. */
export function resolveNetwork(env: Env) {
  return NETWORKS[env.NEXT_PUBLIC_NETWORK];
}
