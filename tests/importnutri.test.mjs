// Import from the old Nutri app: stores, items AND its Nutrition tab, without touching the source and without duplicates.
import test from 'node:test';
import assert from 'node:assert/strict';
import SheetsApi, { TABS } from '../sheetsApi.js';
import { convertNutriNutrition, rowToNutrition, entryProblems, problemKind } from '../nutritionLogic.js';
import { importFromNutri } from '../importNutri.js';

// Nutri Nutrition!A2:H: Name, Calories, Protein, Carbs, Fat, Category, Unit, GramsPerUnit
const NUTRI_ROWS = [
  ['Oats', 380, 13, 60, 7, 'Grains', 'g', 1],
  ['Eggs', 143, 12.6, 0.7, 9.5, 'Dairy & eggs', 'unit', 55],
  ['Milk', 46, 3.4, 5, 1.5, 'Dairy', 'ml', 1],
  ['Dish soap', '', '', '', '', 'Non-food', 'g', 1],
  ['Magic bar', 5000, 10, 10, 10, 'Sweets', 'g', 1],        // impossible calories
  ['', 100, 1, 1, 1, 'Fruit', 'g', 1],                       // no name
  ['oats', 1, 1, 1, 1, 'Grains', 'g', 1],                    // same product again: first wins
  ['Mystery', 200, 10, 20, 8, 'Whatever', 'furlongs', 1],    // odd category and unit: kept, to review
];

test('Nutri nutrition rows become entries: aliases read, bad rows reported, doubtful ones counted', () => {
  const r = convertNutriNutrition(NUTRI_ROWS);
  assert.deepEqual(r.entries.map((e) => e.name), ['Oats', 'Eggs', 'Milk', 'Dish soap', 'Mystery']);
  assert.ok(r.entries.every((e) => e.source === 'manual'));
  const eggs = r.entries.find((e) => e.id === 'egg');
  assert.equal(eggs.unit, 'piece');
  assert.equal(eggs.gramsPerUnit, 55);
  assert.equal(r.entries.find((e) => e.name === 'Milk').unit, 'ml');
  assert.equal(r.entries.find((e) => e.name === 'Milk').category, 'Dairy & eggs');
  assert.equal(r.entries.find((e) => e.name === 'Dish soap').kcal, 0);
  assert.equal(r.entries.find((e) => e.name === 'Oats').kcal, 380);
  assert.deepEqual(r.skipped.map((s) => s.name), ['Magic bar']);
  assert.equal(r.review, 1);
});

test('nothing to convert is fine', () => {
  assert.deepEqual(convertNutriNutrition(undefined), { entries: [], skipped: [], review: 0, flagged: new Map() });
  assert.deepEqual(convertNutriNutrition([[], [''], null]).entries, []);
});

function fakeSheets({ source, target }) {
  const written = [];
  const orig = { ...SheetsApi };
  SheetsApi.getValues = async (id, range) => {
    const tab = range.split('!')[0];
    if (!source[tab]) throw new Error('Unable to parse range: ' + range);
    return source[tab];
  };
  SheetsApi.ensureSchema = async () => {};
  SheetsApi.getTabData = async (id, tab) => target[tab] || [];
  SheetsApi.appendRows = async (id, tab, rows) => { written.push({ tab, rows }); target[tab] = [...(target[tab] || []), ...rows]; };
  SheetsApi.batchUpdateRows = async (id, tab, updates) => { written.push({ tab, updates, kind: 'update' }); };
  return { written, restore: () => Object.assign(SheetsApi, orig) };
}

const GROCERIES = [['10', 'Oats', '500', '3,50', '1', 'L1', '', '', '']];
const LOCATIONS = [['Metro', 0, 'L1', 'false', 'Montreal']];

test('importing writes stores, items and nutrition, and a second run adds nothing', async () => {
  const f = fakeSheets({ source: { Groceries: GROCERIES, Locations: LOCATIONS, Nutrition: NUTRI_ROWS }, target: {} });
  try {
    const first = await importFromNutri('target', 'source');
    assert.equal(first.stores, 1);
    assert.equal(first.items, 1);
    assert.equal(first.nutrition, 5);
    assert.equal(first.nutritionSkipped, 1);
    assert.equal(first.nutritionReview, 1);
    const nutritionWrite = f.written.find((w) => w.tab === TABS.NUTRITION);
    assert.equal(nutritionWrite.rows.length, 5);
    assert.equal(rowToNutrition(nutritionWrite.rows[0]).id, 'oat');

    const second = await importFromNutri('target', 'source');
    assert.equal(second.stores + second.items + second.nutrition, 0);
    assert.equal(second.datesFixed, 0);
    assert.equal(second.skipped, 1 + 1 + 5);
  } finally { f.restore(); }
});

test('existing nutrition entries of the group are never overwritten', async () => {
  const mine = ['oat', 'Oats', 999, 1, 1, 1, 'Grains & bread', 'g', 1, 'manual'];
  const f = fakeSheets({ source: { Groceries: GROCERIES, Locations: LOCATIONS, Nutrition: NUTRI_ROWS }, target: { [TABS.NUTRITION]: [mine] } });
  try {
    const r = await importFromNutri('target', 'source');
    assert.equal(r.nutrition, 4);
    const names = f.written.find((w) => w.tab === TABS.NUTRITION).rows.map((row) => row[1]);
    assert.ok(!names.includes('Oats'));
  } finally { f.restore(); }
});

test('an old sheet without a Nutrition tab still imports', async () => {
  const f = fakeSheets({ source: { Groceries: GROCERIES, Locations: LOCATIONS }, target: {} });
  try {
    const r = await importFromNutri('target', 'source');
    assert.equal(r.items, 1);
    assert.equal(r.nutrition, 0);
    assert.ok(!f.written.some((w) => w.tab === TABS.NUTRITION));
  } finally { f.restore(); }
});

test('a sheet with nothing from Nutri is refused', async () => {
  const f = fakeSheets({ source: { Groceries: [], Locations: [] }, target: {} });
  try {
    await assert.rejects(() => importFromNutri('target', 'source'), /no Groceries, Locations or Nutrition data/);
  } finally { f.restore(); }
});

test('doubtful imports are explained, and the same rules flag saved entries later', async () => {
  const rows = [
    ['Bun', 250, 8, 45, 3, 'Bread', 'piece', 1],            // piece without a weight
    ['Roll', 250, 8, 45, 3, 'Bread', 'pcs', 1],              // same reason
    ['Cake', 600, 2, 2, 2, 'Sweets', 'g', 1],               // calories not matching the macros
    ['Gin', 230, 0, 0, 0, 'Drinks', 'ml', 1],                // alcohol: calories without macros are normal
    ['Thing', 100, 5, 10, 3, 'Odd', 'g', 1],                 // unknown category
    ['Oats', 380, 13, 60, 7, 'Grains', 'g', 1],              // fine
  ];
  const f = fakeSheets({ source: { Groceries: GROCERIES, Locations: LOCATIONS, Nutrition: rows }, target: {} });
  try {
    const r = await importFromNutri('target', 'source');
    assert.equal(r.nutrition, 6);
    assert.equal(r.nutritionReview, 4);
    assert.deepEqual(r.nutritionReasons, { 'pieces without a weight': 2, 'calories not matching the macros': 1, 'unknown category': 1 });
  } finally { f.restore(); }
  const bun = convertNutriNutrition(rows).entries[0];
  assert.equal(problemKind(entryProblems(bun)[0]), 'pieces without a weight');
  assert.deepEqual(entryProblems({ ...bun, gramsPerUnit: 60 }), []);
});

test('re-import corrects a Nutri purchase date that was stored as the local evening before', async () => {
  const epoch = Date.parse('2026-07-01T00:00:00.000Z');
  const groceries = [['g1', 'Milk', '1', '3,50', 0, 'L1', epoch, '']];
  const already = [['n_g1', 'Milk', '1', 3.5, 'n_L1', 0, "'2026-06-30", '', '2026-06-30T12:00:00.000Z', '', '']];
  const f = fakeSheets({
    source: { Groceries: groceries, Locations: LOCATIONS, Nutrition: [] },
    target: { [TABS.ITEMS]: already, [TABS.STORES]: [['n_L1', 'Metro', '', 0, '', '']] },
  });
  try {
    const r = await importFromNutri('target', 'source');
    assert.equal(r.items, 0);
    assert.equal(r.datesFixed, 1);
    const upd = f.written.find((w) => w.kind === 'update');
    assert.equal(upd.updates[0].values[6], "'2026-07-01");
  } finally { f.restore(); }
});
