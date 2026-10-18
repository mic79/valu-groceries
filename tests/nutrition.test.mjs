// Unit tests for the nutrition logic: names, built-in staples, quantities, statistics, import parsing and checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  nutritionKey, matchEntry, STAPLES, missingStaples, quantityToGrams, purchaseNutrition, nutritionStats, monthlyKcal, yearlyKcal,
  validateEntry, parseNutritionImport, buildNutritionPrompt, toNumber, normalizeCategory, daysInRange,
  rowToNutrition, nutritionToRow, nutritionLookup, NUTRITION_HEADERS, NUTRITION_CATEGORIES,
} from '../nutritionLogic.js';

const entry = (o) => ({ id: nutritionKey(o.name), name: 'X', kcal: 100, protein: 10, carbs: 10, fat: 5, category: 'Other food', unit: 'g', gramsPerUnit: 1, source: '', ...o });
const item = (o) => ({ id: 'i' + Math.random(), title: 'Milk', quantity: '', checkedDate: '2026-10-05', ...o });

test('names: singular and plural are the same product', () => {
  assert.equal(nutritionKey('Tomatoes'), nutritionKey('tomato'));
  assert.equal(nutritionKey('Berries'), nutritionKey('berry'));
  assert.equal(nutritionKey('Peaches'), nutritionKey('peach'));
  assert.equal(nutritionKey('  Olive   Oil '), 'olive oil');
  assert.equal(nutritionKey('Hummus'), 'hummus');
  assert.equal(nutritionKey('!!'), '');
});

test('matching: exact, without filler words, and by the END of the name only', () => {
  const lookup = new Map([['banana', 'B'], ['tomato sauce', 'TS'], ['bread', 'BR']]);
  assert.equal(matchEntry('Bananas', lookup), 'B');
  assert.equal(matchEntry('Organic bananas', lookup), 'B');
  assert.equal(matchEntry('Spicy tomato sauce', lookup), 'TS');
  assert.equal(matchEntry('Whole wheat bread', lookup), 'BR');
  assert.equal(matchEntry('Banana bread', lookup), 'BR', 'the last words decide');
  assert.equal(matchEntry('Banana chips', lookup), null);
  assert.equal(matchEntry('Apple pie', new Map([['apple', 'A']])), null);
  assert.equal(matchEntry('', lookup), null);
});

test('built-in staples cover the usual groceries and flag household items as non-food', () => {
  const food = ['Oats', 'Butter', 'Carrots', 'Tomato sauce', 'Eggs', 'Yogurt', 'Tomatoes', 'Pasta', 'Olive oil', 'Cheddar', 'Salmon fillets', 'Bananas', 'Spinach', 'Milk',
    'Coffee beans', 'Frozen berries', 'Ground beef', 'Bread', 'Chicken thighs', 'Apples', 'Rice', 'Orange juice', 'Baguette', 'Camembert', 'Croissants', 'Red wine'];
  assert.deepEqual(food.filter((n) => !matchEntry(n, STAPLES)), []);
  for (const n of ['Toilet paper', 'Dish soap']) assert.equal(matchEntry(n, STAPLES).category, 'Non-food');
  assert.equal(matchEntry('Almond milk', STAPLES).kcal, 15, 'a specific entry beats the general one');
  assert.equal(matchEntry('Milk', STAPLES).unit, 'ml');
  assert.equal(matchEntry('Eggs', STAPLES).unit, 'piece');
});

test('built-in staples are internally consistent', () => {
  const bad = [];
  for (const [key, s] of STAPLES) {
    if (!NUTRITION_CATEGORIES.includes(s.category)) bad.push(key + ': category');
    if (s.category !== 'Non-food') {
      const v = validateEntry({ name: key, ...s, gramsPerUnit: s.gramsPerUnit });
      if (v.status === 'error') bad.push(key + ': ' + v.problems.join(', '));
    }
    if (s.unit === 'piece' && !(s.gramsPerUnit > 1)) bad.push(key + ': piece weight');
  }
  assert.deepEqual(bad, []);
});

test('missing staples: only names the sheet lacks, one row per name, keyed by the name as used', () => {
  const lookup = nutritionLookup([entry({ name: 'Bananas', kcal: 90 })]);
  const added = missingStaples(['Bananas', 'Eggs', 'eggs', 'Toilet paper', 'Zorblax'], lookup);
  assert.deepEqual(added.map((e) => e.id).sort(), ['egg', 'toilet paper']);
  assert.equal(added.find((e) => e.id === 'egg').source, 'built-in');
  assert.equal(added.find((e) => e.id === 'egg').name, 'Eggs');
});

test('quantity to grams: pieces, amounts and the ambiguous small numbers', () => {
  const egg = entry({ unit: 'piece', gramsPerUnit: 50 });
  assert.equal(quantityToGrams('12', egg), 600);
  assert.equal(quantityToGrams('', egg), 50, 'no quantity = one piece');
  assert.equal(quantityToGrams('1,5', egg), 75);
  assert.equal(quantityToGrams('3', entry({ unit: 'piece', gramsPerUnit: 1 })), null, 'a piece without a weight is unknown');
  const milk = entry({ unit: 'ml', gramsPerUnit: 1 });
  assert.equal(quantityToGrams('2000', milk), 2000);
  assert.equal(quantityToGrams('2', milk), null, '2 could be litres: not guessed');
  assert.equal(quantityToGrams('', milk), null);
  const tomato = entry({ unit: 'g', gramsPerUnit: 120 });
  assert.equal(quantityToGrams('4', tomato), 480, 'a small number with a piece weight means pieces');
  assert.equal(quantityToGrams('500', tomato), 500);
  const n = purchaseNutrition({ quantity: '200' }, entry({ kcal: 50, protein: 2, carbs: 10, fat: 1 }));
  assert.deepEqual([n.grams, n.kcal, n.protein, n.carbs, n.fat], [200, 100, 4, 20, 2]);
});

test('statistics: totals, shares, categories and an honest account of what was left out', () => {
  const lookup = nutritionLookup([
    entry({ name: 'Rice', kcal: 360, protein: 7, carbs: 79, fat: 0.6, category: 'Grains & bread' }),
    entry({ name: 'Eggs', kcal: 143, protein: 12.6, carbs: 0.7, fat: 9.5, category: 'Dairy & eggs', unit: 'piece', gramsPerUnit: 50 }),
    entry({ name: 'Soap', kcal: 0, protein: 0, carbs: 0, fat: 0, category: 'Non-food' }),
    entry({ name: 'Milk', kcal: 50, protein: 3.3, carbs: 4.8, fat: 2, category: 'Dairy & eggs', unit: 'ml' }),
  ]);
  const items = [
    item({ title: 'Rice', quantity: '1000' }),
    item({ title: 'Eggs', quantity: '10' }),
    item({ title: 'Soap', quantity: '1' }),
    item({ title: 'Milk', quantity: '2' }),
    item({ title: 'Mystery sauce', quantity: '300' }),
    item({ title: 'Mystery sauce', quantity: '100' }),
    item({ title: 'Rice', quantity: '500', checkedDate: '2026-09-01' }),
    item({ title: 'Rice', quantity: '500', checkedDate: '' }),
  ];
  const s = nutritionStats(items, lookup, { from: '2026-10-01', to: '2026-10-31' }, '2026-10-15');
  assert.equal(s.purchases, 6);
  assert.equal(s.counted, 2);
  assert.equal(s.nonFood, 1);
  assert.equal(s.unquantified.length, 1);
  assert.deepEqual(s.unmatched.map((u) => [u.title, u.count]), [['Mystery sauce', 2]]);
  assert.equal(Math.round(s.totals.kcal), 3600 + 715);
  assert.equal(s.days, 15);
  assert.equal(Math.round(s.perDay), Math.round((3600 + 715) / 15));
  assert.equal(s.categories[0].name, 'Grains & bread');
  assert.ok(Math.abs(s.categories[0].pct + s.categories[1].pct - 1) < 1e-9);
  assert.ok(Math.abs(s.share.protein + s.share.carbs + s.share.fat - 1) < 1e-9);
  assert.equal(Math.round(s.coverage * 100), Math.round((2 / (2 + 1 + 2)) * 100));
  assert.equal(s.products[0].title, 'Rice', 'products carry the entry name, biggest first');
});

test('statistics: nothing bought, nothing to divide by', () => {
  const s = nutritionStats([], new Map(), { from: '2026-10-01', to: '2026-10-31' }, '2026-10-15');
  assert.equal(s.totals.kcal, 0);
  assert.equal(s.coverage, 1);
  assert.deepEqual(s.share, { protein: 0, carbs: 0, fat: 0 });
});

test('monthly calories', () => {
  const lookup = nutritionLookup([entry({ name: 'Rice', kcal: 100, protein: 0, carbs: 25, fat: 0 })]);
  const items = [item({ title: 'Rice', quantity: '1000', checkedDate: '2026-09-02' }), item({ title: 'Rice', quantity: '500', checkedDate: '2026-10-02' }), item({ title: 'Unknown', quantity: '5', checkedDate: '2026-10-03' })];
  assert.deepEqual(monthlyKcal(items, lookup, ['2026-08', '2026-09', '2026-10']).map((m) => Math.round(m.kcal)), [0, 1000, 500]);
});

test('days in a period never count the future', () => {
  assert.equal(daysInRange('2026-10-01', '2026-10-31', '2026-10-15'), 15);
  assert.equal(daysInRange('2026-09-01', '2026-09-30', '2026-10-15'), 30);
  assert.equal(daysInRange('2026-11-01', '2026-11-30', '2026-10-15'), 1);
});

test('checking an entry: impossible values are errors, odd ones are flagged, non-food is zeroed', () => {
  const good = validateEntry({ name: 'Rice', kcal: 360, protein: 7, carbs: 79, fat: 0.6, category: 'grain', unit: 'g', gramsPerUnit: 1 });
  assert.equal(good.status, 'ok');
  assert.equal(good.entry.category, 'Grains & bread');
  assert.equal(good.entry.id, 'rice');
  assert.equal(validateEntry({ name: 'Magic', kcal: 1200, protein: 1, carbs: 1, fat: 1 }).status, 'error');
  assert.equal(validateEntry({ name: 'Magic', kcal: 100, protein: 60, carbs: 50, fat: 1 }).status, 'error');
  assert.equal(validateEntry({ name: 'Magic', kcal: 100, protein: -1, carbs: 5, fat: 1 }).status, 'error');
  assert.equal(validateEntry({ name: '', kcal: 100, protein: 1, carbs: 5, fat: 1 }).status, 'error');
  assert.equal(validateEntry({ name: 'Void' }).status, 'error');
  const off = validateEntry({ name: 'Weird', kcal: 600, protein: 1, carbs: 5, fat: 1, category: 'Fruit', unit: 'g' });
  assert.equal(off.status, 'review');
  assert.match(off.problems[0], /do not match/);
  const piece = validateEntry({ name: 'Egg', kcal: 143, protein: 12.6, carbs: 0.7, fat: 9.5, category: 'Dairy & eggs', unit: 'pcs', gramsPerUnit: 50 });
  assert.equal(piece.status, 'ok');
  assert.equal(piece.entry.unit, 'piece');
  assert.equal(validateEntry({ name: 'Egg', kcal: 143, protein: 12.6, carbs: 0.7, fat: 9.5, category: 'Dairy & eggs', unit: 'piece' }).status, 'review');
  const soap = validateEntry({ name: 'Soap', kcal: 50, category: 'household' });
  assert.equal(soap.status, 'ok');
  assert.deepEqual([soap.entry.category, soap.entry.kcal], ['Non-food', 0]);
  assert.equal(validateEntry({ name: 'Odd', kcal: 100, protein: 5, carbs: 10, fat: 4, category: 'Banana stuff' }).entry.category, 'Other food');
});

test('numbers in all the ways an assistant writes them', () => {
  assert.equal(toNumber('89'), 89);
  assert.equal(toNumber('89.5 kcal'), 89.5);
  assert.equal(toNumber('89,5'), 89.5);
  assert.equal(toNumber('~120'), 120);
  assert.equal(toNumber('1,234.5'), 1234.5);
  assert.equal(toNumber('1.234,5'), 1234.5);
  assert.equal(toNumber(''), null);
  assert.equal(toNumber('n/a'), null);
  assert.equal(normalizeCategory('Meat'), 'Meat & fish');
  assert.equal(normalizeCategory('non-food'), 'Non-food');
  assert.equal(normalizeCategory('???'), null);
});

const ASKED = ['Bananas', 'Eggs', 'Soap', 'Mystery'];

test('import: a code fence, chatter and quoted names are fine', () => {
  const text = [
    'Sure! Here is the table:', '', '```csv',
    'name,kcal,protein,carbs,fat,category,unit,grams_per_unit',
    'Bananas,89,1.1,22.8,0.3,Fruit,piece,120',
    '"Eggs",143,12.6,0.7,9.5,Dairy & eggs,piece,50',
    'Soap,0,0,0,0,Non-food,g,1',
    '```', 'Let me know if you need more!',
  ].join('\n');
  const r = parseNutritionImport(text, ASKED);
  assert.equal(r.rows.length, 3);
  assert.deepEqual(r.rows.map((x) => x.status), ['ok', 'ok', 'ok']);
  assert.deepEqual(r.rows.map((x) => x.entry.id), ['banana', 'egg', 'soap']);
  assert.deepEqual(r.unanswered, ['Mystery']);
  assert.equal(r.rows[0].entry.source, 'AI');
  assert.ok(r.ignored >= 2, 'the chatter lines are ignored');
});

test('import: markdown tables, semicolons with decimal commas and columns in another order', () => {
  const table = ['| Name | Kcal | Protein | Carbs | Fat | Category | Unit | Grams per unit |', '|---|---|---|---|---|---|---|---|', '| Bananas | 89 | 1.1 | 22.8 | 0.3 | Fruit | piece | 120 |'].join('\n');
  const a = parseNutritionImport(table, ASKED);
  assert.deepEqual([a.rows.length, a.rows[0].status, a.rows[0].entry.gramsPerUnit], [1, 'ok', 120]);

  const semi = ['name;kcal;protein;carbs;fat;category;unit;grams_per_unit', 'Bananas;89,0;1,1;22,8;0,3;Fruit;piece;120'].join('\n');
  const b = parseNutritionImport(semi, ASKED);
  assert.deepEqual([b.rows[0].entry.kcal, b.rows[0].entry.protein, b.rows[0].status], [89, 1.1, 'ok']);

  const shuffled = ['category,name,fat,carbs,protein,kcal,unit', 'Fruit,Bananas,0.3,22.8,1.1,89,piece'].join('\n');
  const c = parseNutritionImport(shuffled, ASKED);
  assert.deepEqual([c.rows[0].entry.kcal, c.rows[0].entry.fat, c.rows[0].entry.unit], [89, 0.3, 'piece']);
});

test('import: without a header the default column order is used', () => {
  const r = parseNutritionImport('Bananas,89,1.1,22.8,0.3,Fruit,piece,120', ASKED);
  assert.deepEqual([r.rows.length, r.rows[0].entry.carbs, r.rows[0].status], [1, 22.8, 'ok']);
});

test('import: bad rows are reported, never silently imported', () => {
  const text = [
    'name,kcal,protein,carbs,fat,category,unit,grams_per_unit',
    'Bananas,89000,1.1,22.8,0.3,Fruit,piece,120',
    'Something else,50,1,5,1,Fruit,g,1',
    'Eggs,143,12.6,0.7,9.5,Dairy & eggs,piece,50',
  ].join('\n');
  const r = parseNutritionImport(text, ASKED);
  assert.deepEqual(r.rows.map((x) => x.status), ['error', 'error', 'ok']);
  assert.match(r.rows[1].problems.join(' '), /Not one of the products/);
  assert.deepEqual(r.unanswered.sort(), ['Bananas', 'Mystery', 'Soap']);
  assert.deepEqual(parseNutritionImport('hello world', ASKED).rows, []);
});

test('import: answers are matched back to the names that were asked, even when slightly changed', () => {
  const r = parseNutritionImport('name,kcal,protein,carbs,fat,category,unit,grams_per_unit\nbanana,89,1.1,22.8,0.3,Fruit,piece,120', ['Organic Bananas']);
  assert.equal(r.rows[0].status, 'ok');
  assert.equal(r.rows[0].entry.name, 'Organic Bananas');
  assert.equal(r.rows[0].entry.id, 'organic banana');
});

test('the prompt contains every name, the header and the category list', () => {
  const p = buildNutritionPrompt(['Bananas', 'Eggs']);
  assert.match(p, /name,kcal,protein,carbs,fat,category,unit,grams_per_unit/);
  assert.match(p, /Bananas\nEggs$/);
  for (const c of NUTRITION_CATEGORIES) assert.ok(p.includes(c));
  // The prompt must ask for exactly what the importer reads.
  const answer = 'name,kcal,protein,carbs,fat,category,unit,grams_per_unit\nBananas,89,1.1,22.8,0.3,Fruit,piece,120';
  assert.equal(parseNutritionImport(answer, ['Bananas', 'Eggs']).rows[0].status, 'ok');
});

test('sheet rows round trip', () => {
  assert.equal(NUTRITION_HEADERS.length, 10);
  const e = entry({ name: 'Greek yogurt', kcal: 97, protein: 9, carbs: 3.9, fat: 5, category: 'Dairy & eggs', unit: 'g', gramsPerUnit: 1, source: 'AI' });
  const row = nutritionToRow(e);
  assert.equal(row.length, NUTRITION_HEADERS.length);
  assert.deepEqual(rowToNutrition(row), { ...e, id: 'greek yogurt' });
  const odd = rowToNutrition(['x', 'X', '', 'abc', '5,5', 7, 'Fruit', 'bogus', 0, '']);
  assert.deepEqual([odd.kcal, odd.protein, odd.carbs, odd.unit, odd.gramsPerUnit], [0, 0, 5.5, 'g', 1]);
});

test('an unquoted comma inside a product name does not shift the columns', () => {
  const name = 'Desconto (caixa devolveu CAD 1,00)';
  const text = 'name,kcal,protein,carbs,fat,category,unit,grams_per_unit\n' + name + ',0,0,0,0,Non-food,g,1S\nBananas,89,1.1,22.8,0.3,Fruit,piece,120';
  const r = parseNutritionImport(text, [name, 'Bananas']);
  assert.equal(r.rows.length, 2);
  const d = r.rows[0];
  assert.equal(d.status, 'ok');
  assert.deepEqual(d.problems, []);
  assert.equal(d.entry.name, name);
  assert.equal(d.entry.category, 'Non-food');
  assert.equal(d.entry.unit, 'g');
  assert.equal(r.rows[1].entry.name, 'Bananas');
  assert.deepEqual(r.unanswered, []);
  // Quoted names still work, and so does a row without a header.
  const q = parseNutritionImport('"Discount, CAD 1,00",0,0,0,0,Non-food,g,1');
  assert.equal(q.rows[0].entry.name, 'Discount, CAD 1,00');
  assert.equal(q.rows[0].entry.category, 'Non-food');
});

test('the request asks for names with commas to be quoted', () => {
  assert.match(buildNutritionPrompt(['a']), /comma, put the whole name in double quotes/);
});

test('yearly calories add up the purchases of each calendar year', () => {
  const lookup = nutritionLookup([{ id: 'rice', name: 'Rice', kcal: 360, protein: 7, carbs: 79, fat: 0.6, category: 'Grains & bread', unit: 'g', gramsPerUnit: 1 }]);
  const item = (d, q) => ({ id: d, title: 'Rice', quantity: String(q), checkedDate: d });
  const r = yearlyKcal([item('2023-12-31', 1000), item('2024-01-01', 500), item('2024-06-10', 500), item('2022-05-05', 1000), item('', 1000)], lookup, ['2023', '2024']);
  assert.deepEqual(r, [{ key: '2023', kcal: 3600 }, { key: '2024', kcal: 3600 }]);
});
