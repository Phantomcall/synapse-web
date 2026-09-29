"use client";

import { useState, useEffect, useCallback } from "react";

export interface ExtensionCheckResult {
  freighter: boolean;
  xbull: boolean;
  albedo: boolean;
  hasAny: boolean;
}

/**
 * Checks if a specific wallet extension is injected into the global window object.
 */
export function checkInstalledExtensions(): ExtensionCheckResult {
  if (typeof window === "undefined") {
    return {
      freighter: false,
      xbull: false,
      albedo: false,
      hasAny: false,
    };
  }

  const win = window as any;

  // Freighter detection
  const freighter = Boolean(
    win.freighterApi ||
      win.freighter ||
      (win.stellar && win.stellar.freighter)
  );

  // xBull detection
  const xbull = Boolean(
    win.xBull ||
      win.xbull ||
      win.xBullWallet ||
      (win.stellar && win.stellar.xbull)
  );

  // Albedo detection
  const albedo = Boolean(win.albedo);

  const hasAny = freighter || xbull || albedo;

  return {
    freighter,
    xbull,
    albedo,
    hasAny,
  };
}

/**
 * Hook to monitor wallet extension installation state, re-checking on tab focus and visibility change.
 */
export function useWalletExtensionDetection() {
  const [result, setResult] = useState<ExtensionCheckResult>({
    freighter: false,
    xbull: false,
    albedo: false,
    hasAny: false,
  });
  const [checked, setChecked] = useState(false);

  const recheck = useCallback(() => {
    const res = checkInstalledExtensions();
    setResult(res);
    setChecked(true);
    return res;
  }, []);

  useEffect(() => {
    recheck();

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        recheck();
      }
    };

    const handleFocus = () => {
      recheck();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleFocus);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleFocus);
    };
  }, [recheck]);

  return {
    ...result,
    checked,
    recheck,
  };
}
