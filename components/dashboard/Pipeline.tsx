"use client";
import { Panel } from "@/components/ui/Panel";
import { SorobanTip } from "@/components/ui/SorobanTip";
import { BORDER, DIM, MONO, STATUS_META } from "@/lib/constants";
import type { Transaction, TxStatus } from "@/lib/types";

interface PipelineProps {
  txs: Transaction[];
}

const STAGES: { key: TxStatus; label: string; branch?: boolean }[] = [
  { key: "PENDING", label: "PENDING" },
  { key: "PROCESSING", label: "PROCESSING" },
  { key: "COMPLETED", label: "COMPLETED" },
  { key: "FAILED", label: "FAILED", branch: true },
];

export function Pipeline({ txs }: PipelineProps) {
  const counts: Record<TxStatus, number> = { PENDING: 0, PROCESSING: 0, COMPLETED: 0, FAILED: 0 };
  txs.forEach((t) => counts[t.status]++);

  return (
    <Panel title="TRANSACTION LIFECYCLE">
      <div style={{ overflowX: "auto", paddingBottom: 8 }}>
        <div style={{ display: "flex", alignItems: "center", minWidth: 520 }}>
          {STAGES.map((s, i) => {
            const m = STATUS_META[s.key];
            const active = counts[s.key] > 0;
            const prevStage = i > 0 ? STAGES[i - 1] : undefined;
            const prevActive = prevStage !== undefined && counts[prevStage.key] > 0;

            return (
              <div
                key={s.key}
                style={{ display: "flex", alignItems: "center", flex: s.branch ? 0 : 1 }}
              >
                {/* Branch arrow for FAILED */}
                {s.branch && (
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      marginLeft: 12,
                    }}
                  >
                    <div
                      style={{
                        width: 1,
                        height: 16,
                        background: active
                          ? `color-mix(in srgb, ${m.color} 40%, transparent)`
                          : BORDER,
                      }}
                    />
                    <svg width="12" height="8" viewBox="0 0 12 8">
                      <polyline
                        points="6,0 12,8 0,8"
                        fill={active ? m.color : BORDER}
                        opacity={active ? 0.8 : 1}
                      />
                    </svg>
                  </div>
                )}

                {/* Connector line */}
                {!s.branch && i > 0 && (
                  <div
                    style={{
                      flex: 1,
                      height: 1,
                      background: BORDER,
                      position: "relative",
                      overflow: "hidden",
                    }}
                  >
                    {prevActive && (
                      <div
                        style={{
                          position: "absolute",
                          top: -1,
                          height: 3,
                          background: `linear-gradient(90deg, ${prevStage ? `color-mix(in srgb, ${STATUS_META[prevStage.key].color} 60%, transparent)` : "transparent"}, transparent)`,
                          animation: "flowLine 1.8s linear infinite",
                        }}
                      />
                    )}
                    <span
                      style={{
                        position: "absolute",
                        top: -9,
                        left: "44%",
                        color: DIM,
                        fontSize: 12,
                        lineHeight: 1,
                      }}
                    >
                      →
                    </span>
                  </div>
                )}

                {/* Stage node */}
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    padding: "0 14px",
                  }}
                >
                  <div
                    style={{
                      width: 18,
                      height: 18,
                      borderRadius: s.key === "FAILED" ? 2 : "50%",
                      background: active ? m.color : "transparent",
                      border: `2px solid ${active ? m.color : BORDER}`,
                      boxShadow: active ? `0 0 10px 3px ${m.glow}` : "none",
                      marginBottom: 8,
                      display: "grid",
                      placeItems: "center",
                      color: active ? "#0A0B0D" : DIM,
                      fontSize: 10,
                      fontWeight: 700,
                      fontFamily: MONO,
                      animation:
                        s.key === "PROCESSING" && active
                          ? "pulse 1.2s ease-in-out infinite"
                          : "none",
                    }}
                  >
                    {m.symbol}
                  </div>
                  <span
                    style={{
                      fontSize: 9,
                      letterSpacing: "0.1em",
                      color: active ? m.color : DIM,
                      fontFamily: MONO,
                    }}
                  >
                    {s.label}
                  </span>
                  {active && (
                    <span
                      style={{
                        fontSize: 9,
                        color: m.color,
                        fontFamily: MONO,
                        marginTop: 2,
                      }}
                    >
                      [{counts[s.key]}]
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <SorobanTip>
        subscribe to StatusChanged events → animate active pipeline dot in real-time
      </SorobanTip>
    </Panel>
  );
}
