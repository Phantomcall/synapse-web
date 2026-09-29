/**
 * Anti-phishing origin verification for the wallet connect and sign flows.
 *
 * The genuine dashboard has exactly one identity worth trusting: its own
 * origin. Everything else — a typo'd clone, a SINP block along a compromised
 * CDN, a fork the user was tricked into — is only distinguishable by the
 * origin in the address bar. This module makes that distinction explicit,
 * legible, and hard to spoof, and returns enough data for the UI to render a
 * badge that cannot be borrowed by a malicious page.
 *
 * The badge's truth, not its appearance, is the protection: the classification
 * derives from `window.location.origin` compared against an explicit allowlist
 * of origins the operator has published. A clone at a different host is
 * *unknown*, not "genuine-ish".
 *
 * ## The iframe question
 *
 * `parents` and `opener` mean the effective origin of the page the user is
 * interacting with can differ from `location.origin`:
 *
 * - a dashboard framed inside an attacker page still shows the dashboard's own
 *   location.origin, so a "genuine" badge would be trivially spoofed;
 * - issue #177's sibling (#176) ships `frame-ancestors 'none'` +
 *   `X-Frame-Options: DENY`, which is the actual defense here, but the badge
 *   still renders an `EMBEDDED` state when framing is detected, so if the
 *   headers are ever missing, the UI is still loud about it.
 *
 * `window.opener` is deliberately ignored: setting `noopener`/`noreferrer` is
 * the correct response and we do not want to flag legitimate
 * window.open-style flows that use it.
 */

export type OriginClassification = "genuine" | "dev" | "unknown" | "framed";

export interface OriginState {
  /** Bare `location.origin` of the running document. */
  origin: string;
  /** Host without port, for uncluttered display. */
  hostname: string;
  /** True over TLS, false over plain HTTP, null if unavailable. */
  isHttps: boolean | null;
  classification: OriginClassification;
  /** Detected framing (`window.top !== window.self`). */
  framed: boolean;
  /** The allowlist the current origin was compared against. */
  allowedOrigins: string[];
}

export interface OriginEnvironment {
  /** The app's address as the operator published it. */
  NEXT_PUBLIC_SITE_URL?: string;
  /** Next/Vercel inlines this during deployment. */
  VERCEL_URL?: string;
  /** Explicit allowlist, comma- or space-separated, e.g. for a custom domain. */
  NEXT_PUBLIC_CANONICAL_ORIGINS?: string;
}

/** Hosts that count as local development, where signing is never financially real. */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

function isLocalHost(hostname: string): boolean {
  return LOCAL_HOSTS.has(hostname.toLowerCase()) || hostname.toLowerCase().endsWith(".localhost");
}

/**
 * A plausible public hostname: at least one label, at least one dot, only
 * DNS-safe characters. Rejects single words ("not", "a", "url") that a
 * space-separated typo would otherwise silently turn into "https://not".
 */
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

function isPlausibleHost(hostname: string): boolean {
  return HOSTNAME_RE.test(hostname) || isLocalHost(hostname);
}

/** Reduces each known-URL env value to a bare origin, ignoring anything unparsable. */
export function parseOrigins(values: (string | undefined)[]): string[] {
  const origins = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    for (const entry of value.split(/[\s,]+/)) {
      if (!entry) continue;

      let url: URL;
      if (entry.includes("://")) {
        try {
          url = new URL(entry);
        } catch {
          continue;
        }
        if (url.protocol !== "https:" && url.protocol !== "http:") continue;
      } else {
        // Scheme-less value: a bare domain is fine, anything else is a typo.
        if (!isPlausibleHost(entry)) continue;
        url = new URL(`https://${entry}`);
      }

      if (!isPlausibleHost(url.hostname)) continue;
      origins.add(url.origin);
    }
  }
  return [...origins];
}

/**
 * The set of origins the dashboard is published under. `VERCEL_URL` is the
 * generated deployment URL, which is legitimately "this app" while it lives on
 * Vercel's infrastructure; the operator's own domain is expressed through
 * `NEXT_PUBLIC_SITE_URL` and/or `NEXT_PUBLIC_CANONICAL_ORIGINS`.
 */
export function getCanonicalOrigins(env: OriginEnvironment): string[] {
  return parseOrigins([
    env.NEXT_PUBLIC_SITE_URL,
    env.VERCEL_URL,
    env.NEXT_PUBLIC_CANONICAL_ORIGINS,
  ]);
}

/**
 * Classifies the running document.
 *
 * Order matters: framing overrides everything (its whole point is that the
 * visible origin is not the trusted origin), and a known allowlist hit makes
 * the badge green only for exactly that origin — scheme and port included.
 */
/**
 * TLS state of an origin string, tolerating origins that cannot be parsed.
 *
 * A sandboxed iframe (no `allow-same-origin`) reports `location.origin` as the
 * literal string `"null"` — an opaque origin — and `new URL("null")` throws.
 * That is precisely the framed case we most need to report, so parsing is
 * guarded and an unparsable origin is `null` ("unknown") rather than a throw.
 */
function httpsStateOf(origin: string): boolean | null {
  let protocol: string;
  try {
    protocol = new URL(origin).protocol;
  } catch {
    return null;
  }
  if (protocol === "https:") return true;
  if (protocol === "http:") return false;
  return null;
}

export function classifyOrigin(
  locationLike: Pick<Location, "origin" | "hostname">,
  framed: boolean,
  env: OriginEnvironment
): OriginState {
  const origin = locationLike.origin;
  const hostname = locationLike.hostname;
  const allowedOrigins = getCanonicalOrigins(env);

  let classification: OriginClassification;
  if (framed) classification = "framed";
  // A local origin is `dev` even when the allowlist contains it. Anything
  // reachable on localhost/plain-HTTP is trivially impersonable, so the
  // allowlist must not be able to mint a green "genuine" badge for it —
  // otherwise anyone who can run a local server can advertise a trusted
  // origin. `dev` is checked before `allowedOrigins` for that reason.
  else if (isLocalHost(hostname)) classification = "dev";
  else if (allowedOrigins.includes(origin)) classification = "genuine";
  else classification = "unknown";

  return {
    origin,
    hostname,
    isHttps: httpsStateOf(origin),
    classification,
    framed,
    allowedOrigins,
  };
}

/**
 * The text the wallet extensions show in their own domain confirmation, as
 * documented in the onboarding content. Public so onboarding can link it.
 */
export const WALLET_DOMAIN_BINDING_DOCS = {
  freighter:
    "https://docs.freighter.app/docs/gettingStarted/buildYourApp/installAndUseFreighter#sign-transactions",
  xbull: "https://xbull.app/docs",
} as const;
