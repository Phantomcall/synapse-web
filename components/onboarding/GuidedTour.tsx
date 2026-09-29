"use client";
import { useCallback, useEffect, useMemo, useState } from "react";

import { AMBER, BG0, BG1, BG2, BORDER, DIM, MONO, TEXT } from "@/lib/constants";
import { WALLET_DOMAIN_BINDING_DOCS } from "@/lib/wallet/origin";

/**
 * First-visit anti-phishing briefing for wallet-connect and signing.
 *
 * Much of the defense against wallet-connect phishing lives in the wallet
 * extension's own domain-binding confirmation. The dashboard cannot implement
 * that and should not pretend to; what it can do is make the user taught:
 * what to check in the address bar, what the badge means, and where the
 * extension's own check lives. That is this content.
 *
 * It opens once on first visit, keyed in localStorage, and stays reopenable
 * from the header so it is never more than one click away.
 */
const ONBOARDING_KEY = "synapse-onboarding-seen-v1";

interface Step {
  title: string;
  body: string;
  links?: { label: string; href: string }[];
  target?: string;
}

const STEPS: Step[] = [
  {
    title: "The origin badge",
    body: `The badge in the header names the exact origin this page runs from.
      Green "GENUINE ORIGIN" only ever means one of the published domains.
      Red "UNVERIFIED ORIGIN" means this build is not on that list — a fork,
      a preview host, or a clone. Red beats green: compare it with the address
      bar before doing anything.`,
  },
  {
    title: "What you sign for lives in the extension",
    body: `Synapse Core never knows what you sign. Freighter and xBull show their
      own confirmation with the requesting domain — that is the check that
      actually binds you to a site. A transaction signed from a typo'd clone
      is a transaction signed for the clone.`,
    links: [
      { label: "Freighter documentation", href: WALLET_DOMAIN_BINDING_DOCS.freighter },
      { label: "xBull documentation", href: "https://xbull.app/docs" },
    ],
  },
  {
    title: "How clones get you",
    body: `Phishing clones are not "fake-looking" — they are pixel-perfect copies
      with a different host. The wallet extension's domain confirmation and
      this badge are the two signals a clone cannot copy, because both come
      from outside the page. Never type a wallet's recovery phrase anywhere,
      and bookmark the real dashboard instead of trusting search results.`,
  },
];

function loadSeen(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(ONBOARDING_KEY) === "1";
  } catch {
    return true;
  }
}

function markSeen(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ONBOARDING_KEY, "1");
  } catch {}
}

interface GuidedTourProps {
  /**
   * A counter the header increments to force the briefing open on demand, even
   * for a user who has completed it before. Never auto-opens for them again.
   */
  reopenSignal?: number;
  /** Increment to manually re-trigger the tour from outside. */
  trigger?: number;
}

export function GuidedTour({ reopenSignal = 0, trigger = 0 }: GuidedTourProps) {
  const [open, setOpen] = useState<boolean>(() => {
    // First visit: show it. The "browse the app but keep reality in view"
    // choice means a returning user is never nagged again.
    return process.env.NODE_ENV !== "test" && !loadSeen();
  });
  const [step, setStep] = useState(0);

  // Reacting to a changed prop is done by comparing against the last value
  // handled, during render, rather than in an effect. This is React's
  // documented "adjusting state when a prop changes" pattern: the comparison
  // against a value carried in state makes the first render a no-op (the
  // initial state equals the initial prop) and only a genuine change afterwards
  // reopens the tour. The previous version used a `setInitialized(true)`
  // effect as a "skip the first run" guard, which `react-hooks/set-state-in-effect`
  // flags and which costs an extra render pass on every mount.
  const [handledSignal, setHandledSignal] = useState(reopenSignal);
  if (handledSignal !== reopenSignal) {
    setHandledSignal(reopenSignal);
    setOpen(true);
    setStep(0);
  }

  // Support the legacy `trigger` prop as an additional reopen signal.
  const [handledTrigger, setHandledTrigger] = useState(trigger);
  if (handledTrigger !== trigger) {
    setHandledTrigger(trigger);
    if (trigger > 0) {
      setOpen(true);
      setStep(0);
    }
  }

  const close = useCallback(() => {
    markSeen();
    setOpen(false);
  }, []);

  const advance = useCallback(() => {
    setStep((s) => {
      if (s + 1 >= STEPS.length) {
        markSeen();
        setOpen(false);
        return s;
      }
      return s + 1;
    });
  }, []);

  const back = useCallback(() => setStep((s) => Math.max(0, s - 1)), []);

  const current = STEPS[step] ?? STEPS[0]!;

  const rect = useMemo(() => {
    if (!open || !current?.target || typeof document === "undefined") return null;
    const el = document.querySelector(current.target);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: r.top, left: r.left, width: r.width, height: r.height };
  }, [open, current, step]);

  if (!open) return null;

  const isLast = step === STEPS.length - 1;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Guided tour"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        background: "rgba(0,0,0,0.55)",
      }}
    >
      {rect && (
        <div
          style={{
            position: "fixed",
            top: rect.top - 6,
            left: rect.left - 6,
            width: rect.width + 12,
            height: rect.height + 12,
            border: `2px solid ${TEXT}`,
            boxShadow: "0 0 0 9999px rgba(0,0,0,0.55)",
            pointerEvents: "none",
          }}
        />
      )}
      <div
        style={{
          position: "fixed",
          bottom: 24,
          right: 24,
          width: 320,
          background: BG2,
          border: `1px solid ${BORDER}`,
          padding: "16px 18px",
        }}
      >
        <div
          style={{
            fontSize: 9,
            letterSpacing: "0.14em",
            color: DIM,
            fontFamily: MONO,
            marginBottom: 8,
          }}
        >
          STEP {step + 1} / {STEPS.length}
        </div>
        <div style={{ fontSize: 14, color: TEXT, marginBottom: 8 }}>{current.title}</div>
        <div style={{ fontSize: 12, color: DIM, lineHeight: 1.5, marginBottom: 16 }}>
          {current.body}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
          <button
            type="button"
            onClick={dismiss}
            style={{
              background: "transparent",
              border: "none",
              color: DIM,
              fontFamily: MONO,
              fontSize: 11,
              cursor: "pointer",
              padding: 0,
            }}
          >
            Skip tour
          </button>
          <div style={{ display: "flex", gap: 8 }}>
            {step > 0 && (
              <button
                type="button"
                onClick={back}
                style={{
                  background: "transparent",
                  border: `1px solid ${BORDER}`,
                  color: TEXT,
                  fontFamily: MONO,
                  fontSize: 11,
                  cursor: "pointer",
                  padding: "6px 12px",
                }}
              >
                Back
              </button>
            )}
            <button
              type="button"
              onClick={next}
              style={{
                background: TEXT,
                border: `1px solid ${TEXT}`,
                color: BG2,
                fontFamily: MONO,
                fontSize: 11,
                cursor: "pointer",
                padding: "6px 12px",
              }}
            >
              {isLast ? "Finish" : "Next"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
