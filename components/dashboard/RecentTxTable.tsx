"use client";
import { memo, type CSSProperties } from "react";
import { Panel } from "@/components/ui/Panel";
import { SorobanTip } from "@/components/ui/SorobanTip";
import { Badge } from "@/components/ui/Badge";
import { CopyButton } from "@/components/ui/CopyButton";
import { AMBER, BG3, BORDER, DIM, MONO } from "@/lib/constants";
import { shortId, elapsed, formatAmount } from "@/lib/utils";
import type { Transaction } from "@/lib/types";

interface RecentTxTableProps {
  txs: Transaction[];
  onSelect: (tx: Transaction) => void;
}

const HEADERS = ["TX ID", "ASSET", "AMOUNT", "STATUS", "AGE"];
const ROW_STYLE: CSSProperties = {
  cursor: "pointer",
  borderBottom: `1px solid ${BORDER}`,
  transition: "background 0.15s",
};
const CELL_STYLE: CSSProperties = { padding: 8 };
const FLEX_CELL_STYLE: CSSProperties = { display: "flex", alignItems: "center" };
const ID_STYLE: CSSProperties = {
  fontSize: 11,
  color: AMBER,
  fontFamily: MONO,
};
const COPY_BUTTON_STYLE: CSSProperties = { marginLeft: 4 };
const ASSET_STYLE: CSSProperties = {
  ...CELL_STYLE,
  fontSize: 11,
  color: "#ccc",
  fontFamily: MONO,
};
const AMOUNT_STYLE: CSSProperties = { ...ASSET_STYLE, color: "#fff" };
const AGE_STYLE: CSSProperties = { ...ASSET_STYLE, color: DIM };

// Mobile-first breakpoints (Tailwind v4 defaults):
//   < 640px  → card layout (one card per transaction, all columns labelled)
//   >= 640px → dense table layout (original desktop-first grid)
const CARD_LABEL_STYLE: CSSProperties = {
  fontSize: 9,
  letterSpacing: "0.1em",
  color: DIM,
  fontFamily: MONO,
};
const CARD_VALUE_STYLE: CSSProperties = {
  fontSize: 11,
  color: "#ccc",
  fontFamily: MONO,
};

interface RecentTxRowProps {
  tx: Transaction;
  onSelect: (tx: Transaction) => void;
}

function hasSameRenderedData(previous: RecentTxRowProps, next: RecentTxRowProps) {
  const previousTx = previous.tx;
  const nextTx = next.tx;

  return (
    previous.onSelect === next.onSelect &&
    previousTx.id === nextTx.id &&
    previousTx.asset === nextTx.asset &&
    previousTx.amount === nextTx.amount &&
    previousTx.status === nextTx.status &&
    previousTx.timestamp === nextTx.timestamp
  );
}

const RecentTxRow = memo(function RecentTxRow({ tx, onSelect }: RecentTxRowProps) {
  return (
    <tr
      onClick={() => onSelect(tx)}
      style={ROW_STYLE}
      onMouseEnter={(event) => (event.currentTarget.style.background = BG3)}
      onMouseLeave={(event) => (event.currentTarget.style.background = "transparent")}
    >
      <td style={CELL_STYLE}>
        <div style={FLEX_CELL_STYLE}>
          <span style={ID_STYLE}>{shortId(tx.id)}</span>
          <CopyButton value={tx.id} label="Tx ID" style={COPY_BUTTON_STYLE} />
        </div>
      </td>
      <td style={ASSET_STYLE}>{tx.asset}</td>
      <td style={AMOUNT_STYLE}>{formatAmount(tx.amount)}</td>
      <td style={CELL_STYLE}>
        <Badge status={tx.status} />
      </td>
      <td style={AGE_STYLE} suppressHydrationWarning>
        {elapsed(tx.timestamp)}
      </td>
    </tr>
  );
}, hasSameRenderedData);

const RecentTxCard = memo(function RecentTxCard({ tx, onSelect }: RecentTxRowProps) {
  return (
    <button
      type="button"
      onClick={() => onSelect(tx)}
      className="flex w-full flex-col gap-2 border-b p-3 text-left transition-colors hover:bg-white/5"
      style={{ borderColor: BORDER, background: "transparent" }}
    >
      <div className="flex items-center justify-between gap-2">
        <div style={FLEX_CELL_STYLE}>
          <span style={ID_STYLE}>{shortId(tx.id)}</span>
          <CopyButton value={tx.id} label="Tx ID" style={COPY_BUTTON_STYLE} />
        </div>
        <Badge status={tx.status} />
      </div>
      <div className="grid grid-cols-3 gap-2">
        <div className="flex flex-col gap-0.5">
          <span style={CARD_LABEL_STYLE}>ASSET</span>
          <span style={CARD_VALUE_STYLE}>{tx.asset}</span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span style={CARD_LABEL_STYLE}>AMOUNT</span>
          <span style={{ ...CARD_VALUE_STYLE, color: "#fff" }}>{formatAmount(tx.amount)}</span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span style={CARD_LABEL_STYLE}>AGE</span>
          <span style={{ ...CARD_VALUE_STYLE, color: DIM }} suppressHydrationWarning>
            {elapsed(tx.timestamp)}
          </span>
        </div>
      </div>
    </button>
  );
}, hasSameRenderedData);

export function RecentTxTable({ txs, onSelect }: RecentTxTableProps) {
  return (
    <Panel title="RECENT TRANSACTIONS">
      {/* Mobile (< 640px): card layout keeps every column's data accessible. */}
      <div className="flex flex-col sm:hidden">
        {txs.map((tx) => (
          <RecentTxCard key={tx.id} tx={tx} onSelect={onSelect} />
        ))}
      </div>
      {/* Tablet/desktop (>= 640px): dense table, horizontally scrollable if needed. */}
      <div className="hidden overflow-x-auto sm:block">
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              {HEADERS.map((header) => (
                <th
                  key={header}
                  style={{
                    padding: "4px 8px 8px",
                    fontSize: 9,
                    letterSpacing: "0.1em",
                    color: DIM,
                    fontFamily: MONO,
                    textAlign: "left",
                    borderBottom: `1px solid ${BORDER}`,
                  }}
                >
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {txs.map((tx) => (
              <RecentTxRow key={tx.id} tx={tx} onSelect={onSelect} />
            ))}
          </tbody>
        </table>
      </div>
      <SorobanTip>
        parse TransactionRegistered events from RPC → populate table rows in real-time
      </SorobanTip>
    </Panel>
  );
}
