export function shortId(id: string): string {
  return id ? id.slice(0, 13) + "…" : "—";
}

export function elapsed(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

export function formatAmount(n: number | string): string {
  const num = typeof n === "number" ? n : parseFloat(n) || 0;
  return num.toFixed(2);
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  const h = Math.floor(s / 3600);
  return `${h}h ${Math.floor((s % 3600) / 60)}m`;
}

export function formatTimestamp(ts: number): string {
  if (!Number.isFinite(ts)) return "—";
  return new Date(ts).toLocaleString();
}
