// Product prices are compared per 100 g (or per piece), not per purchase: a bigger pack must not look dearer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { productStats, defaultMeasure, quantityNumber } from '../groceryLogic.js';
import { nutritionLookup, nutritionMeasure, readLookup, STAPLES } from '../nutritionLogic.js';

const item = (o) => ({ id: 'i' + Math.random(), title: 'Rice', quantity: '', price: null, paidAmount: null, paidCurrency: '', storeId: '', order: 0, checkedDate: '2026-10-01', notes: '', createdAt: '', ...o });
const nameOf = (id) => ({ a: 'Metro', b: 'Costco' }[id] || '');

test('quantities read as numbers', () => {
  assert.equal(quantityNumber('500'), 500);
  assert.equal(quantityNumber('1,5'), 1.5);
  for (const q of ['', '  ', '0', 'a few', null, undefined]) assert.equal(quantityNumber(q), null);
});

test('default measure: 10 and up is weight or volume, small is pieces, empty is one piece, old text is unknown', () => {
  assert.deepEqual(defaultMeasure(item({ quantity: '500' })), { basis: 'wt', amount: 500 });
  assert.deepEqual(defaultMeasure(item({ quantity: '4' })), { basis: 'piece', amount: 4 });
  assert.deepEqual(defaultMeasure(item({ quantity: '' })), { basis: 'piece', amount: 1 });
  assert.equal(defaultMeasure(item({ quantity: 'a few' })), null);
});

test('a bigger pack at a lower price per 100 g wins, even though it costs more', () => {
  const [p] = productStats([
    item({ quantity: '500', price: 2.5, storeId: 'a' }),   // 0.50 per 100 g
    item({ quantity: '2000', price: 8, storeId: 'b' }),    // 0.40 per 100 g
  ], nameOf);
  assert.equal(p.unit.label, 'per 100 g or ml');
  assert.equal(p.cheapestStoreId, 'b');
  assert.equal(p.byStore[0].storeId, 'b');
  assert.equal(p.byStore[0].unitAvg, 0.4);
  assert.equal(p.byStore[1].unitAvg, 0.5);
  // The plain average price would have picked the smaller pack's store.
  assert.ok(p.byStore.find((s) => s.storeId === 'a').avg < p.byStore.find((s) => s.storeId === 'b').avg);
  assert.equal(p.unitMin, 0.4);
  assert.equal(p.unitMax, 0.5);
});

test('pieces are compared per piece', () => {
  const [p] = productStats([
    item({ title: 'Eggs', quantity: '2', price: 1, storeId: 'a' }),   // 0.50 each
    item({ title: 'Eggs', quantity: '4', price: 1.8, storeId: 'b' }), // 0.45 each
  ], nameOf);
  assert.equal(p.unit.label, 'per piece');
  assert.equal(p.cheapestStoreId, 'b');
  assert.equal(p.unitAvg, 0.475);
});

test('a dozen of something counted in pieces stays pieces when nutrition data says so', () => {
  const eggs = { id: 'egg', name: 'Eggs', kcal: 143, protein: 12.6, carbs: 0.7, fat: 9.5, category: 'Dairy & eggs', unit: 'piece', gramsPerUnit: 0, source: 'manual' };
  const measure = nutritionMeasure(nutritionLookup([eggs]));
  assert.deepEqual(measure(item({ title: 'Eggs', quantity: '12' })), { basis: 'piece', amount: 12 });
  const [p] = productStats([
    item({ title: 'Eggs', quantity: '6', price: 3, storeId: 'a' }),
    item({ title: 'Eggs', quantity: '12', price: 5.4, storeId: 'b' }),
  ], nameOf, measure);
  assert.equal(p.unit.label, 'per piece');
  assert.equal(p.cheapestStoreId, 'b');
});

test('purchases bought another way are left out and counted', () => {
  const [p] = productStats([
    item({ quantity: '500', price: 2.5, storeId: 'a' }),
    item({ quantity: '1000', price: 4, storeId: 'b' }),
    item({ quantity: '2', price: 3, storeId: 'a' }),          // pieces: not comparable with grams
    item({ quantity: 'a lot', price: 3, storeId: 'a' }),       // unknown
  ], nameOf);
  assert.equal(p.unit.basis, 'wt');
  assert.equal(p.unitSkipped, 2);
  assert.equal(p.priced, 4);
});

test('unpriced purchases do not make a comparison, and one store alone is never "cheapest"', () => {
  const [p] = productStats([item({ quantity: '500', price: null, storeId: 'a' }), item({ quantity: '500', price: 2, storeId: 'b' })], nameOf);
  assert.equal(p.cheapestStoreId, null);
  const [none] = productStats([item({ price: null })], nameOf);
  assert.equal(none.unit, null);
  assert.equal(none.unitAvg, null);
});

test('without quantities the unit price is the price (nothing changes for simple lists)', () => {
  const [p] = productStats([item({ title: 'Salt', price: 1, storeId: 'a' }), item({ title: 'Salt', price: 2, storeId: 'b' })], nameOf);
  assert.equal(p.unit.basis, 'piece');
  assert.equal(p.unitAvg, p.avg);
  assert.equal(p.cheapestStoreId, 'a');
});

test('with nutrition data the amount is known: grams, millilitres and piece weights', () => {
  const entries = [
    { id: 'rice', name: 'Rice', kcal: 350, protein: 7, carbs: 78, fat: 1, category: 'Grains & bread', unit: 'g', gramsPerUnit: 0, source: 'manual' },
    { id: 'milk', name: 'Milk', kcal: 46, protein: 3.4, carbs: 5, fat: 1.5, category: 'Dairy & eggs', unit: 'ml', gramsPerUnit: 0, source: 'manual' },
    { id: 'tomato', name: 'Tomato', kcal: 18, protein: 0.9, carbs: 3.9, fat: 0.2, category: 'Vegetables', unit: 'g', gramsPerUnit: 120, source: 'manual' },
    { id: 'soap', name: 'Soap', kcal: 0, protein: 0, carbs: 0, fat: 0, category: 'Non-food', unit: 'g', gramsPerUnit: 0, source: 'manual' },
  ];
  const measure = nutritionMeasure(nutritionLookup(entries));
  assert.deepEqual(measure(item({ title: 'Rice', quantity: '500' })), { basis: 'g', amount: 500 });
  assert.deepEqual(measure(item({ title: 'Milk', quantity: '1000' })), { basis: 'ml', amount: 1000 });
  assert.deepEqual(measure(item({ title: 'Tomato', quantity: '4' })), { basis: 'piece', amount: 4, grams: 480 }); // logged as pieces
  assert.deepEqual(measure(item({ title: 'Tomato', quantity: '1000' })), { basis: 'g', amount: 1000, pieces: 1000 / 120 });
  // Unknown products and ambiguous quantities fall back to the default reading.
  assert.deepEqual(measure(item({ title: 'Zorblax', quantity: '500' })), { basis: 'wt', amount: 500 });
  assert.deepEqual(measure(item({ title: 'Rice', quantity: '2' })), { basis: 'piece', amount: 2 });
  // Non-food counts things, however large the number (30 rolls of toilet paper).
  assert.deepEqual(measure(item({ title: 'Soap', quantity: '300' })), { basis: 'piece', amount: 300 });

  const [p] = productStats([
    item({ title: 'Tomato', quantity: '4', price: 2.4, storeId: 'a' }),   // 480 g -> 0.50 per 100 g
    item({ title: 'Tomato', quantity: '1000', price: 4, storeId: 'b' }),  // 1000 g -> 0.40 per 100 g
  ], nameOf, measure);
  assert.equal(p.unit.label, 'per 100 g');
  assert.equal(p.cheapestStoreId, 'b');
});

test('read lookup adds built-in staples in memory without touching the sheet entries', () => {
  const entries = [];
  const lookup = readLookup(entries, ['Oats', 'Zorblax']);
  assert.ok(lookup.size >= 1);
  assert.equal(entries.length, 0);
  assert.ok(STAPLES.size > 0 || Object.keys(STAPLES).length > 0);
});

test('eggs logged as pieces are priced per piece, even though a piece weight is known', () => {
  const eggs = { id: 'egg', name: 'Eggs', kcal: 143, protein: 12.6, carbs: 0.7, fat: 9.5, category: 'Dairy & eggs', unit: 'piece', gramsPerUnit: 50, source: 'built-in' };
  const measure = nutritionMeasure(nutritionLookup([eggs]));
  assert.deepEqual(measure(item({ title: 'Eggs', quantity: '12' })), { basis: 'piece', amount: 12, grams: 600 });
  assert.deepEqual(measure(item({ title: 'Eggs', quantity: '' })), { basis: 'piece', amount: 1, grams: 50 });
  const [p] = productStats([
    item({ title: 'Eggs', quantity: '6', price: 3, storeId: 'a' }),
    item({ title: 'Eggs', quantity: '12', price: 5.4, storeId: 'b' }),
  ], nameOf, measure);
  assert.equal(p.unit.basis, 'piece');
  assert.equal(p.unit.label, 'per piece');
  assert.equal(p.cheapestStoreId, 'b');
  assert.equal(p.unitAvg, 0.475);
});

test('a small number with a piece weight is pieces (Bananas 6), a big one is weight', () => {
  const banana = { id: 'banana', name: 'Bananas', kcal: 89, protein: 1.1, carbs: 22.8, fat: 0.3, category: 'Fruit', unit: 'g', gramsPerUnit: 120, source: 'built-in' };
  const measure = nutritionMeasure(nutritionLookup([banana]));
  assert.equal(measure(item({ title: 'Bananas', quantity: '6' })).basis, 'piece');
  assert.equal(measure(item({ title: 'Bananas', quantity: '1000' })).basis, 'g');
  const [p] = productStats([item({ title: 'Bananas', quantity: '6', price: 2.1, storeId: 'a' }), item({ title: 'Bananas', quantity: '4', price: 1.2, storeId: 'b' })], nameOf, measure);
  assert.equal(p.unit.label, 'per piece');
  assert.equal(p.cheapestStoreId, 'b');
});

test('mixed purchases of one product are converted with the piece weight instead of dropped', () => {
  const banana = { id: 'banana', name: 'Bananas', kcal: 89, protein: 1.1, carbs: 22.8, fat: 0.3, category: 'Fruit', unit: 'g', gramsPerUnit: 100, source: 'built-in' };
  const measure = nutritionMeasure(nutritionLookup([banana]));
  const [p] = productStats([
    item({ title: 'Bananas', quantity: '6', price: 3, storeId: 'a' }),      // pieces: 0.50 each
    item({ title: 'Bananas', quantity: '4', price: 2.4, storeId: 'a' }),    // pieces: 0.60 each
    item({ title: 'Bananas', quantity: '1000', price: 4, storeId: 'b' }),   // 10 pieces: 0.40 each
  ], nameOf, measure);
  assert.equal(p.unit.label, 'per piece');
  assert.equal(p.unitSkipped, 0);
  assert.equal(p.unitConverted, 1);
  assert.equal(p.gramsPerPiece, 100);
  assert.equal(p.cheapestStoreId, 'b');
});

test('the other way round: mostly kilos, one bunch of pieces converted to grams', () => {
  const apple = { id: 'apple', name: 'Apples', kcal: 52, protein: 0.3, carbs: 13.8, fat: 0.2, category: 'Fruit', unit: 'g', gramsPerUnit: 180, source: 'built-in' };
  const measure = nutritionMeasure(nutritionLookup([apple]));
  const [p] = productStats([
    item({ title: 'Apples', quantity: '1500', price: 5.5, storeId: 'b' }),  // 0.37 per 100 g
    item({ title: 'Apples', quantity: '1000', price: 4, storeId: 'b' }),
    item({ title: 'Apples', quantity: '6', price: 5.5, storeId: 'a' }),    // 1080 g: 0.51 per 100 g
  ], nameOf, measure);
  assert.equal(p.unit.label, 'per 100 g');
  assert.equal(p.unitConverted, 1);
  assert.equal(p.gramsPerPiece, 180);
  assert.equal(p.cheapestStoreId, 'b');
  assert.equal(p.byStore.find((s) => s.storeId === 'a').unitAvg, 0.5093);
});

test('a product bought consistently needs no conversion note', () => {
  const [p] = productStats([item({ quantity: '500', price: 2, storeId: 'a' }), item({ quantity: '1000', price: 3, storeId: 'b' })], nameOf);
  assert.equal(p.unitConverted, 0);
  assert.equal(p.gramsPerPiece, 0);
});

test('weight and piece readings that cannot be converted are left out and counted', () => {
  const [p] = productStats([
    item({ quantity: '500', price: 2.5, storeId: 'a' }),
    item({ quantity: '2', price: 3, storeId: 'b' }),   // pieces, no piece weight known
    item({ quantity: '800', price: 4, storeId: 'b' }),
  ], nameOf);
  assert.equal(p.unit.basis, 'wt');
  assert.equal(p.unitSkipped, 1);
});