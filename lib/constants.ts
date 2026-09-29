import type { StatusMeta, TxStatus } from "./types";

export const STATUS_META: Record<TxStatus, StatusMeta> = {
  PENDING: {
    color: "var(--status-pending)",
    bg: "var(--status-pending-bg)",
    glow: "var(--status-pending-glow)",
    label: "PENDING",
  },
  PROCESSING: {
    color: "var(--status-processing)",
    bg: "var(--status-processing-bg)",
    glow: "var(--status-processing-glow)",
    label: "PROCESSING",
  },
  COMPLETED: {
    color: "var(--status-completed)",
    bg: "var(--status-completed-bg)",
    glow: "var(--status-completed-glow)",
    label: "COMPLETED",
  },
  FAILED: {
    color: "var(--status-failed)",
    bg: "var(--status-failed-bg)",
    glow: "var(--status-failed-glow)",
    label: "FAILED",
  },
};

export const AMBER = "var(--accent)";
export const NEUTRAL = "var(--fg)";
export const BG0 = "var(--bg-0)";
export const BG1 = "var(--bg-1)";
export const BG2 = "var(--bg-2)";
export const BG3 = "var(--bg-3)";
export const BORDER = "var(--border)";
export const DIM = "var(--dim)";

/**
 * The app's monospace stack.
 *
 * The variable is defined by `next/font` in `app/layout.tsx`, which self-hosts
 * the face and generates its own family name — so the literal string
 * "IBM Plex Mono" no longer resolves to anything and must not be used.
 *
 * Form controls do not inherit `font-family` from `body`, so buttons, inputs
 * and selects still need this applied explicitly rather than relying on the
 * cascade.
 */
export const MONO = "var(--font-ibm-plex-mono), monospace";

/**
 * Parameter type descriptors used to drive the DocsTab ABI playground.
 *
 * The playground derives its generated form directly from these descriptors,
 * so adding a new entrypoint (or a new parameter) here automatically produces
 * a working form field without touching the UI. `kind` maps onto the argument
 * encoders in `lib/soroban/args.ts`.
 */
export type AbiParamKind =
  | "address"
  | "string"
  | "u32"
  | "i128"
  | "bool"
  | "tx_payload"
  | "callback_payload";

export interface AbiParam {
  name: string;
  kind: AbiParamKind;
  /** Optional human hint shown as the field placeholder. */
  hint?: string;
}

export interface AbiEndpoint {
  name: string;
  sig: string;
  access: "one-time" | "relay_signer" | "admin" | "public";
  desc: string;
  /** Ordered parameters; empty for zero-arg entrypoints. */
  params: AbiParam[];
  /** True when the call mutates ledger state and therefore needs a signature. */
  stateChanging: boolean;
}

/**
 * Where the published documentation site lives.
 *
 * The site is built from `docs/` by `scripts/docs/build.mjs` and deployed by
 * `.github/workflows/docs.yml`. Deploying to a custom domain, or a fork, only
 * needs this value changed — no code edit.
 */
export const DOCS_SITE_URL =
  process.env.NEXT_PUBLIC_DOCS_URL ?? "https://synapse-bridgez.github.io/synapse-web";

export const ABI_ENDPOINTS: AbiEndpoint[] = [
  {
    name: "initialize",
    sig: "initialize(admin: Address, relay_signer: Address)",
    access: "one-time",
    desc: "Bootstrap the contract. Fails if already initialized. One-time call only.",
    params: [
      { name: "admin", type: "Address" },
      { name: "relay_signer", type: "Address" },
    ] as AbiParam[],
    stateChanging: true,
  },
  {
    name: "register_transaction",
    sig: "register_transaction(payload: TxPayload) → tx_id: String",
    access: "relay_signer",
    desc: "Register a new transaction. Returns a UUID. Emits TransactionRegistered event.",
    params: [
      { name: "payload", type: "struct", struct: "TxPayload" },
    ] as AbiParam[],
    stateChanging: true,
  },
  {
    name: "start_processing",
    sig: "start_processing(tx_id: String)",
    access: "relay_signer",
    desc: "Advance transaction PENDING → PROCESSING. Emits StatusChanged.",
    params: [{ name: "tx_id", type: "String" }] as AbiParam[],
  },
  {
    name: "complete_transaction",
    sig: "complete_transaction(tx_id: String)",
    access: "relay_signer",
    desc: "Advance PROCESSING → COMPLETED. Emits StatusChanged + triggers callback.",
    params: [{ name: "tx_id", type: "String" }] as AbiParam[],
  },
  {
    name: "fail_transaction",
    sig: "fail_transaction(tx_id: String, reason: String)",
    access: "relay_signer",
    desc: "Mark transaction as FAILED with a reason string. Emits StatusChanged.",
    params: [
      { name: "tx_id", type: "String" },
      { name: "reason", type: "String" },
    ] as AbiParam[],
    stateChanging: true,
  },
  {
    name: "get_transaction",
    sig: "get_transaction(tx_id: String) → Transaction",
    access: "public",
    desc: "Read-only simulation. Returns full Transaction struct from ledger storage.",
    params: [{ name: "tx_id", type: "String" }] as AbiParam[],
    stateChanging: false,
  },
  {
    name: "is_duplicate",
    sig: "is_duplicate(tx_id: String) → bool",
    access: "public",
    desc: "Check whether a tx_id has already been registered. Safe read-only call.",
    params: [{ name: "tx_id", type: "String" }] as AbiParam[],
  },
  {
    name: "register_callback",
    sig: "register_callback(payload: CallbackPayload)",
    access: "relay_signer",
    desc: "Register a webhook URL for a transaction lifecycle event notification.",
    params: [
      { name: "payload", type: "struct", struct: "CallbackPayload" },
    ] as AbiParam[],
    stateChanging: true,
  },
  {
    name: "transfer_admin",
    sig: "transfer_admin(new_admin: Address)",
    access: "admin",
    desc: "Transfer admin rights. Caller must be the current admin address.",
    params: [{ name: "new_admin", type: "Address" }] as AbiParam[],
  },
  {
    name: "set_relay_signer",
    sig: "set_relay_signer(new_signer: Address)",
    access: "admin",
    desc: "Replace the relay signer address. Caller must be the current admin.",
    params: [{ name: "new_signer", type: "Address" }] as AbiParam[],
  },
  {
    name: "health",
    sig: "health() → String",
    access: "public",
    desc: "Returns contract health string. No signing required.",
    params: [] as AbiParam[],
  },
  {
    name: "version",
    sig: "version() → String",
    access: "public",
    desc: "Returns contract semver string e.g. '0.1.0'.",
    params: [] as AbiParam[],
    stateChanging: false,
  },
];
