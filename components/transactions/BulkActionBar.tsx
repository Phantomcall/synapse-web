import { useCallback, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

export type BulkItemStatus =
  | "pending"
  | "signing"
  | "success"
  | "failed"
  | "skipped";

export interface BulkActionItem {
  id: string;
  label: string;
  status: BulkItemStatus;
  message?: string;
}

export interface BulkActionBarProps {
  /** Human readable name of the lifecycle action, e.g. "Fail transaction". */
  actionLabel: string;
  /** Selected transaction ids, in the order they should be processed. */
  selectedIds: string[];
  /** Optional label resolver for rendering each item in the progress list. */
  getLabel?: (id: string) => string;
  /**
   * Sequentially sign-and-submit the lifecycle action for a single item.
   * Must throw (or return { ok: false }) when the item is ineligible so the
   * bar can mark it as skipped instead of failed.
   */
  onRunItem: (
    id: string,
  ) => Promise<{ ok: boolean; skipped?: boolean; message?: string }>;
  /** Called once the batch finishes (fully or partially). */
  onComplete?: (items: BulkActionItem[]) => void;
  /** Clears the current selection after a batch completes. */
  onClearSelection?: () => void;
  disabled?: boolean;
}

const STATUS_LABEL: Record<BulkItemStatus, string> = {
  pending: "Pending",
  signing: "Signing…",
  success: "Success",
  failed: "Failed",
  skipped: "Skipped",
};

const STATUS_VARIANT: Record<
  BulkItemStatus,
  "default" | "secondary" | "destructive" | "outline"
> = {
  pending: "outline",
  signing: "secondary",
  success: "default",
  failed: "destructive",
  skipped: "secondary",
};

/**
 * BulkActionBar orchestrates a sequential sign-and-submit loop across a set of
 * selected transactions. Each item still requires its own wallet signature —
 * there is no signature batching shortcut. Per-item status is tracked and
 * rendered as a progress list, and the batch can be cancelled mid-run leaving a
 * resumable partial-completion state.
 */
export function BulkActionBar({
  actionLabel,
  selectedIds,
  getLabel,
  onRunItem,
  onComplete,
  onClearSelection,
  disabled = false,
}: BulkActionBarProps) {
  const [items, setItems] = useState<BulkActionItem[]>([]);
  const [running, setRunning] = useState(false);
  const [cancelled, setCancelled] = useState(false);

  const reset = useCallback(() => {
    setItems([]);
    setCancelled(false);
  }, []);

  const start = useCallback(async () => {
    if (running || selectedIds.length === 0) return;

    setRunning(true);
    setCancelled(false);

    const initial: BulkActionItem[] = selectedIds.map((id) => ({
      id,
      label: getLabel ? getLabel(id) : id,
      status: "pending",
    }));
    setItems(initial);

    let working = initial;
    let wasCancelled = false;

    for (let i = 0; i < working.length; i += 1) {
      // Cancellation is checked between items so the in-flight signature can
      // finish cleanly and the remaining items stay pending (resumable).
      if (wasCancelled) break;

      working = working.map((item, idx) =>
        idx === i ? { ...item, status: "signing", message: undefined } : item,
      );
      setItems(working);

      try {
        const result = await onRunItem(working[i].id);
        working = working.map((item, idx) => {
          if (idx !== i) return item;
          if (result.skipped) {
            return {
              ...item,
              status: "skipped",
              message: result.message ?? "No longer eligible — skipped.",
            };
          }
          if (result.ok) {
            return { ...item, status: "success", message: result.message };
          }
          return {
            ...item,
            status: "failed",
            message: result.message ?? "Action failed.",
          };
        });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Unexpected error while signing.";
        working = working.map((item, idx) =>
          idx === i ? { ...item, status: "failed", message } : item,
        );
      }

      setItems(working);

      // Allow the user to cancel between items.
      if (cancelledRef.current) {
        wasCancelled = true;
      }
    }

    setRunning(false);
    setCancelled(wasCancelled);
    onComplete?.(working);
  }, [getLabel, onComplete, onRunItem, running, selectedIds]);

  // Keep a ref in sync so the async loop can observe cancellation without
  // re-creating the callback on every render.
  const cancelledRef = useMemo(() => ({ current: false }), []);
  const cancel = useCallback(() => {
    cancelledRef.current = true;
    setCancelled(true);
  }, [cancelledRef]);

  const completed = items.filter(
    (item) => item.status === "success" || item.status === "failed" || item.status === "skipped",
  ).length;
  const progress = items.length === 0 ? 0 : Math.round((completed / items.length) * 100);
  const hasPartial = cancelled && completed < items.length;

  return (
    <Card className="border-dashed">
      <CardHeader className="flex flex-row items-center justify-between gap-4 space-y-0">
        <CardTitle className="text-sm font-medium">
          Bulk action: {actionLabel}
        </CardTitle>
        <div className="flex items-center gap-2">
          {running ? (
            <Button variant="outline" size="sm" onClick={cancel}>
              Cancel
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={start}
              disabled={disabled || selectedIds.length === 0}
            >
              Run on {selectedIds.length} selected
            </Button>
          )}
          {!running && items.length > 0 && (
            <Button variant="ghost" size="sm" onClick={reset}>
              Clear
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Select one or more pending transactions to run this action. Each item
            requires its own wallet signature.
          </p>
        ) : (
          <>
            <Progress value={progress} />
            {hasPartial && (
              <p className="text-sm text-amber-600">
                Batch cancelled — {completed} of {items.length} processed. You can
                re-run to resume the remaining items.
              </p>
            )}
            <ul className="space-y-2">
              {items.map((item) => (
                <li
                  key={item.id}
                  className="flex items-start justify-between gap-3 rounded-md border p-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{item.label}</p>
                    {item.message && (
                      <p
                        className={cn(
                          "text-xs",
                          item.status === "failed"
                            ? "text-destructive"
                            : "text-muted-foreground",
                        )}
                      >
                        {item.message}
                      </p>
                    )}
                  </div>
                  <Badge variant={STATUS_VARIANT[item.status]}>
                    {STATUS_LABEL[item.status]}
                  </Badge>
                </li>
              ))}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export default BulkActionBar;
