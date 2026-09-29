"use client";

import { useEffect, useRef, type RefObject } from "react";

export interface UseFocusTrapOptions {
  enabled?: boolean;
  onEscape?: () => void;
  autoFocus?: boolean;
  initialFocusRef?: RefObject<HTMLElement | null>;
  returnFocus?: boolean;
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Reusable focus trap and keyboard navigation hook for modals, dialogs, and overlays.
 * Handles:
 * - Trapping Tab / Shift+Tab navigation within the container
 * - Auto-focusing first element or designated initialFocusRef on mount
 * - Restoring focus to the previously active element on unmount
 * - Triggering onEscape callback on Escape key press
 */
export function useFocusTrap<T extends HTMLElement = HTMLDivElement>(
  containerRef: RefObject<T | null>,
  options: UseFocusTrapOptions = {}
) {
  const {
    enabled = true,
    onEscape,
    autoFocus = true,
    initialFocusRef,
    returnFocus = true,
  } = options;

  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!enabled) return;

    if (returnFocus && typeof document !== "undefined") {
      previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
    }

    if (autoFocus && containerRef.current) {
      if (initialFocusRef?.current) {
        initialFocusRef.current.focus();
      } else {
        const focusable = containerRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
        if (focusable.length > 0) {
          focusable[0].focus();
        } else {
          containerRef.current.focus();
        }
      }
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!enabled || !containerRef.current) return;

      if (event.key === "Escape") {
        if (onEscape) {
          event.preventDefault();
          onEscape();
        }
        return;
      }

      if (event.key === "Tab") {
        const focusable = containerRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
        if (focusable.length === 0) {
          event.preventDefault();
          return;
        }

        const firstElement = focusable[0];
        const lastElement = focusable[focusable.length - 1];

        if (event.shiftKey) {
          if (
            document.activeElement === firstElement ||
            !containerRef.current.contains(document.activeElement)
          ) {
            event.preventDefault();
            lastElement.focus();
          }
        } else {
          if (
            document.activeElement === lastElement ||
            !containerRef.current.contains(document.activeElement)
          ) {
            event.preventDefault();
            firstElement.focus();
          }
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      if (returnFocus && previouslyFocusedRef.current) {
        previouslyFocusedRef.current.focus();
      }
    };
  }, [enabled, onEscape, autoFocus, initialFocusRef, returnFocus, containerRef]);

  return {
    previouslyFocusedElement: previouslyFocusedRef.current,
  };
}
