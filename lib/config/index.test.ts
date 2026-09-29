import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests for the resolved-config singleton.
 *
 * `lib/config/index.ts` resolves `process.env` once, at import time, and
 * memoises the result. That makes it awkward to test with a static import --
 * the module would be evaluated before the test could set the environment. Each
 * test therefore resets the module registry and imports it dynamically with
 * the environment it wants.
 */

const VALID_CONTRACT = `C${"A".repeat(55)}`;
const ORIGINAL_ENV = { ...process.env };

/** Imports a fresh copy of the module with `overrides` applied to the env. */
async function loadAppConfig(overrides: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  vi.resetModules();
  return import("./index");
}

const CONFIG_KEYS = [
  "NEXT_PUBLIC_NETWORK",
  "NEXT_PUBLIC_SOROBAN_RPC_URL",
  "NEXT_PUBLIC_CONTRACT_ID",
  "NEXT_PUBLIC_SITE_URL",
  "VERCEL_URL",
] as const;

beforeEach(() => {
  // Start every test from a clean slate: a value inherited from the ambient
  // environment would silently change which branch is under test.
  for (const key of CONFIG_KEYS) {
    delete process.env[key];
  }
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("appConfig", () => {
  it("resolves the canonical RPC endpoint for the default network", async () => {
    const { appConfig } = await loadAppConfig({});

    expect(appConfig.network.id).toBe("testnet");
    expect(appConfig.rpcUrl).toBe("https://soroban-testnet.stellar.org");
  });

  it("uses the futurenet endpoint when that network is selected", async () => {
    const { appConfig } = await loadAppConfig({ NEXT_PUBLIC_NETWORK: "futurenet" });

    expect(appConfig.network.id).toBe("futurenet");
    expect(appConfig.rpcUrl).toBe("https://rpc-futurenet.stellar.org");
    expect(appConfig.network.passphrase).toMatch(/Future Network/);
  });

  it("exposes the contract id and explorer for the target network", async () => {
    const { appConfig } = await loadAppConfig({
      NEXT_PUBLIC_NETWORK: "futurenet",
      NEXT_PUBLIC_CONTRACT_ID: VALID_CONTRACT,
    });

    expect(appConfig.contractId).toBe(VALID_CONTRACT);
    expect(appConfig.network.explorer).toContain("futurenet");
  });

  it("reports no contract for a mock-data build", async () => {
    const { appConfig } = await loadAppConfig({});

    expect(appConfig.contractId).toBeUndefined();
  });

  it("prefers an explicit RPC override over the network default", async () => {
    const { appConfig } = await loadAppConfig({
      NEXT_PUBLIC_NETWORK: "testnet",
      NEXT_PUBLIC_SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org:8443",
    });

    expect(appConfig.rpcUrl).toBe("https://soroban-testnet.stellar.org:8443");
  });

  it("builds the site url from NEXT_PUBLIC_SITE_URL", async () => {
    const { appConfig } = await loadAppConfig({
      NEXT_PUBLIC_SITE_URL: "https://synapse.example.com",
      NEXT_PUBLIC_CONTRACT_ID: VALID_CONTRACT,
    });

    expect(appConfig.siteUrl).toBe("https://synapse.example.com");
  });

  it("derives an https site url from a bare VERCEL_URL", async () => {
    const { appConfig } = await loadAppConfig({
      VERCEL_URL: "synapse-web-abc.vercel.app",
      NEXT_PUBLIC_CONTRACT_ID: VALID_CONTRACT,
    });

    // VERCEL_URL has no scheme; the app needs an absolute origin for metadata.
    expect(appConfig.siteUrl).toBe("https://synapse-web-abc.vercel.app");
  });

  it("prefers NEXT_PUBLIC_SITE_URL when both origins are set", async () => {
    const { appConfig } = await loadAppConfig({
      NEXT_PUBLIC_SITE_URL: "https://custom.example.com",
      VERCEL_URL: "synapse-web-abc.vercel.app",
      NEXT_PUBLIC_CONTRACT_ID: VALID_CONTRACT,
    });

    expect(appConfig.siteUrl).toBe("https://custom.example.com");
  });

  it("exposes the validated env object", async () => {
    const { appConfig } = await loadAppConfig({ NEXT_PUBLIC_NETWORK: "futurenet" });

    expect(appConfig.env.NEXT_PUBLIC_NETWORK).toBe("futurenet");
  });
});

describe("getAppConfig memoization", () => {
  it("returns the same instance on repeated calls", async () => {
    const { getAppConfig } = await loadAppConfig({});

    expect(getAppConfig()).toBe(getAppConfig());
  });

  it("does not re-read the environment after the first resolution", async () => {
    const { appConfig, getAppConfig } = await loadAppConfig({ NEXT_PUBLIC_NETWORK: "testnet" });

    // Mutating the environment after resolution must not change the answer --
    // that is the point of caching, and a regression here would mean the config
    // is read at an unpredictable point in the app's life.
    process.env.NEXT_PUBLIC_NETWORK = "futurenet";

    expect(getAppConfig()).toBe(appConfig);
    expect(getAppConfig().network.id).toBe("testnet");
  });
});

describe("configuration errors", () => {
  // `ConfigError` has to be pulled from the same module registry instance that
  // the freshly-imported `index.ts` closed over. A statically-imported copy
  // would be a *different* class object, because `vi.resetModules()` discards
  // the registry between tests, and `instanceof` would then be false against a
  // genuine ConfigError.
  async function captureError(overrides: Record<string, string | undefined>) {
    const error = await loadAppConfig(overrides).catch((e) => e);
    const { ConfigError } = await import("./env");
    return { error, ConfigError, asConfigError: error as InstanceType<typeof ConfigError> };
  }

  it("throws a ConfigError listing every problem when imported", async () => {
    const { error, ConfigError } = await captureError({
      NEXT_PUBLIC_NETWORK: "testnet",
      NEXT_PUBLIC_SOROBAN_RPC_URL: "https://rpc-futurenet.stellar.org",
      NEXT_PUBLIC_CONTRACT_ID: "not-a-contract",
    });

    expect(error).toBeInstanceOf(ConfigError);
  });

  it("reports both problems in a single throw rather than only the first", async () => {
    const { error, ConfigError, asConfigError } = await captureError({
      NEXT_PUBLIC_NETWORK: "testnet",
      NEXT_PUBLIC_SOROBAN_RPC_URL: "https://rpc-futurenet.stellar.org",
      NEXT_PUBLIC_CONTRACT_ID: "not-a-contract",
    });

    expect(error).toBeInstanceOf(ConfigError);
    // One bad RPC/Network pairing plus one bad contract id.
    expect(asConfigError.issues).toHaveLength(2);
  });

  it("names the offending key in the thrown message", async () => {
    const { error, ConfigError, asConfigError } = await captureError({
      NEXT_PUBLIC_CONTRACT_ID: "not-a-contract",
    });

    expect(error).toBeInstanceOf(ConfigError);
    expect(asConfigError.message).toContain("NEXT_PUBLIC_CONTRACT_ID");
    expect(asConfigError.issues.length).toBeGreaterThan(0);
  });
});

describe("re-exports", () => {
  it("re-exports the validation API from the package entry point", async () => {
    const mod = await loadAppConfig({});

    // The call sites import from "@/lib/config", so the surface the app relies
    // on has to be verified here rather than assumed.
    expect(typeof mod.loadConfig).toBe("function");
    expect(typeof mod.readConfig).toBe("function");
    expect(typeof mod.resolveNetwork).toBe("function");
    expect(typeof mod.resolveRpcUrl).toBe("function");
    expect(mod.NETWORKS).toHaveProperty("testnet");
    expect(mod.NETWORKS).toHaveProperty("futurenet");
    expect(mod.NETWORKS).toHaveProperty("local");
  });
});
