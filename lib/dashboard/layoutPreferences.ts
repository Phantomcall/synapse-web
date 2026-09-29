/**
 * Dashboard widget layout preferences.
 *
 * Stores an ordered list of dashboard widget IDs plus per-widget visibility
 * flags in localStorage so each browser can keep its own layout.
 */

export type DashboardWidgetId =
  | 'statCards'
  | 'pipeline'
  | 'contractInfoPanel'
  | 'recentTxTable';

export interface DashboardWidgetDefinition {
  id: DashboardWidgetId;
  label: string;
}

/** Canonical widget order used as the sensible default layout. */
export const DASHBOARD_WIDGETS: DashboardWidgetDefinition[] = [
  { id: 'statCards', label: 'Stat Cards' },
  { id: 'pipeline', label: 'Pipeline' },
  { id: 'contractInfoPanel', label: 'Contract Info' },
  { id: 'recentTxTable', label: 'Recent Transactions' },
];

export interface DashboardLayoutPreferences {
  /** Ordered widget IDs; order defines render order. */
  order: DashboardWidgetId[];
  /** Widget IDs that are currently hidden. */
  hidden: DashboardWidgetId[];
}

export const DASHBOARD_LAYOUT_STORAGE_KEY = 'dashboard.layoutPreferences.v1';

const WIDGET_IDS: DashboardWidgetId[] = DASHBOARD_WIDGETS.map((w) => w.id);

function isWidgetId(value: unknown): value is DashboardWidgetId {
  return typeof value === 'string' && (WIDGET_IDS as string[]).includes(value);
}

/** Returns a fresh copy of the default layout. */
export function getDefaultLayout(): DashboardLayoutPreferences {
  return { order: [...WIDGET_IDS], hidden: [] };
}

/**
 * Normalizes arbitrary stored data into a valid layout: unknown IDs are
 * dropped, missing widgets are appended in default order, and duplicates are
 * removed. This keeps the layout usable when widgets are added or removed.
 */
export function normalizeLayout(
  value: unknown,
): DashboardLayoutPreferences {
  const fallback = getDefaultLayout();
  if (!value || typeof value !== 'object') {
    return fallback;
  }

  const raw = value as { order?: unknown; hidden?: unknown };
  const seen = new Set<DashboardWidgetId>();
  const order: DashboardWidgetId[] = [];

  if (Array.isArray(raw.order)) {
    for (const id of raw.order) {
      if (isWidgetId(id) && !seen.has(id)) {
        seen.add(id);
        order.push(id);
      }
    }
  }

  for (const id of WIDGET_IDS) {
    if (!seen.has(id)) {
      seen.add(id);
      order.push(id);
    }
  }

  const hidden: DashboardWidgetId[] = [];
  if (Array.isArray(raw.hidden)) {
    for (const id of raw.hidden) {
      if (isWidgetId(id) && !hidden.includes(id)) {
        hidden.push(id);
      }
    }
  }

  return { order, hidden };
}

/** Reads the persisted layout, falling back to the default when unavailable. */
export function loadLayout(): DashboardLayoutPreferences {
  if (typeof window === 'undefined') {
    return getDefaultLayout();
  }

  try {
    const stored = window.localStorage.getItem(DASHBOARD_LAYOUT_STORAGE_KEY);
    if (!stored) {
      return getDefaultLayout();
    }
    return normalizeLayout(JSON.parse(stored));
  } catch {
    return getDefaultLayout();
  }
}

/** Persists the layout to localStorage, ignoring storage failures. */
export function saveLayout(layout: DashboardLayoutPreferences): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(
      DASHBOARD_LAYOUT_STORAGE_KEY,
      JSON.stringify(normalizeLayout(layout)),
    );
  } catch {
    // Storage may be unavailable (private mode, quota); layout stays in memory.
  }
}

/** Removes the persisted layout so the default is used again. */
export function resetLayout(): DashboardLayoutPreferences {
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.removeItem(DASHBOARD_LAYOUT_STORAGE_KEY);
    } catch {
      // Ignore storage failures.
    }
  }
  return getDefaultLayout();
}

/**
 * Moves a widget from one index to another, returning a new ordered array.
 * Used by both drag-and-drop and the keyboard reorder controls.
 */
export function moveWidget(
  order: DashboardWidgetId[],
  fromIndex: number,
  toIndex: number,
): DashboardWidgetId[] {
  if (
    fromIndex < 0 ||
    fromIndex >= order.length ||
    toIndex < 0 ||
    toIndex >= order.length ||
    fromIndex === toIndex
  ) {
    return order;
  }

  const next = [...order];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}

/** Toggles a widget's visibility, returning a new hidden list. */
export function toggleWidgetVisibility(
  hidden: DashboardWidgetId[],
  id: DashboardWidgetId,
): DashboardWidgetId[] {
  return hidden.includes(id)
    ? hidden.filter((widgetId) => widgetId !== id)
    : [...hidden, id];
}
