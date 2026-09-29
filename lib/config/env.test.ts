import { describe, expect, it } from "vitest";

import {
  ConfigError,
  NETWORKS,
  PRODUCTION_REQUIRED_KEYS,
  isDeployment,
  loadConfig,
  readConfig,
  resolveNetwork,
  resolveRpcUrl,
} from "./env";

/** A syntactically valid `C...` contract id. */
const VALID_CONTRACT = `C${"A".repeat(55)}`;

/**
 * Feeds a deliberately invalid value past the static type.
 *
 * The `Env` type is narrow by design, so the negative tests cannot construct
 * their own inputs without a cast. Doing it here keeps each test readable and
 * makes the escape hatch greppable.
 */
function invalidConfig(values: Record<string, unknown>): Record<string, string> {
  return values as Record<string, string>;
}

describe("loadConfig — valid configurations", () => {
  it("defaults to testnet when nothing is set", () => {
    const result = loadConfig({}, false);

    expect(result.ok).toBe(true);
    expect(result.env?.NEXT_PUBLIC_NETWORK).toBe("testnet");
    expect(result.env?.NEXT_PUBLIC_CONTRACT_ID).toBeUndefined();
  });

  it("accepts a full testnet configuration", () => {
    const result = loadConfig(
      {
        NEXT_PUBLIC_NETWORK: "testnet",
        NEXT_PUBLIC_SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
        NEXT_PUBLIC_CONTRACT_ID: VALID_CONTRACT,
        NEXT_PUBLIC_SITE_URL: "https://synapse.example.com",
      },
      true
    );

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("accepts a futurenet configuration with the futurenet endpoint", () => {
    const result = loadConfig(
      {
        NEXT_PUBLIC_NETWORK: "futurenet",
        NEXT_PUBLIC_SOROBAN_RPC_URL: "https://rpc-futurenet.stellar.org",
        NEXT_PUBLIC_CONTRACT_ID: VALID_CONTRACT,
      },
      true
    );

    expect(result.ok).toBe(true);
    expect(result.env?.NEXT_PUBLIC_NETWORK).toBe("futurenet");
  });

  it("allows a local endpoint for the local network", () => {
    const result = loadConfig(
      { NEXT_PUBLIC_NETWORK: "local", NEXT_PUBLIC_SOROBAN_RPC_URL: "http://localhost:8000" },
      false
    );

    expect(result.ok).toBe(true);
  });

  it("tolerates a non-default port on the canonical host", () => {
    const result = loadConfig(
      {
        NEXT_PUBLIC_NETWORK: "testnet",
        NEXT_PUBLIC_SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org:8443",
      },
      false
    );

    expect(result.ok).toBe(true);
  });
});

describe("loadConfig — deliberately malformed configurations", () => {
  it("rejects a contract id that is not a C-address", () => {
    const result = loadConfig({ NEXT_PUBLIC_CONTRACT_ID: "not-a-contract" }, false);

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/NEXT_PUBLIC_CONTRACT_ID/);
    expect(result.errors.join("\n")).toMatch(/C.*55/);
  });

  it("rejects a G-account where a contract id belongs", () => {
    const result = loadConfig({ NEXT_PUBLIC_CONTRACT_ID: `G${"A".repeat(55)}` }, false);

    expect(result.ok).toBe(false);
  });

  it("names the common trailing-space mistake in the message", () => {
    const result = loadConfig({ NEXT_PUBLIC_CONTRACT_ID: ` ${VALID_CONTRACT} ` }, false);

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/leading or trailing space/);
  });

  it("rejects a relative RPC url", () => {
    const result = loadConfig(
      { NEXT_PUBLIC_SOROBAN_RPC_URL: "soroban-testnet.stellar.org" },
      false
    );

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/absolute http or https URL/);
  });

  it("rejects an empty RPC url", () => {
    const result = loadConfig({ NEXT_PUBLIC_SOROBAN_RPC_URL: "" }, false);

    expect(result.ok).toBe(false);
  });

  it("accepts a plain http url for a local node", () => {
    const result = loadConfig(
      { NEXT_PUBLIC_NETWORK: "local", NEXT_PUBLIC_SOROBAN_RPC_URL: "http://localhost:8000" },
      false
    );

    expect(result.ok).toBe(true);
  });

  it("rejects an unknown network name and lists the valid ones", () => {
    const result = loadConfig(invalidConfig({ NEXT_PUBLIC_NETWORK: "mainnet" }), false);

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/testnet/);
  });

  it("rejects a non-absolute site url", () => {
    const result = loadConfig({ NEXT_PUBLIC_SITE_URL: "synapse.example.com" }, false);

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/NEXT_PUBLIC_SITE_URL/);
  });

  it("reports every problem at once, not just the first", () => {
    const result = loadConfig(
      invalidConfig({
        NEXT_PUBLIC_CONTRACT_ID: "nope",
        NEXT_PUBLIC_SITE_URL: "nope",
        NEXT_PUBLIC_NETWORK: "bogus",
      }),
      false
    );

    expect(result.ok).toBe(false);
    // One issue per bad key, so a single CI run surfaces all of them.
    expect(result.errors.length).toBe(3);
  });

  it("still cross-validates the RPC pairing when a field is malformed", () => {
    // Cross-validation must survive a shape failure, otherwise a developer with
    // both problems fixes one, rebuilds, and only then learns about the other.
    const result = loadConfig(
      invalidConfig({
        NEXT_PUBLIC_CONTRACT_ID: "nope",
        NEXT_PUBLIC_NETWORK: "testnet",
        NEXT_PUBLIC_SOROBAN_RPC_URL: "https://rpc-futurenet.stellar.org",
      }),
      false
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(2);
    expect(result.errors.join("\n")).toMatch(/NEXT_PUBLIC_CONTRACT_ID/);
    expect(result.errors.join("\n")).toMatch(/soroban-testnet\.stellar\.org/);
  });

  it("withholds the env object when validation failed", () => {
    // Handing back a partially-valid env would let a caller read a value the
    // errors already rejected.
    const result = loadConfig({ NEXT_PUBLIC_CONTRACT_ID: "nope" }, false);

    expect(result.ok).toBe(false);
    expect(result.env).toBeUndefined();
  });

  it("does not double-report a bad RPC url as both shape and pairing problems", () => {
    const result = loadConfig(
      { NEXT_PUBLIC_NETWORK: "testnet", NEXT_PUBLIC_SOROBAN_RPC_URL: "not-a-url" },
      false
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/absolute http or https URL/);
  });

  it("does not attempt a pairing check on a non-http scheme", () => {
    // A well-formed but wrong-scheme URL should fail shape validation only. If
    // the pairing check tried to parse it as an endpoint it would either throw
    // or invent a second, misleading error.
    const result = loadConfig(
      {
        NEXT_PUBLIC_NETWORK: "testnet",
        NEXT_PUBLIC_SOROBAN_RPC_URL: "ftp://soroban-testnet.stellar.org",
      },
      false
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
  });

  it("treats a missing env object as an empty one rather than throwing", () => {
    // `process.env` is always an object in practice, but a nullish read should
    // degrade to "nothing configured" instead of a TypeError.
    const result = loadConfig(undefined as unknown as Record<string, string>, false);

    expect(result.ok).toBe(true);
    expect(result.env?.NEXT_PUBLIC_NETWORK).toBe("testnet");
  });
});

describe("loadConfig — network / RPC cross-validation", () => {
  it("rejects a testnet build pointed at the futurenet RPC", () => {
    const result = loadConfig(
      {
        NEXT_PUBLIC_NETWORK: "testnet",
        NEXT_PUBLIC_SOROBAN_RPC_URL: "https://rpc-futurenet.stellar.org",
      },
      false
    );

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/soroban-testnet\.stellar\.org/);
  });

  it("rejects a futurenet build pointed at the testnet RPC", () => {
    const result = loadConfig(
      {
        NEXT_PUBLIC_NETWORK: "futurenet",
        NEXT_PUBLIC_SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
      },
      false
    );

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/rpc-futurenet\.stellar\.org/);
  });

  it("allows any host for the local network", () => {
    const result = loadConfig(
      { NEXT_PUBLIC_NETWORK: "local", NEXT_PUBLIC_SOROBAN_RPC_URL: "https://my-node.example.com" },
      false
    );

    expect(result.ok).toBe(true);
  });
});

describe("loadConfig — production requirements", () => {
  it("allows a missing contract id in development", () => {
    const result = loadConfig({}, false);

    expect(result.ok).toBe(true);
    expect(result.missingForProduction).toEqual([]);
  });

  it("allows a missing contract id in a build that advertises no origin", () => {
    // A plain `next build` in CI sets no environment at all. Mock data is the
    // app's documented, supported fallback, so this must not fail.
    const result = loadConfig({}, true);

    expect(result.ok).toBe(true);
    expect(result.missingForProduction).toEqual([]);
  });

  it("fails a deployed build with no contract id", () => {
    const result = loadConfig({ NEXT_PUBLIC_SITE_URL: "https://synapse.example.com" }, true);

    expect(result.ok).toBe(false);
    expect(result.missingForProduction).toEqual(["NEXT_PUBLIC_CONTRACT_ID"]);
    expect(result.errors.join("\n")).toMatch(/required for a deployed build/);
    expect(result.errors.join("\n")).toMatch(/silently renders mock data/);
  });

  it("treats an injected VERCEL_URL as a deployment too", () => {
    const result = loadConfig({ VERCEL_URL: "synapse-web-abc.vercel.app" }, true);

    expect(result.ok).toBe(false);
    expect(result.missingForProduction).toEqual(["NEXT_PUBLIC_CONTRACT_ID"]);
  });

  it("passes a deployed build with a contract id", () => {
    const result = loadConfig(
      {
        NEXT_PUBLIC_SITE_URL: "https://synapse.example.com",
        NEXT_PUBLIC_CONTRACT_ID: VALID_CONTRACT,
      },
      true
    );

    expect(result.ok).toBe(true);
    expect(result.missingForProduction).toEqual([]);
  });

  it("does not require a contract in development even with a site url", () => {
    const result = loadConfig({ NEXT_PUBLIC_SITE_URL: "https://synapse.example.com" }, false);

    expect(result.ok).toBe(true);
  });

  it("keeps the required-key list and the validator in agreement", () => {
    // If someone adds a key to PRODUCTION_REQUIRED_KEYS, this still holds.
    const result = loadConfig({ NEXT_PUBLIC_SITE_URL: "https://synapse.example.com" }, true);

    expect(result.missingForProduction).toEqual([...PRODUCTION_REQUIRED_KEYS]);
  });
});

describe("isDeployment", () => {
  it("is true when a site url is advertised", () => {
    const env = loadConfig({ NEXT_PUBLIC_SITE_URL: "https://synapse.example.com" }, false).env!;

    expect(isDeployment(env)).toBe(true);
  });

  it("is true when only VERCEL_URL is present", () => {
    const env = loadConfig({ VERCEL_URL: "synapse-web-abc.vercel.app" }, false).env!;

    expect(isDeployment(env)).toBe(true);
  });

  it("is false for a bare configuration", () => {
    expect(isDeployment(loadConfig({}, false).env!)).toBe(false);
  });
});

describe("readConfig", () => {
  it("returns validated config for a valid production env", () => {
    const env = readConfig({
      NODE_ENV: "production",
      NEXT_PUBLIC_CONTRACT_ID: VALID_CONTRACT,
    } as NodeJS.ProcessEnv);

    expect(env.NEXT_PUBLIC_NETWORK).toBe("testnet");
  });

  it("throws a ConfigError naming every problem", () => {
    let thrown: unknown;
    try {
      readConfig({
        NODE_ENV: "production",
        NEXT_PUBLIC_CONTRACT_ID: "nope",
        NEXT_PUBLIC_NETWORK: "bogus",
      } as NodeJS.ProcessEnv);
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(ConfigError);
    const error = thrown as ConfigError;
    expect(error.issues.length).toBe(2);
    expect(error.message).toMatch(/NEXT_PUBLIC_CONTRACT_ID/);
    expect(error.message).toMatch(/\.env\.example/);
  });

  it("does not treat a dev build as production", () => {
    const env = readConfig({ NODE_ENV: "development" } as NodeJS.ProcessEnv);

    expect(env.NEXT_PUBLIC_CONTRACT_ID).toBeUndefined();
  });
});

describe("resolution helpers", () => {
  it("uses the explicit RPC override when present", () => {
    const env = loadConfig(
      {
        NEXT_PUBLIC_NETWORK: "testnet",
        NEXT_PUBLIC_SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
      },
      false
    ).env!;

    expect(resolveRpcUrl(env)).toBe("https://soroban-testnet.stellar.org");
  });

  it("falls back to the network's canonical RPC endpoint", () => {
    const env = loadConfig({ NEXT_PUBLIC_NETWORK: "futurenet" }, false).env!;

    expect(resolveRpcUrl(env)).toBe(NETWORKS.futurenet.rpcUrl);
  });

  it("resolves network metadata including the passphrase", () => {
    const env = loadConfig({ NEXT_PUBLIC_NETWORK: "futurenet" }, false).env!;

    const network = resolveNetwork(env);
    expect(network.id).toBe("futurenet");
    expect(network.passphrase).toMatch(/Future Network/);
    expect(network.explorer).toMatch(/futurenet/);
  });
});
