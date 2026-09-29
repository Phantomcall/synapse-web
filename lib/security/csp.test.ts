import { describe, expect, it } from "vitest";

import nextConfig from "../../next.config";
import { buildCsp, resolveConnectSources, securityHeaders } from "./csp";

/**
 * The policy is asserted here as a value, not as an HTTP response, because a
 * response test would pass whether or not `next.config.ts` actually wires this
 * module in. {@link importTheRealConfig} closes that gap: it reads the
 * `headers()` function Next itself will call.
 */

/** Calls the real config's headers() the way Next does. */
async function importTheRealConfig(env: Record<string, string | undefined>) {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    const result = await nextConfig.headers?.();
    return result ?? [];
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const PRODUCTION = { NODE_ENV: "production" };

function directive(policy: string, name: string): string[] {
  const found = policy
    .split(";")
    .map((part) => part.trim())
    .find((part) => part === name || part.startsWith(`${name} `));
  if (found === undefined) throw new Error(`directive ${name} is missing`);
  return found === name ? [] : found.slice(name.length).trim().split(/\s+/);
}

describe("connect-src", () => {
  it("defaults to the testnet RPC the app is pointed at", () => {
    expect(resolveConnectSources(PRODUCTION).sources).toEqual([
      "'self'",
      "https://soroban-testnet.stellar.org",
    ]);
  });

  it("follows NEXT_PUBLIC_SOROBAN_RPC_URL to whatever host it names", () => {
    const { sources } = resolveConnectSources({
      ...PRODUCTION,
      NEXT_PUBLIC_SOROBAN_RPC_URL: "https://rpc.example.com/soroban",
    });

    expect(sources).toEqual(["'self'", "https://rpc.example.com"]);
  });

  it("adds operator-allowlisted origins for custom endpoints", () => {
    const { sources } = resolveConnectSources({
      ...PRODUCTION,
      NEXT_PUBLIC_SOROBAN_RPC_URL: "https://rpc.example.com",
      NEXT_PUBLIC_CSP_CONNECT_SRC: "https://horizon.example.com, https://backup.example.com",
    });

    expect(sources).toEqual([
      "'self'",
      "https://backup.example.com",
      "https://horizon.example.com",
      "https://rpc.example.com",
    ]);
  });

  it("keeps the runtime-endpoint escape hatch to https, never *", () => {
    const { sources } = resolveConnectSources({
      ...PRODUCTION,
      NEXT_PUBLIC_CSP_ALLOW_ANY_HTTPS: "1",
    });

    expect(sources).toEqual(["'self'", "https:"]);
    expect(sources).not.toContain("*");
  });

  it("rejects a wildcard allowlist rather than shipping one", () => {
    expect(() =>
      resolveConnectSources({ ...PRODUCTION, NEXT_PUBLIC_CSP_CONNECT_SRC: "*" })
    ).toThrow(/must not contain "\*"/);
  });

  it("rejects a non-absolute allowlist entry", () => {
    expect(() =>
      resolveConnectSources({ ...PRODUCTION, NEXT_PUBLIC_CSP_CONNECT_SRC: "rpc.example.com" })
    ).toThrow(/not an absolute URL/);
  });

  it("rejects a non-http scheme in the allowlist", () => {
    expect(() =>
      resolveConnectSources({ ...PRODUCTION, NEXT_PUBLIC_CSP_CONNECT_SRC: "wss://rpc.example.com" })
    ).toThrow(/only http and https origins/);
  });

  it("rejects a non-http RPC URL", () => {
    expect(() =>
      resolveConnectSources({ ...PRODUCTION, NEXT_PUBLIC_SOROBAN_RPC_URL: "javascript:alert(1)" })
    ).toThrow();
  });

  it("adds the dev HMR websocket only outside production", () => {
    const dev = resolveConnectSources({ NODE_ENV: "development" }).sources;

    expect(dev).toContain("ws:");
    expect(dev).toContain("wss:");
    expect(resolveConnectSources(PRODUCTION).sources).not.toContain("ws:");
  });

  it("is stable across builds so the header is byte-identical", () => {
    const env = {
      ...PRODUCTION,
      NEXT_PUBLIC_CSP_CONNECT_SRC: "https://b.example.com https://a.example.com",
    };

    expect(buildCsp(env)).toBe(buildCsp(env));
    // Sorted, deduplicated, and the unset RPC's default is still reachable
    // because the app will still call it.
    expect(resolveConnectSources(env).sources).toEqual([
      "'self'",
      "https://a.example.com",
      "https://b.example.com",
      "https://soroban-testnet.stellar.org",
    ]);
  });
});

describe("the policy itself", () => {
  const policy = buildCsp(PRODUCTION);

  it("locks down the directives an XSS payload reaches for", () => {
    expect(directive(policy, "default-src")).toEqual(["'self'"]);
    expect(directive(policy, "object-src")).toEqual(["'none'"]);
    expect(directive(policy, "frame-src")).toEqual(["'none'"]);
    expect(directive(policy, "frame-ancestors")).toEqual(["'none'"]);
    expect(directive(policy, "base-uri")).toEqual(["'self'"]);
    expect(directive(policy, "form-action")).toEqual(["'self'"]);
    expect(directive(policy, "script-src-attr")).toEqual(["'none'"]);
    expect(directive(policy, "font-src")).toEqual(["'self'"]);
  });

  it("never allows remote script or style sources", () => {
    for (const name of ["script-src", "style-src", "default-src"]) {
      for (const source of directive(policy, name)) {
        expect(source, `${name} allows ${source}`).not.toMatch(/^(https?:|data:|blob:|\*)/);
      }
    }
  });

  it("does not allow unsafe-eval anywhere", () => {
    expect(policy).not.toContain("unsafe-eval");
  });

  it("documents the two inline exceptions it keeps, rather than leaving them implicit", () => {
    // These are the deliberate, documented relaxations. If a future build makes
    // one unnecessary, this test is the reminder to remove it.
    expect(directive(policy, "script-src")).toEqual(["'self'", "'unsafe-inline'"]);
    expect(directive(policy, "style-src")).toEqual(["'self'", "'unsafe-inline'"]);
  });

  it("leaves upgrade-insecure-requests out", () => {
    // It was tried and failed in WebKit, which also upgrades same-origin
    // subresources on a plain-HTTP page and thus breaks `next start` previews.
    expect(policy).not.toContain("upgrade-insecure-requests");
    expect(buildCsp({ NODE_ENV: "development" })).not.toContain("upgrade-insecure-requests");
  });
});

describe("securityHeaders", () => {
  it("returns the supporting headers the issue asks for", () => {
    const headers = Object.fromEntries(securityHeaders(PRODUCTION).map((h) => [h.key, h.value]));

    expect(headers["X-Frame-Options"]).toBe("DENY");
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["Permissions-Policy"]).toContain("camera=()");
    expect(headers["Permissions-Policy"]).toContain("geolocation=()");
    expect(headers["Content-Security-Policy"]).toContain("default-src 'self'");
  });

  it("does not pin subdomains to https", () => {
    const headers = Object.fromEntries(securityHeaders(PRODUCTION).map((h) => [h.key, h.value]));

    expect(headers["Strict-Transport-Security"]).toBe("max-age=31536000");
    expect(headers["Strict-Transport-Security"]).not.toContain("includeSubDomains");
  });

  it("leaves HSTS out of development, where it is meaningless", () => {
    const keys = securityHeaders({ NODE_ENV: "development" }).map((h) => h.key);

    expect(keys).not.toContain("Strict-Transport-Security");
  });
});

describe("next.config.ts", () => {
  it("applies the headers to every route", async () => {
    const routes = await importTheRealConfig({ NODE_ENV: "production" });

    expect(routes).toHaveLength(1);
    expect(routes[0]?.source).toBe("/:path*");
  });

  it("emits the real header set, not just a declaration of intent", async () => {
    const [route] = await importTheRealConfig({
      NODE_ENV: "production",
      NEXT_PUBLIC_SOROBAN_RPC_URL: "https://rpc.example.com",
    });
    const headers = Object.fromEntries(
      (route?.headers ?? []).map((h) => [h.key, h.value as string])
    );

    expect(Object.keys(headers).sort()).toEqual([
      "Content-Security-Policy",
      "Permissions-Policy",
      "Referrer-Policy",
      "Strict-Transport-Security",
      "X-Content-Type-Options",
      "X-Frame-Options",
    ]);
    expect(headers["Content-Security-Policy"]).toContain(
      "connect-src 'self' https://rpc.example.com"
    );
  });

  it("reads the environment at call time, not at module load", async () => {
    const [first] = await importTheRealConfig({ NODE_ENV: "production" });
    const [second] = await importTheRealConfig({
      NODE_ENV: "production",
      NEXT_PUBLIC_SOROBAN_RPC_URL: "https://later.example.com",
    });

    const value = (route: typeof first) =>
      route?.headers?.find((h) => h.key === "Content-Security-Policy")?.value;

    expect(value(first)).toContain("https://soroban-testnet.stellar.org");
    expect(value(second)).toContain("https://later.example.com");
  });
});
