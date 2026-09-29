"use client";
import { MONO, STATUS_META } from "@/lib/constants";
import type { TxStatus } from "@/lib/types";

export function Badge({ status }: { status: TxStatus }) {
  const m = STATUS_META[status];
  return (
    <span
      aria-label={m.label}
      role="status"
      style={{
        fontFamily: MONO,
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: "0.08em",
        padding: "2px 8px",
        borderRadius: 2,
        color: m.color,
        background: m.bg,
        border: `1px solid color-mix(in srgb, ${m.color} 35%, transparent)`,
        whiteSpace: "nowrap",
      }}
    >
      <span aria-hidden="true" style={{ marginRight: 5 }}>
        {m.symbol}
      </span>
      <span style={{ color: m.color }}>{m.label}</span>
    </span>
  );
}
