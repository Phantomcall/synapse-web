// Persistent, typed address book for frequently used Stellar addresses.
// Entries are {address, label} pairs stored in localStorage and surfaced as
// autocomplete suggestions wherever an address is entered.

const STORAGE_KEY = "handsoff.addressBook.v1";

export interface AddressBookEntry {
  address: string;
  label: string;
}

/**
 * Minimal Stellar address validation: a 56-char StrKey starting with `G`.
 * Kept local so the address book can gate saves without depending on the
 * form-validation overhaul landing first.
 */
export function isValidAddress(address: string): boolean {
  return /^G[A-Z2-7]{55}$/.test(address.trim());
}

function isEntry(value: unknown): value is AddressBookEntry {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.address === "string" && typeof v.label === "string";
}

/** Read the persisted address book. Returns [] on missing/corrupt data. */
export function loadAddressBook(): AddressBookEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isEntry);
  } catch {
    return [];
  }
}

function persist(entries: AddressBookEntry[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Storage may be unavailable (private mode / quota); fail silently.
  }
}

/**
 * Add or update an entry. Addresses are unique; saving an existing address
 * updates its label. Invalid addresses are rejected (returns current list).
 */
export function saveAddress(
  entries: AddressBookEntry[],
  entry: AddressBookEntry
): AddressBookEntry[] {
  const address = entry.address.trim();
  const label = entry.label.trim();
  if (!isValidAddress(address) || !label) return entries;

  const next = entries.filter((e) => e.address !== address);
  next.push({ address, label });
  next.sort((a, b) => a.label.localeCompare(b.label));
  persist(next);
  return next;
}

/** Remove an entry by address. */
export function removeAddress(
  entries: AddressBookEntry[],
  address: string
): AddressBookEntry[] {
  const next = entries.filter((e) => e.address !== address);
  persist(next);
  return next;
}

/**
 * Case-insensitive match against label or address prefix, used to drive the
 * autocomplete dropdown. Empty query returns the full list.
 */
export function matchAddresses(
  entries: AddressBookEntry[],
  query: string
): AddressBookEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  return entries.filter(
    (e) =>
      e.label.toLowerCase().includes(q) || e.address.toLowerCase().startsWith(q)
  );
}
