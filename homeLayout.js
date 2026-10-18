// Which widgets the Home page shows and in what order. Kept on the device (like the theme), as in Valu Finance.
import { STORAGE_PREFIX } from './config.js';

export const LAYOUT_KEY = STORAGE_PREFIX + 'home_layout';

export const DEFAULT_WIDGETS = [
  { id: 'list',      label: 'Shopping list',        icon: 'shopping_cart', hint: '' },
  { id: 'spending',  label: 'Spending per month',   icon: 'bar_chart',     hint: 'Needs price tracking' },
  { id: 'stats',     label: 'Shopping days and items', icon: 'insights',   hint: '' },
  { id: 'nutrition', label: 'Nutrition',            icon: 'restaurant',    hint: '' },
  { id: 'byStore',   label: 'Spending per store',   icon: 'storefront',    hint: 'Needs price tracking' },
  { id: 'topItems',  label: 'Bought most often',    icon: 'star',          hint: '' },
];

/**
 * Merges what was saved with the current widget list: unknown ids are dropped, new widgets are added at the end
 * (enabled), and the saved order and on/off state win.
 */
export function mergeLayout(stored) {
  const fresh = () => DEFAULT_WIDGETS.map((w) => ({ ...w, enabled: true }));
  if (!Array.isArray(stored) || stored.length === 0) return fresh();
  const seen = new Set();
  const merged = [];
  for (const s of stored) {
    const def = s && DEFAULT_WIDGETS.find((d) => d.id === s.id);
    if (!def || seen.has(def.id)) continue;
    seen.add(def.id);
    merged.push({ ...def, enabled: s.enabled !== false });
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
