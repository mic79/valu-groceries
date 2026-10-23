// Which widgets the Home page shows and in what order. Kept on the device (like the theme), as in Valu Finance.
import { STORAGE_PREFIX } from './config.js';

export const LAYOUT_KEY = STORAGE_PREFIX + 'home_layout';

export const DEFAULT_WIDGETS = [
  { id: 'list',      label: 'Shopping list',           icon: 'shopping_cart', hint: '' },
  { id: 'spending',  label: 'Spending',                icon: 'bar_chart',     hint: 'Months with stores nested under each. Needs price tracking' },
  { id: 'stats',     label: 'Shopping days and items', icon: 'insights',      hint: '' },
  { id: 'nutrition', label: 'Nutrition',               icon: 'restaurant',    hint: 'Needs Nutrition on for this group' },
  { id: 'topItems',  label: 'Bought most often',       icon: 'star',          hint: '' },
];

/**
 * Merges what was saved with the current widget list: unknown ids are dropped, new widgets are added at the end
 * (enabled), and the saved order and on/off state win.
 * Older layouts had a separate "byStore" widget; that now lives inside Spending, so either switch being on keeps it.
 */
export function mergeLayout(stored) {
  const fresh = () => DEFAULT_WIDGETS.map((w) => ({ ...w, enabled: true }));
  if (!Array.isArray(stored) || stored.length === 0) return fresh();
  const byStoreOn = stored.some((s) => s && s.id === 'byStore' && s.enabled !== false);
  const seen = new Set();
  const merged = [];
  for (const s of stored) {
    if (!s || s.id === 'byStore') continue;
    const def = DEFAULT_WIDGETS.find((d) => d.id === s.id);
    if (!def || seen.has(def.id)) continue;
    seen.add(def.id);
    const enabled = def.id === 'spending' ? (s.enabled !== false || byStoreOn) : s.enabled !== false;
    merged.push({ ...def, enabled });
  }
  for (const d of DEFAULT_WIDGETS) if (!seen.has(d.id)) merged.push({ ...d, enabled: true });
  return merged;
}

export function loadLayout() {
  try {
    return mergeLayout(JSON.parse(localStorage.getItem(LAYOUT_KEY)));
  } catch {
    return mergeLayout(null);
  }
}

export function saveLayout(widgets) {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(widgets.map((w) => ({ id: w.id, enabled: w.enabled }))));
  } catch { /* storage full or blocked: the layout just is not remembered */ }
}

/** The widgets in order, with one moved a step up (-1) or down (+1). */
export function moveWidget(widgets, id, dir) {
  const idx = widgets.findIndex((w) => w.id === id);
  const to = idx + dir;
  if (idx < 0 || to < 0 || to >= widgets.length) return widgets;
  const arr = [...widgets];
  [arr[idx], arr[to]] = [arr[to], arr[idx]];
  return arr;
}
