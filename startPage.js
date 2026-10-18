// Which page the app opens on. Kept on the device (like the theme and the Home layout); Dashboard by default.
import { STORAGE_PREFIX } from './config.js';

export const START_KEY = STORAGE_PREFIX + 'start_page';

/** The pages that can be the start page: the ones in the bottom bar that show your lists. `id` is the route. */
export const START_PAGES = [
  { id: 'home', label: 'Dashboard', icon: 'home' },
  { id: 'groceries', label: 'Groceries', icon: 'shopping_cart' },
  { id: 'history', label: 'History', icon: 'history' },
  { id: 'nutrition', label: 'Nutrition', icon: 'restaurant' },
  { id: 'stores', label: 'Stores', icon: 'storefront' },
];

export const DEFAULT_START = 'home';

/** A stored value is only used when it is still one of the offered pages. */
export function validStart(id) {
  return START_PAGES.some((p) => p.id === id) ? id : DEFAULT_START;
}

export function loadStartPage(storage = globalThis.localStorage) {
  try { return validStart(storage.getItem(START_KEY)); } catch { return DEFAULT_START; }
}

export function saveStartPage(id, storage = globalThis.localStorage) {
  const v = validStart(id);
  try {
    if (v === DEFAULT_START) storage.removeItem(START_KEY);
    else storage.setItem(START_KEY, v);
  } catch { /* private mode: the choice just is not remembered */ }
  return v;
}
