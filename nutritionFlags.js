/**
 * Two switches for Nutrition:
 *   group  — a setting in the group's sheet (`trackNutrition`). Off means nobody in the group sees Nutrition.
 *   device — a flag in localStorage. Only asked when the group has Nutrition on; hides the page on this device.
 * Missing values mean on, so existing groups and a first visit keep today's behaviour.
 */
import { STORAGE_PREFIX } from './config.js';

export const SHOW_KEY = STORAGE_PREFIX + 'show_nutrition';

export function groupNutritionOn(settings) {
  return (settings?.trackNutrition ?? 'true') !== 'false';
}

export function loadShowNutrition(storage = globalThis.localStorage) {
  try { return storage.getItem(SHOW_KEY) !== 'false'; } catch { return true; }
}

export function saveShowNutrition(on, storage = globalThis.localStorage) {
  try {
    if (on) storage.removeItem(SHOW_KEY);
    else storage.setItem(SHOW_KEY, 'false');
  } catch { /* private mode: the choice just is not remembered */ }
  return !!on;
}

export function nutritionVisible(settings, storage = globalThis.localStorage) {
  return groupNutritionOn(settings) && loadShowNutrition(storage);
}
