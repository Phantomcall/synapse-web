"use client";

import React from "react";
import { MONO } from "@/lib/constants";

interface ActionButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  color: string;
  onClick: () => void;
  fullWidth?: boolean;
  disabled?: boolean;
  busy?: boolean;
}

export function ActionButton({
  label,
  color,
  onClick,
  fullWidth,
  disabled,
  busy,
  ariaLabel,
  ...rest
}: ActionButtonProps & { ariaLabel?: string }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled || busy}
      aria-disabled={disabled || busy}
      aria-busy={busy}
      aria-label={ariaLabel || label}
      style={{
        flex: fullWidth ? undefined : 1,
        width: fullWidth ? "100%" : undefined,
        padding: "9px 12px",
        background: "transparent",
        border: `1px solid ${color}66`,
        color,
        cursor: disabled || busy ? "not-allowed" : "pointer",
        opacity: disabled ? 0.45 : 1,
        fontFamily: MONO,
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: "0.06em",
        transition: "all 0.15s",
        outlineOffset: "2px",
      }}
      onMouseEnter={(e) => {
        if (disabled || busy) return;
        (e.currentTarget as HTMLButtonElement).style.background = color + "22";
        (e.currentTarget as HTMLButtonElement).style.borderColor = color + "aa";
      }}
      onMouseLeave={(e) => {
        if (disabled || busy) return;
        (e.currentTarget as HTMLButtonElement).style.background = "transparent";
        (e.currentTarget as HTMLButtonElement).style.borderColor = color + "66";
      }}
      onFocus={(e) => {
        (e.currentTarget as HTMLButtonElement).style.outline = `2px solid ${color}`;
      }}
      onBlur={(e) => {
        (e.currentTarget as HTMLButtonElement).style.outline = "none";
      }}
      {...rest}
    >
      {busy ? "SUBMITTING…" : label}
    </button>
  );
}
