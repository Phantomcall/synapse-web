"use client";
import { useSyncExternalStore } from "react";

import { MONO } from "@/lib/constants";
import { classifyOrigin } from "@/lib/wallet/origin";
import type { OriginClassification, OriginState } from "@/lib/wallet/origin";

/**
 * Persistent origin indicator shown during connect and sign flows.
 *
 * Its job is not to look trustworthy — anyone can style a span — it is to make
 * the *comparison* legible: "this page is running at <origin>, which is either
 * the published dashboard or it is not". The three states have three colors
 * and three labels, so a clone cannot quietly pass by re-skinning one.
 *
 * - GENUINE: green, quiet, shows the exact origin.
 * - LOCAL DEV: blue-grey, looks unfinished on purpose, says "no signing here".
 * - UNVERIFIED ORIGIN: red, loud, forces the hostname into view.
 * - EMBEDDED: worst case; the address bar is not this page's address.
 */

const STATE_META: Record<
  OriginClassification,
  { label: string; color: string; bg: string; border: string; hint: string }
> = {
  genuine: {
    label: "GENUINE ORIGIN",
    color: "#8fce8f",
    bg: "rgba(102,187,106,0.08)",
    border: "rgba(102,187,106,0.35)",
    hint: "You are on the published Synapse Core dashboard. Verify the host below against the address bar before signing.",
  },
  dev: {
    label: "LOCAL DEV · NO SIGNING",
    color: "#7fa8c9",
    bg: "rgba(79,195,247,0.07)",
    border: "rgba(79,195,247,0.3)",
    hint: "Local preview. No wallet flow on this page is real; production is at https://synapse.example.com.",
  },
  unknown: {
    label: "UNVERIFIED ORIGIN",
    color: "#ff8f8f",
    bg: "rgba(239,83,80,0.1)",
    border: "rgba(239,83,80,0.5)",
    hint: "This page is not running from a known Synapse Core origin. Check the address bar: a wallet signing on this page signs for whatever domain hosts it. Do not proceed if the host looks wrong.",
  },
  framed: {
    label: "EMBEDDED · DO NOT SIGN",
    color: "#ff6f6f",
    bg: "rgba(239,83,80,0.14)",
    border: "rgba(239,83,80,0.65)",
    hint: "This page is running inside another page's frame, so what you see is not the real dashboard at all. Close the tab and open the domain you know directly.",
  },
};

interface OriginBadgeProps {
  /** Override for SSR/testability; defaults to the real `window`. */
  state?: OriginState;
}

/**
 * `window.location` cannot change without a full navigation, so the snapshot
 * is computed once per page load and cached at module scope.
 *
 * `useSyncExternalStore` (rather than `useState` + `useEffect`) is used so the
 * value is read during render without a state write in an effect body: that
 * pattern trips `react-hooks/set-state-in-effect` and causes an extra
 * cascading render on every mount. The server snapshot is `null`, so nothing
 * origin-specific is ever rendered into the SSR/SSG payload — which is also
 * correct, since the classification is meaningless off-browser.
 */
let cachedOrigin: OriginState | null = null;

function subscribeToOrigin(): () => void {
  // Nothing to subscribe to: the origin is fixed for the document's lifetime.
  return () => {};
}

function readOriginSnapshot(): OriginState {
  if (cachedOrigin === null) {
    cachedOrigin = classifyOrigin(window.location, window.top !== window.self, {
      NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
      // Vercel exposes the deployment URL as bare `VERCEL_URL`; it is inlined
      // at build time by Next. `NEXT_PUBLIC_VERCEL_URL` is a different, unset
      // variable, so reading it here silently left every Vercel deployment off
      // its own allowlist.
      VERCEL_URL: process.env.VERCEL_URL,
      NEXT_PUBLIC_CANONICAL_ORIGINS: process.env.NEXT_PUBLIC_CANONICAL_ORIGINS,
    });
  }
  return cachedOrigin;
}

function readOriginServerSnapshot(): OriginState | null {
  return null;
}

function useOriginState(): OriginState | null {
  return useSyncExternalStore(subscribeToOrigin, readOriginSnapshot, readOriginServerSnapshot);
}

export function OriginBadge({ state }: OriginBadgeProps) {
  const live = useOriginState();
  const resolved = state ?? live;
  if (!resolved) return null;

  const meta = STATE_META[resolved.classification];
  return (
    <span
      role="status"
      title={meta.hint}
      data-origin-classification={resolved.classification}
      data-origin-hostname={resolved.hostname}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        fontFamily: MONO,
        fontSize: 9,
        letterSpacing: "0.12em",
        color: meta.color,
        background: meta.bg,
        border: `1px solid ${meta.border}`,
        padding: "3px 9px",
        whiteSpace: "nowrap",
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: meta.color,
          boxShadow: `0 0 6px ${meta.color}`,
        }}
      />
      <span>{meta.label}</span>
      {"·"}
      <span style={{ letterSpacing: "0.06em", fontWeight: 700 }}>{resolved.hostname}</span>
    </span>
  );
}

/**
 * One line shown directly above a sign-triggering action. The badge in the
 * header says it once; this says it *at the moment of signing*, which is where
 * the decision actually happens. Renders nothing until the origin is known so
 * a first paint cannot flash the wrong state.
 */
export function SigningOriginNote({ state }: OriginBadgeProps) {
  const live = useOriginState();
  const resolved = state ?? live;
  if (!resolved) return null;

  const meta = STATE_META[resolved.classification];
  const muted = resolved.classification === "genuine" || resolved.classification === "dev";
  return (
    <div
      data-origin-classification={resolved.classification}
      style={{
        fontFamily: MONO,
        fontSize: 10,
        letterSpacing: "0.05em",
        lineHeight: 1.6,
        color: meta.color,
        background: meta.bg,
        border: `1px dashed ${meta.border}`,
        padding: "8px 12px",
        margin: "12px 0 0",
      }}
    >
      {muted
        ? `Signing on ${resolved.origin} — confirm this host against the address bar, then approve in the extension.`
        : `${meta.label} — ${meta.hint}`}
    </div>
  );
}
