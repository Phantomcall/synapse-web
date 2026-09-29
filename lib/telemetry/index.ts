/**
 * Thin client-side telemetry wrapper.
 *
 * The provider (e.g. Sentry's browser SDK) can be swapped without touching
 * call sites. Only the client-side SDK is used; there is no custom backend
 * endpoint.
 *
 * Privacy decisions (see PR rationale):
 * - Public wallet addresses are considered non-sensitive on-chain identifiers
 *   and are logged as-is to aid debugging. They are NOT private keys.
 * - Private keys, seed phrases, and raw signed transaction payloads are never
 *   reported. Any such fields are stripped before the event leaves the client.
 */

export interface TelemetryContext {
  /** Name of the tab where the error was caught. */
  tabName?: string;
  /** Whether a wallet was connected at the time of the error. */
  walletConnected?: boolean;
  /** Public wallet address (logged as-is; not a secret). */
  walletAddress?: string;
  /** Contract ID involved in the failing operation. */
  contractId?: string;
  /** Any additional non-sensitive context. */
  [key: string]: unknown;
}

/**
 * Keys that must never be reported. Matching is case-insensitive and
 * substring-based so variants like `privateKey`, `secret_key`, or
 * `signedXdr` are all caught.
 */
const SENSITIVE_KEY_PATTERNS = [
  'privatekey',
  'private_key',
  'secretkey',
  'secret_key',
  'seedphrase',
  'seed_phrase',
  'mnemonic',
  'password',
  'passphrase',
  'signedxdr',
  'signed_xdr',
  'signedtransaction',
  'signed_transaction',
  'rawtransaction',
  'raw_transaction',
  'signature',
  'auth',
  'token',
];

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return SENSITIVE_KEY_PATTERNS.some((pattern) => normalized.includes(pattern));
}

/**
 * Recursively strip sensitive fields from a context object before reporting.
 * Returns a new object; the input is not mutated.
 */
export function scrubContext(
  context: Record<string, unknown>,
  depth = 0,
): Record<string, unknown> {
  if (depth > 6) {
    return {};
  }

  const scrubbed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    if (isSensitiveKey(key)) {
      continue;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      scrubbed[key] = scrubContext(value as Record<string, unknown>, depth + 1);
    } else {
      scrubbed[key] = value;
    }
  }
  return scrubbed;
}

/**
 * Whether telemetry should be emitted in the current environment.
 * No-ops in local development to avoid noise from dev machines.
 */
export function isTelemetryEnabled(): boolean {
  if (typeof process !== 'undefined' && process.env) {
    if (process.env.NODE_ENV === 'development') {
      return false;
    }
    if (process.env.NEXT_PUBLIC_TELEMETRY_DISABLED === 'true') {
      return false;
    }
  }
  return true;
}

/**
 * Report an unhandled error to the telemetry provider.
 *
 * This is a no-op in local development. Only unhandled crashes should call
 * this; handled/expected errors are out of scope.
 */
export function reportError(
  error: unknown,
  context: TelemetryContext = {},
): void {
  if (!isTelemetryEnabled()) {
    return;
  }

  const scrubbed = scrubContext(context as Record<string, unknown>);

  // Provider-agnostic dispatch. When a browser SDK (e.g. Sentry) is wired up,
  // it can be attached here without changing any call sites.
  const provider = getProvider();
  if (provider) {
    provider(error, scrubbed);
    return;
  }

  // Fallback: surface to the console so errors are not silently dropped when
  // no provider is configured in a non-development environment.
  // eslint-disable-next-line no-console
  console.error('[telemetry] unhandled error', error, scrubbed);
}

type TelemetryProvider = (
  error: unknown,
  context: Record<string, unknown>,
) => void;

let provider: TelemetryProvider | null = null;

/**
 * Register the underlying telemetry provider (e.g. a Sentry wrapper).
 * Keeps the SDK swappable without touching call sites.
 */
export function setTelemetryProvider(next: TelemetryProvider | null): void {
  provider = next;
}

function getProvider(): TelemetryProvider | null {
  return provider;
}
