"use client";
import { AMBER, BORDER, DIM, MONO, STATUS_META } from "@/lib/constants";
import { elapsed } from "@/lib/utils";
import type { TxStatus } from "@/lib/types";

export interface TxTimelineEvent {
  status: TxStatus;
  timestamp: string | number | Date | null | undefined;
}

interface TxTimelineProps {
  events: TxTimelineEvent[];
  /** When true, the final segment is open-ended (transaction still in progress). */
  inProgress?: boolean;
}

interface NormalizedEvent {
  status: TxStatus;
  time: number | null;
}

/**
 * Defensively normalize a raw event list: drop entries without a usable status,
 * coerce timestamps to epoch millis, and sort ascending by time. Events with
 * missing/invalid timestamps are kept but pushed to the end so they never crash
 * the render or corrupt the ordering of valid events.
 */
function normalizeEvents(events: TxTimelineEvent[]): NormalizedEvent[] {
  const normalized: NormalizedEvent[] = [];
  for (const ev of events) {
    if (!ev || !ev.status) continue;
    let time: number | null = null;
    if (ev.timestamp != null) {
      const parsed = new Date(ev.timestamp).getTime();
      if (!Number.isNaN(parsed)) time = parsed;
    }
    normalized.push({ status: ev.status, time });
  }
  return normalized.sort((a, b) => {
    if (a.time == null && b.time == null) return 0;
    if (a.time == null) return 1;
    if (b.time == null) return -1;
    return a.time - b.time;
  });
}

function formatTimestamp(time: number | null): string {
  if (time == null) return "—";
  return new Date(time).toISOString().replace("T", " ").slice(0, 19);
}

function formatDuration(ms: number | null): string {
  if (ms == null || ms < 0) return "—";
  return elapsed(ms);
}

export function TxTimeline({ events, inProgress = false }: TxTimelineProps) {
  const normalized = normalizeEvents(events);

  if (normalized.length === 0) {
    return (
      <div
        style={{
          fontFamily: MONO,
          fontSize: 10,
          color: DIM,
          padding: "8px 0",
        }}
      >
        No lifecycle events recorded.
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
      {normalized.map((ev, i) => {
        const meta = STATUS_META[ev.status];
        const color = meta?.color ?? AMBER;
        const prev = i > 0 ? normalized[i - 1] : null;
        const duration =
          prev && prev.time != null && ev.time != null ? ev.time - prev.time : null;
        const isLast = i === normalized.length - 1;
        const openEnded = isLast && inProgress;

        return (
          <div key={`${ev.status}-${i}`} style={{ display: "flex", gap: 10 }}>
            {/* Rail */}
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                width: 14,
                flexShrink: 0,
              }}
            >
              <span
                style={{
                  width: 9,
                  height: 9,
                  borderRadius: "50%",
                  background: color,
                  border: `1px solid ${color}`,
                  marginTop: 4,
                  flexShrink: 0,
                }}
              />
              {!isLast && (
                <span
                  style={{
                    flex: 1,
                    width: 1,
                    minHeight: 18,
                    background: openEnded ? `${color}55` : BORDER,
                  }}
                />
              )}
              {openEnded && (
                <span
                  style={{
                    flex: 1,
                    width: 1,
                    minHeight: 18,
                    background: `repeating-linear-gradient(${color} 0 3px, transparent 3px 6px)`,
                  }}
                />
              )}
            </div>

            {/* Content */}
            <div style={{ paddingBottom: isLast ? 0 : 14, flex: 1, minWidth: 0 }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "baseline",
                  gap: 8,
                }}
              >
                <span
                  style={{
                    fontFamily: MONO,
                    fontSize: 10,
                    color,
                    fontWeight: 600,
                    letterSpacing: "0.06em",
                  }}
                >
                  {ev.status}
                </span>
                <span
                  style={{
                    fontFamily: MONO,
                    fontSize: 9,
                    color: DIM,
                    whiteSpace: "nowrap",
                  }}
                >
                  {formatTimestamp(ev.time)}
                </span>
              </div>
              <div
                style={{
                  fontFamily: MONO,
                  fontSize: 9,
                  color: DIM,
                  marginTop: 2,
                }}
              >
                {i === 0
                  ? "start"
                  : `+${formatDuration(duration)} in previous stage`}
                {openEnded ? " · in progress" : ""}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
