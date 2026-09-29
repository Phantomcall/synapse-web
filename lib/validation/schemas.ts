import { z } from "zod";

/**
 * Reusable validation schemas for admin and future forms (e.g. ABI playground).
 *
 * Stellar strkey addresses are validated for checksum correctness, not just
 * format/length, so malformed input is caught before any wallet prompt.
 */

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Decode a base32 string (RFC 4648, no padding) into bytes. Returns null on invalid chars. */
function base32Decode(input: string): Uint8Array | null {
  let bits = 0;
  let value = 0;
  const output: number[] = [];

  for (const char of input) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) return null;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return new Uint8Array(output);
}

/** CRC16-XModem checksum used by Stellar strkey encoding. */
function crc16xmodem(data: Uint8Array): number {
  let crc = 0x0000;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
}

/**
 * Validate a Stellar strkey address (account `G...` or contract `C...`),
 * verifying the CRC16-XModem checksum, not just the format/length.
 */
export function isValidStellarAddress(value: string): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length !== 56) return false;
  if (!/^[GC][A-Z2-7]{55}$/.test(trimmed)) return false;

  const decoded = base32Decode(trimmed);
  if (!decoded || decoded.length !== 35) return false;

  const payload = decoded.subarray(0, 33);
  const checksum = decoded[32] | (decoded[33] << 8);
  return crc16xmodem(payload) === checksum;
}

/** Zod schema for a required, checksum-valid Stellar address. */
export const stellarAddressSchema = z
  .string()
  .trim()
  .min(1, "Address is required")
  .refine(isValidStellarAddress, "Invalid Stellar address (checksum failed)");

/** Zod schema for an optional Stellar address (empty string allowed). */
export const optionalStellarAddressSchema = z
  .string()
  .trim()
  .refine((v) => v === "" || isValidStellarAddress(v), "Invalid Stellar address (checksum failed)");

/** Zod schema for a required numeric parameter within an inclusive range. */
export function numericParamSchema(min: number, max: number) {
  return z
    .union([z.string(), z.number()])
    .transform((v) => (typeof v === "string" ? v.trim() : v))
    .refine((v) => v !== "", "Value is required")
    .refine((v) => !Number.isNaN(Number(v)), "Must be a valid number")
    .refine((v) => Number(v) >= min && Number(v) <= max, `Must be between ${min} and ${max}`);
}

/** Zod schema for a required non-empty text parameter. */
export const requiredTextSchema = z.string().trim().min(1, "Value is required");

/**
 * Build a validation schema for an entrypoint's parameter set.
 * Each parameter is validated against its expected type.
 */
export type ParamKind = "address" | "number" | "text";

export interface ParamSpec {
  name: string;
  kind: ParamKind;
  min?: number;
  max?: number;
  optional?: boolean;
}

export function buildParamSchema(specs: ParamSpec[]) {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const spec of specs) {
    if (spec.kind === "address") {
      shape[spec.name] = spec.optional ? optionalStellarAddressSchema : stellarAddressSchema;
    } else if (spec.kind === "number") {
      shape[spec.name] = numericParamSchema(spec.min ?? Number.MIN_SAFE_INTEGER, spec.max ?? Number.MAX_SAFE_INTEGER);
    } else {
      shape[spec.name] = spec.optional ? z.string().trim() : requiredTextSchema;
    }
  }
  return z.object(shape);
}
