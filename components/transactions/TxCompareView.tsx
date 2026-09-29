"use client";
import { TxTimeline } from "./TxTimeline";
import { Panel } from "@/components/ui/Panel";
import { AMBER, BG3, BORDER, MONO } from "@/lib/constants";
import type { Transaction } from "@/lib/types";

const COMPARE_FIELDS: { key: keyof Transaction; label: string }[] = [
  { key: "id", label: "tx_id" },
  { key: "status", label: "status" },
  { key: "asset", label: "asset" },
  { key: "amount", label: "amount" },
  { key: "memo", label: "memo" },
  { key: "callbackUrl", label: "callback_url" },
];

function fieldValue(tx: Transaction, key: keyof Transaction): string {
  const value = tx[key];
  if (value === undefined || value === null || value === "") return "—";
  return String(value);
}

/**
 * Returns the set of field keys whose values differ across the compared
 * transactions. Fields missing on some transactions are treated as "—" so
 * alignment never breaks when the selected set has heterogeneous shapes.
 */
export function diffFields(txs: Transaction[]): Set<keyof Transaction> {
  const differing = new Set<keyof Transaction>();
  if (txs.length < 2) return differing;
  for (const { key } of COMPARE_FIELDS) {
    const first = fieldValue(txs[0], key);
    if (txs.some((tx) => fieldValue(tx, key) !== first)) {
      differing.add(key);
    }
  }
  return differing;
}

export function TxCompareView({
  txs,
  onClose,
}: {
  txs: Transaction[];
  onClose: () => void;
}) {
  const differing = diffFields(txs);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.72)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 60,
        padding: 24,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(1100px, 100%)",
          maxHeight: "90vh",
          overflow: "auto",
          background: BG3,
          border: `1px solid ${BORDER}`,
          padding: 20,
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 16,
          }}
        >
          <span
            style={{
              fontFamily: MONO,
              fontSize: 12,
              letterSpacing: "0.08em",
              color: AMBER,
            }}
          >
            COMPARE {txs.length} TRANSACTIONS
          </span>
          <button
            onClick={onClose}
            style={{
              background: "transparent",
              border: `1px solid ${BORDER}`,
              color: "#eee",
              fontFamily: MONO,
              fontSize: 11,
              padding: "6px 14px",
              cursor: "pointer",
            }}
          >
            CLOSE ✕
          </button>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: `140px repeat(${txs.length}, minmax(0, 1fr))`,
            gap: 1,
            background: BORDER,
            border: `1px solid ${BORDER}`,
          }}
        >
          <div style={cellStyle(true)}>FIELD</div>
          {txs.map((tx) => (
            <div key={tx.id} style={cellStyle(true)}>
              {tx.id}
            </div>
          ))}

          {COMPARE_FIELDS.map(({ key, label }) => {
            const isDiff = differing.has(key);
            return (
              <div key={key} style={{ display: "contents" }}>
                <div style={cellStyle(false)}>{label}</div>
                {txs.map((tx) => (
                  <div
                    key={`${tx.id}-${key}`}
                    style={{
                      ...cellStyle(false),
                      background: isDiff ? "rgba(245,166,35,0.12)" : BG3,
                      color: isDiff ? AMBER : "#ddd",
                    }}
                  >
                    {fieldValue(tx, key)}
                  </div>
                ))}
              </div>
            );
          })}
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: `repeat(${txs.length}, minmax(0, 1fr))`,
            gap: 12,
            marginTop: 20,
          }}
        >
          {txs.map((tx) => (
            <Panel key={tx.id} title={`TIMELINE · ${tx.id}`}>
              <TxTimeline tx={tx} />
            </Panel>
          ))}
        </div>
      </div>
    </div>
  );
}

function cellStyle(header: boolean): React.CSSProperties {
  return {
    background: header ? "rgba(245,166,35,0.08)" : BG3,
    color: header ? AMBER : "#ddd",
    fontFamily: MONO,
    fontSize: 11,
    padding: "8px 10px",
    wordBreak: "break-all",
    letterSpacing: header ? "0.06em" : undefined,
  };
}
