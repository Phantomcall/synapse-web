import { describe, expect, it } from "vitest";

import {
  classifyOrigin,
  getCanonicalOrigins,
  parseOrigins,
  WALLET_DOMAIN_BINDING_DOCS,
} from "./origin";

const GENUINE = "https://synapse.example.com";
const env = { NEXT_PUBLIC_SITE_URL: GENUINE };
const loc = (origin: string) => {
  const url = new URL(origin);
  return { origin, hostname: url.hostname };
};

describe("getCanonicalOrigins", () => {
  it("derives origins from every source, deduplicated", () => {
    expect(
      getCanonicalOrigins({
        NEXT_PUBLIC_SITE_URL: "https://synapse.example.com",
        VERCEL_URL: "synapse-web-abc.vercel.app",
        NEXT_PUBLIC_CANONICAL_ORIGINS: "https://synapse.example.com, https://alt.example.com",
      })
    ).toEqual([
      "https://synapse.example.com",
      "https://synapse-web-abc.vercel.app",
      "https://alt.example.com",
    ]);
  });

  it("accepts a scheme-less hostname on its own", () => {
    expect(getCanonicalOrigins({ NEXT_PUBLIC_CANONICAL_ORIGINS: "synapse.example.com" })).toEqual([
      "https://synapse.example.com",
    ]);
  });

  it("drops junk rather than poisoning the allowlist", () => {
    expect(
      getCanonicalOrigins({
        NEXT_PUBLIC_SITE_URL: "https://synapse.example.com",
        NEXT_PUBLIC_CANONICAL_ORIGINS: "not a url, javascript:alert(1), wss://x.example.com",
      })
    ).toEqual(["https://synapse.example.com"]);
  });

  it("preserves scheme and port so comparison is exact", () => {
    expect(getCanonicalOrigins({ NEXT_PUBLIC_SITE_URL: "http://localhost:3000" })).toEqual([
      "http://localhost:3000",
    ]);
  });
});

describe("classifyOrigin", () => {
  it("marks the allowlisted origin genuine", () => {
    const state = classifyOrigin(loc(GENUINE), false, env);

    expect(state.classification).toBe("genuine");
    expect(state.framed).toBe(false);
    expect(state.isHttps).toBe(true);
  });

  it("treats a port difference as a different origin", () => {
    const state = classifyOrigin(loc("https://synapse.example.com:8443"), false, env);

    expect(state.classification).toBe("unknown");
  });

  it("treats a scheme difference as a different origin", () => {
    const state = classifyOrigin(loc("http://synapse.example.com"), false, env);

    expect(state.classification).toBe("unknown");
  });

  it("treats www as a different origin, not a friendly alias", () => {
    const state = classifyOrigin(loc("https://www.synapse.example.com"), false, env);

    expect(state.classification).toBe("unknown");
  });

  it("classifies a clone host on a typo domain as unknown", () => {
    const state = classifyOrigin(loc("https://synapse-exampe.com"), false, env);

    expect(state.classification).toBe("unknown");
    expect(state.allowedOrigins).toEqual([GENUINE]);
  });

  it("classifies localhost as dev, never genuine", () => {
    expect(classifyOrigin(loc("http://localhost:3000"), false, env).classification).toBe("dev");
    expect(classifyOrigin(loc("http://127.0.0.1:3000"), false, env).classification).toBe("dev");
  });

  it("does not let the allowlist promote a local origin to genuine", () => {
    // A local server is trivially impersonable, so an allowlist entry must not
    // mint a green "genuine" badge for localhost -- otherwise running a local
    // site is enough to advertise a trusted origin.
    const allowlisted = classifyOrigin(loc("http://localhost:3000"), false, {
      NEXT_PUBLIC_CANONICAL_ORIGINS: "http://localhost:3000",
    });

    expect(allowlisted.classification).toBe("dev");
    // It is still reported as present in the allowlist, so the mismatch is
    // visible rather than silently swallowed.
    expect(allowlisted.allowedOrigins).toEqual(["http://localhost:3000"]);
  });

  it("reports https as unknown rather than throwing on an opaque origin", () => {
    // A sandboxed iframe (no allow-same-origin) reports location.origin as the
    // literal string "null", and `new URL("null")` throws. This is the framed
    // case we most need to describe, so it must not blow up.
    const opaque = classifyOrigin({ origin: "null", hostname: "" }, true, env);

    expect(opaque.classification).toBe("framed");
    expect(opaque.isHttps).toBeNull();
    expect(opaque.origin).toBe("null");
  });

  it("reports unknown tls state for an unparsable origin", () => {
    expect(
      classifyOrigin({ origin: "not a url", hostname: "x.example.com" }, false, env).isHttps
    ).toBeNull();
  });

  it("frames override everything, including a genuine origin", () => {
    const state = classifyOrigin(loc(GENUINE), true, env);

    expect(state.classification).toBe("framed");
    expect(state.framed).toBe(true);
    expect(state.origin).toBe(GENUINE); // the attacker sees this origin too
  });

  it("leaves allowlist unset and non-local hosts unknown", () => {
    const state = classifyOrigin(loc("https://unknown-staging.example.com"), false, {});

    expect(state.classification).toBe("unknown");
    expect(state.allowedOrigins).toEqual([]);
  });

  it("reports tls state honestly", () => {
    expect(classifyOrigin(loc("http://synapse.example.com"), false, env).isHttps).toBe(false);
    expect(classifyOrigin(loc("https://synapse.example.com"), false, env).isHttps).toBe(true);
  });
});

describe("wallet domain-binding docs", () => {
  it("points to the extensions' own protections, which are out of repo scope", () => {
    expect(WALLET_DOMAIN_BINDING_DOCS.freighter).toMatch(/^https:\/\//);
    expect(WALLET_DOMAIN_BINDING_DOCS.xbull).toMatch(/^https:\/\//);
    expect(parseOrigins([WALLET_DOMAIN_BINDING_DOCS.xbull])[0]).toBe("https://xbull.app");
  });
});
