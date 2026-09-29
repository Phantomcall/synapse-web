/**
 * The Content-Security-Policy and supporting headers for the deployed app.
 *
 * This module is deliberately pure: it takes an environment-shaped record and
 * returns header values, so the policy can be asserted in a test without
 * booting Next. `next.config.ts` is the only place that reads `process.env`.
 *
 * ## Why some `'unsafe-inline'` has to stay
 *
 * Two exceptions are unavoidable in the current build, and both are recorded
 * here rather than left as a silent weakening of the policy:
 *
 * 1. `script-src 'unsafe-inline'` — Next.js emits an inline bootstrap script
 *    for hydration and the RSC payload. Removing it means a per-request nonce,
 *    which forces the whole app from static rendering to dynamic. The app is
 *    currently 8 static routes with no server runtime; trading that away is a
 *    larger change than this hardening pass, and it needs a real decision
 *    about hosting rather than a header. What is *not* relaxed: `script-src`
 *    still has no `https:` wildcard and no `'unsafe-eval'`, so an injected
 *    inline script is the only remaining gap, and `script-src-attr 'none'`
 *    removes inline event handlers entirely.
 * 2. `style-src 'unsafe-inline'` — the UI is built with React inline
 *    `style={{...}}` props throughout (`components/Shell.tsx` and every
 *    component it renders). There is no stylesheet to hash, because the styles
 *    that matter are not in any stylesheet.
 *
 * `connect-src` is where the real design decision lives. See
 * {@link resolveConnectSources}.
 *
 * `upgrade-insecure-requests` is deliberately absent. It was tried and removed:
 * in WebKit it also upgrades *same-origin* subresources on a plain-HTTP page,
 * which breaks localhost previews in `next start`. This app has no HTTP
 * dependencies at all (every asset and every RPC endpoint is https or
 * same-origin), so the directive's upgrade value is already provided by the
 * content of the page itself and the cost of an engine quirk is not worth it.
 */

/** The RPC the app uses when `NEXT_PUBLIC_SOROBAN_RPC_URL` is unset. */
export const DEFAULT_RPC_URL = "https://soroban-testnet.stellar.org";

/** Origins that must be reachable for the app to function at all. */
const REQUIRED_STATIC_ORIGINS = ["'self'"] as const;

export interface CspEnvironment {
  NODE_ENV?: string;
  /** The RPC the app is pointed at. See lib/soroban/*. */
  NEXT_PUBLIC_SOROBAN_RPC_URL?: string;
  /**
   * Extra origins for `connect-src`, comma- or space-separated. This is how an
   * operator allowlists a custom RPC endpoint or a Horizon server.
   */
  NEXT_PUBLIC_CSP_CONNECT_SRC?: string;
  /**
   * Opt-in escape hatch for deployments where the RPC endpoint is chosen at
   * runtime by the user, which no static header can know in advance. Setting
   * this to "1" replaces the allowlist with `https:`, which is still far
   * narrower than `*`: no plaintext HTTP, no `ws:`, no `data:`, and no way for
   * an injected script to load remote code.
   */
  NEXT_PUBLIC_CSP_ALLOW_ANY_HTTPS?: string;
}

export interface ResolvedConnectSources {
  /** The directive's source list, ready to join. */
  sources: string[];
  /** Human-readable note for logs and the PR description. */
  explanation: string;
}

function isTruthy(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Reduces a URL to an origin, rejecting anything that is not one.
 *
 * A header is a build artifact: a typo in an allowlist entry has to fail the
 * build rather than produce a policy that silently blocks the RPC and presents
 * as "the app is broken".
 */
function toOrigin(value: string, envName: string): string {
  if (value === "*") {
    throw new Error(
      `${envName} must not contain "*". A wildcard source cannot be audited, and ` +
        `the point of this policy is that the reachable set is enumerable. Use ` +
        `NEXT_PUBLIC_CSP_ALLOW_ANY_HTTPS=1 if the endpoint genuinely cannot be known at build time.`
    );
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${envName} contains "${value}", which is not an absolute URL.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(
      `${envName} contains "${value}": only http and https origins are allowed in a CSP, ` +
        `not "${url.protocol}".`
    );
  }
  return url.origin;
}

/**
 * Builds the `connect-src` source list.
 *
 * The app's only outbound request is to the Soroban RPC
 * (`NEXT_PUBLIC_SOROBAN_RPC_URL`, or the testnet default), plus same-origin
 * traffic for Next's own chunks, RSC payloads, and the HMR socket in dev.
 * Wallet extensions do not appear here: Freighter and xBull are reached
 * through `window.postMessage` and extension-injected APIs, not `fetch`, so no
 * extension origin is connectable from the page. That is the single most
 * important thing to get right in this policy — a wallet origin in
 * `connect-src` would be an XSS exfiltration target.
 */
export function resolveConnectSources(env: CspEnvironment): ResolvedConnectSources {
  if (isTruthy(env.NEXT_PUBLIC_CSP_ALLOW_ANY_HTTPS)) {
    return {
      sources: ["'self'", "https:"],
      explanation:
        "NEXT_PUBLIC_CSP_ALLOW_ANY_HTTPS is set: any https origin is connectable because the " +
        "RPC endpoint is chosen at runtime. No plaintext http, ws, or data source is allowed.",
    };
  }

  const sources = new Set<string>(REQUIRED_STATIC_ORIGINS);
  const reasons: string[] = [];

  if (env.NEXT_PUBLIC_SOROBAN_RPC_URL) {
    sources.add(toOrigin(env.NEXT_PUBLIC_SOROBAN_RPC_URL, "NEXT_PUBLIC_SOROBAN_RPC_URL"));
    reasons.push("NEXT_PUBLIC_SOROBAN_RPC_URL");
  } else {
    sources.add(new URL(DEFAULT_RPC_URL).origin);
    reasons.push(`the default RPC (${DEFAULT_RPC_URL})`);
  }

  const extra = splitList(env.NEXT_PUBLIC_CSP_CONNECT_SRC);
  for (const entry of extra) {
    sources.add(toOrigin(entry, "NEXT_PUBLIC_CSP_CONNECT_SRC"));
  }
  if (extra.length > 0) reasons.push("NEXT_PUBLIC_CSP_CONNECT_SRC");

  if (env.NODE_ENV !== "production") {
    // `next dev` opens a WebSocket to its own origin for hot reloading. Browsers
    // disagree about whether 'self' covers ws:, so development needs the scheme
    // spelled out. Production never gets this.
    sources.add("ws:");
    sources.add("wss:");
  }

  return {
    // Sorted so the header is byte-identical across builds; an unstable header
    // makes cache and diff behaviour impossible to reason about.
    sources: [...sources].sort(),
    explanation: `connect-src is derived from ${reasons.join(", ")}.`,
  };
}

/**
 * Assembles the policy.
 *
 * Directive order is fixed and stable, and each entry is a single space, which
 * is what browsers expect; the joined string is asserted directly in tests.
 */
export function buildCsp(env: CspEnvironment): string {
  const { sources } = resolveConnectSources(env);

  const directives: [string, string[]][] = [
    ["default-src", ["'self'"]],
    ["base-uri", ["'self'"]],
    ["object-src", ["'none'"]],
    ["script-src", ["'self'", "'unsafe-inline'"]],
    // React never uses inline event handlers; this is free protection.
    ["script-src-attr", ["'none'"]],
    ["style-src", ["'self'", "'unsafe-inline'"]],
    // Icons are served from this origin; data: is for the inline SVG data URIs
    // in globals.css, blob: for object URLs a future export feature may create.
    ["img-src", ["'self'", "data:", "blob:"]],
    ["font-src", ["'self'"]],
    ["connect-src", sources],
    // No frame is ever legitimate here, and frame-ancestors plus
    // X-Frame-Options stop this app being framed for clickjacking.
    ["frame-src", ["'none'"]],
    ["frame-ancestors", ["'none'"]],
    ["worker-src", ["'self'"]],
    ["manifest-src", ["'self'"]],
    ["form-action", ["'self'"]],
  ];

  return directives
    .map(([name, values]) => (values.length === 0 ? name : `${name} ${values.join(" ")}`))
    .join("; ");
}

export interface Header {
  key: string;
  value: string;
}

/**
 * The full header set applied to every route.
 *
 * `Strict-Transport-Security` is scoped to this host only — no
 * `includeSubDomains`, because a dashboard that is deployed on a shared parent
 * domain must not be able to pin its siblings to https.
 */
export function securityHeaders(env: CspEnvironment): Header[] {
  const headers: Header[] = [
    { key: "Content-Security-Policy", value: buildCsp(env) },
    // Legacy of frame-ancestors, still honoured by older browsers.
    { key: "X-Frame-Options", value: "DENY" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    {
      key: "Permissions-Policy",
      // The app uses none of these. Naming them is what makes the policy
      // meaningful: an absent feature is a silent default, not a decision.
      value: [
        "accelerometer=()",
        "camera=()",
        "display-capture=()",
        "geolocation=()",
        "gyroscope=()",
        "magnetometer=()",
        "microphone=()",
        "payment=()",
        "usb=()",
      ].join(", "),
    },
  ];

  if (env.NODE_ENV === "production") {
    headers.push({
      key: "Strict-Transport-Security",
      value: "max-age=31536000",
    });
  }

  return headers;
}
