import type { FlagRegistry } from "./types";

/**
 * The flag registry — the build-time source of truth.
 *
 * Every flag in the app is declared here, with a default that is safe when the
 * remote source is unreachable. Two rules make that safe-by-default rather than
 * safe-by-hope:
 *
 *   - **A new capability is declared `false`.** Nothing appears until someone
 *     turns it on. The cost of forgetting is a feature that does not launch.
 *   - **A shipped capability is declared `true`.** The flag exists purely so it
 *     can be switched off without a redeploy — e.g. if the admin RPC starts
 *     failing under load, or the docs page starts 500ing. Turning an existing
 *     tab off must not require a rollback, and it must not require the remote
 *     config service to be healthy in order to be safe.
 *
 * When a flag has served its purpose, delete it and the branch of code it
 * guarded. Flags are debt; a registry with 40 permanently-true entries is
 * indistinguishable from having no flags at all, and much harder to delete.
 */
export const FLAGS = {
  "tab.admin": {
    key: "tab.admin",
    description:
      "Shows the admin tab: network health, RPC diagnostics and latency percentiles. Declared true because it already ships — the flag is a kill-switch, not a launch gate.",
    defaultValue: true,
    owner: "core",
  },
  "tab.docs": {
    key: "tab.docs",
    description:
      "Shows the docs tab: local developer setup and architecture notes. Declared true because it already ships — the flag is a kill-switch, not a launch gate.",
    defaultValue: true,
    owner: "core",
  },
  "transactions.bulk-actions": {
    key: "transactions.bulk-actions",
    description:
      "Multi-select and bulk-sign flows on the transactions tab. Not yet implemented — declared false as the worked example of a capability that cannot appear before it is enabled.",
    defaultValue: false,
    owner: "core",
  },
} as const satisfies FlagRegistry;

export type FlagKey = keyof typeof FLAGS;

/** Registry as a plain record, for the generic resolver. */
export const REGISTRY: FlagRegistry = FLAGS;

/** Every declared flag key, for validating remote payloads against the registry. */
export const FLAG_KEYS: readonly string[] = Object.keys(FLAGS);

/** The tab key each tab-visibility flag gates. */
export const TAB_FLAGS: Readonly<Record<string, FlagKey>> = {
  admin: "tab.admin",
  docs: "tab.docs",
};

export type FlagPredicate = (key: FlagKey) => boolean;

/**
 * Drop tabs whose flag is off.
 *
 * Note what is deliberately *not* here: no "always show at least one tab"
 * clamp. If every tab were gated off that would be a registry mistake, and
 * rendering a blank shell would surface it immediately rather than hiding it
 * behind a fallback that papers over the misconfiguration.
 */
export function visibleTabs<T extends string>(tabs: readonly T[], isEnabled: FlagPredicate): T[] {
  return tabs.filter((tab) => {
    const flag = TAB_FLAGS[tab];
    if (!flag) return true;
    return isEnabled(flag);
  });
}

/**
 * Keep the active tab valid after gating.
 *
 * A tab can be switched off *while it is open* — a colleague disables
 * `tab.admin` from the flag console and the next poll removes the tab under
 * them. Without this, `tab` points at a tab that is no longer rendered and the
 * content area goes blank with no explanation. Falling back to the first visible
 * tab (which is the dashboard) is the behaviour a user would expect.
 */
export function resolveActiveTab<T extends string>(
  tabs: readonly T[],
  active: T,
  isEnabled: FlagPredicate
): T | null {
  const visible = visibleTabs(tabs, isEnabled);
  const [first] = visible;
  if (first === undefined) return null;
  return visible.includes(active) ? active : first;
}
