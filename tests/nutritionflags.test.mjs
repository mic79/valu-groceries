// Group and device switches for Nutrition: missing values mean on, so existing groups keep it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SHOW_KEY, groupNutritionOn, loadShowNutrition, saveShowNutrition, nutritionVisible } from '../nutritionFlags.js';

function fakeStorage(initial = {}) {
  const m = new Map(Object.entries(initial));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

test('a group without the setting, or with true, has Nutrition on', () => {
  assert.equal(groupNutritionOn(undefined), true);
  assert.equal(groupNutritionOn({}), true);
  assert.equal(groupNutritionOn({ trackNutrition: 'true' }), true);
  assert.equal(groupNutritionOn({ trackNutrition: 'false' }), false);
});

test('the device flag defaults to shown, and hiding it is remembered', () => {
  const s = fakeStorage();
  assert.equal(loadShowNutrition(s), true);
  assert.equal(saveShowNutrition(false, s), false);
  assert.equal(s.getItem(SHOW_KEY), 'false');
  assert.equal(loadShowNutrition(s), false);
  assert.equal(saveShowNutrition(true, s), true);
  assert.equal(s.getItem(SHOW_KEY), null);
  assert.equal(loadShowNutrition(s), true);
});

test('Nutrition is visible only when the group and this device both have it on', () => {
  const shown = fakeStorage();
  const hidden = fakeStorage({ [SHOW_KEY]: 'false' });
  assert.equal(nutritionVisible({ trackNutrition: 'true' }, shown), true);
  assert.equal(nutritionVisible({ trackNutrition: 'true' }, hidden), false);
  assert.equal(nutritionVisible({ trackNutrition: 'false' }, shown), false);
  assert.equal(nutritionVisible({ trackNutrition: 'false' }, hidden), false);
  assert.equal(nutritionVisible({}, shown), true);
});

test('storage that throws never breaks the app', () => {
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  assert.equal(loadShowNutrition(broken), true);
  assert.equal(saveShowNutrition(false, broken), false);
});
