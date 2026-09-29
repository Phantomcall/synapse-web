"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { StatCards } from "./StatCards";
import { Pipeline } from "./Pipeline";
import { ContractInfoPanel } from "./ContractInfoPanel";
import { HealthWidget } from "./HealthWidget";
import { RecentTxTable } from "./RecentTxTable";
import { TxDetailModal } from "@/components/transactions/TxDetailModal";
import { useLiveTransactions } from "@/lib/soroban/useLiveTransactions";
import { useLiveContractInfo } from "@/lib/soroban/useLiveContractInfo";
import type { Transaction } from "@/lib/types";
import {
  DASHBOARD_WIDGET_LABELS,
  loadDashboardLayout,
  moveWidget,
  resetDashboardLayout,
  saveDashboardLayout,
  type DashboardLayout,
  type DashboardWidgetId,
} from "@/lib/dashboard/layoutPreferences";

export function DashboardTab() {
  const [selected, setSelected] = useState<Transaction | null>(null);
  const [layout, setLayout] = useState<DashboardLayout>(() =>
    loadDashboardLayout(),
  );
  const [draggingId, setDraggingId] = useState<DashboardWidgetId | null>(null);
  const [dragOverId, setDragOverId] = useState<DashboardWidgetId | null>(null);
  const txs = useLiveTransactions();
  const contractInfo = useLiveContractInfo();

  useEffect(() => {
    saveDashboardLayout(layout);
  }, [layout]);

  const reorder = useCallback((from: DashboardWidgetId, to: DashboardWidgetId) => {
    setLayout((prev) => {
      const fromIndex = prev.order.indexOf(from);
      const toIndex = prev.order.indexOf(to);
      if (fromIndex === -1 || toIndex === -1) {
        return prev;
      }
      return { ...prev, order: moveWidget(prev.order, fromIndex, toIndex) };
    });
  }, []);

  const moveByOffset = useCallback(
    (id: DashboardWidgetId, offset: number) => {
      setLayout((prev) => {
        const fromIndex = prev.order.indexOf(id);
        const toIndex = fromIndex + offset;
        if (fromIndex === -1 || toIndex < 0 || toIndex >= prev.order.length) {
          return prev;
        }
        return { ...prev, order: moveWidget(prev.order, fromIndex, toIndex) };
      });
    },
    [],
  );

  const toggleVisibility = useCallback((id: DashboardWidgetId) => {
    setLayout((prev) => ({
      ...prev,
      visibility: { ...prev.visibility, [id]: !prev.visibility[id] },
    }));
  }, []);

  const handleReset = useCallback(() => {
    setLayout(resetDashboardLayout());
  }, []);

  const widgets = useMemo(
    () => ({
      statCards: <StatCards txs={txs} />,
      pipeline: <Pipeline txs={txs} />,
      contractInfo: <ContractInfoPanel info={contractInfo} />,
      recentTx: <RecentTxTable txs={txs} onSelect={setSelected} />,
    }),
    [txs, contractInfo],
  );

  return (
    <div
      style={{ display: "flex", flexDirection: "column", gap: 12 }}
      className="animate-fade-in"
    >
      {selected && <TxDetailModal tx={selected} onClose={() => setSelected(null)} />}
      <div
        className="dashboard-layout-controls"
        style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}
      >
        {layout.order.map((id, index) => (
          <span
            key={id}
            style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
          >
            <label style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              <input
                type="checkbox"
                checked={layout.visibility[id]}
                onChange={() => toggleVisibility(id)}
                aria-label={`Toggle ${DASHBOARD_WIDGET_LABELS[id]} visibility`}
              />
              {DASHBOARD_WIDGET_LABELS[id]}
            </label>
            <button
              type="button"
              onClick={() => moveByOffset(id, -1)}
              disabled={index === 0}
              aria-label={`Move ${DASHBOARD_WIDGET_LABELS[id]} up`}
            >
              ↑
            </button>
            <button
              type="button"
              onClick={() => moveByOffset(id, 1)}
              disabled={index === layout.order.length - 1}
              aria-label={`Move ${DASHBOARD_WIDGET_LABELS[id]} down`}
            >
              ↓
            </button>
          </span>
        ))}
        <button type="button" onClick={handleReset}>
          Reset to default
        </button>
      </div>

      {layout.order.map((id) => {
        if (!layout.visibility[id]) {
          return null;
        }
        const isDragging = draggingId === id;
        const isDragOver = dragOverId === id && draggingId !== id;
        return (
          <div
            key={id}
            draggable
            onDragStart={(event) => {
              setDraggingId(id);
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", id);
            }}
            onDragOver={(event) => {
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              if (dragOverId !== id) {
                setDragOverId(id);
              }
            }}
            onDragLeave={() => {
              setDragOverId((current) => (current === id ? null : current));
            }}
            onDrop={(event) => {
              event.preventDefault();
              const source =
                draggingId ??
                (event.dataTransfer.getData("text/plain") as DashboardWidgetId);
              if (source && source !== id) {
                reorder(source, id);
              }
              setDraggingId(null);
              setDragOverId(null);
            }}
            onDragEnd={() => {
              setDraggingId(null);
              setDragOverId(null);
            }}
            style={{
              opacity: isDragging ? 0.5 : 1,
              outline: isDragOver ? "2px dashed var(--accent, #888)" : undefined,
              borderRadius: 8,
            }}
            aria-label={`${DASHBOARD_WIDGET_LABELS[id]} widget`}
          >
            {widgets[id]}
          </div>
        );
      })}
    </div>
  );
}
