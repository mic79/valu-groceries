// Unit tests for the pure logic (no browser, no network).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  localDateISO, normalizeDate, dateFromEpochMs, isFutureDate, monthKey, parseAmount, roundMoney,
  sanitizeAmountText, flipSign, formatCurrency, cleanQuantity, sanitizeQuantityText, capitalizeFirst, parseCurrencyRates, textCell, rowToItem, itemToRow,
  rowToStore, storeToRow, pendingItems, nextOrder, sumPrices, groupCheckedByDate, reorderList,
  buildSuggestions, lastPurchase, buildTrips, copyForList, onListKeys, listKey,
  spendingByMonth, storeBreakdown, topItems, estimateCurrentMonth,
  convertNutriRows, guessBaseCurrency, ITEM_HEADERS, STORE_HEADERS,
} from '../groceryLogic.js';
import { formatDateLabel, formatMonthLabel } from '../dateLabels.js';

const item = (o) => ({ id: 'i' + Math.random(), title: 'Milk', quantity: '', price: null, paidAmount: null, paidCurrency: '', storeId: '', order: 0, checkedDate: '', notes: '', createdAt: '', ...o });

test('dates: normalise, epoch conversion, future check', () => {
  assert.equal(normalizeDate("'2026-10-17"), '2026-10-17');
  assert.equal(normalizeDate('2026-02-30'), '');
  assert.equal(normalizeDate('17/10/2026'), '');
  assert.equal(normalizeDate(undefined), '');
  assert.equal(localDateISO(new Date(2026, 0, 5)), '2026-01-05');
  assert.equal(dateFromEpochMs(new Date(2024, 4, 1, 12).getTime()), '2024-05-01');
  assert.equal(dateFromEpochMs(''), '');
  assert.equal(dateFromEpochMs(0), '');
  assert.equal(isFutureDate('2999-01-01'), true);
  assert.equal(isFutureDate('2000-01-01'), false);
  assert.equal(monthKey('2026-10-17'), '2026-10');
});

test('parseAmount understands both decimal styles', () => {
  assert.equal(parseAmount('12.5'), 12.5);
  assert.equal(parseAmount('12,5'), 12.5);
  assert.equal(parseAmount('1.234,56'), 1234.56);
  assert.equal(parseAmount('1,234.56'), 1234.56);
  assert.equal(parseAmount(7), 7);
  assert.ok(Number.isNaN(parseAmount('abc')));
  assert.ok(Number.isNaN(parseAmount('')));
  assert.equal(roundMoney(1.005), 1.01);
  assert.equal(roundMoney(2.675), 2.68);
  assert.equal(roundMoney(1.1 + 2.2), 3.3);
  assert.equal(roundMoney(-1.005), -1.01);
  assert.equal(roundMoney(0), 0);
});

test('sanitizeAmountText strips junk', () => {
  assert.equal(sanitizeAmountText('12a.5'), '12.5');
  assert.equal(sanitizeAmountText('--5'), '-5');
  assert.equal(sanitizeAmountText('1..2'), '1.2');
  assert.equal(sanitizeAmountText('$ 3,50'), '3,50');
});

test('small formatters', () => {
  // Quantity is free text: numbers, units and words all pass through; only whitespace and length are tidied.
  assert.equal(cleanQuantity(2), '2');
  assert.equal(cleanQuantity(1.5), '1.5');
  assert.equal(cleanQuantity(0), '');
  assert.equal(cleanQuantity(null), '');
  assert.equal(cleanQuantity('  500   ml '), '500 ml');
  assert.equal(cleanQuantity("'12"), '12');
  assert.equal(cleanQuantity('2 packs'), '2 packs');
  assert.equal(cleanQuantity('x'.repeat(100)).length, 40);
  assert.equal(capitalizeFirst('apples'), 'Apples');
  assert.deepEqual(parseCurrencyRates('USD:1.36,EUR:1.48'), [{ currency: 'USD', rate: '1.36' }, { currency: 'EUR', rate: '1.48' }]);
  assert.deepEqual(parseCurrencyRates(''), []);
});

test('textCell protects numeric-looking text from being converted by Sheets', () => {
  assert.equal(textCell('7'), "'7");
  assert.equal(textCell('2024-05-01'), "'2024-05-01");
  assert.equal(textCell('1,5'), "'1,5");
  assert.equal(textCell('Milk 2%'), 'Milk 2%');
  assert.equal(textCell('7up'), '7up');
  assert.equal(textCell(null), '');
});

test('item rows round-trip and survive what Sheets can return', () => {
  const it = item({ id: 'a', title: 'Milk', quantity: '2 L', price: 3.5, storeId: 's1', order: 4, checkedDate: '2026-10-01', notes: 'lactose free', createdAt: '2026-10-01T10:00:00.000Z' });
  const row = itemToRow(it);
  assert.equal(row.length, ITEM_HEADERS.length);
  assert.equal(row[2], '2 L');
  assert.equal(row[3], 3.5);
  assert.equal(row[6], "'2026-10-01");
  // Sheets returns text without the apostrophe, numbers as numbers (UNFORMATTED_VALUE).
  const back = rowToItem(['a', 'Milk', '2 L', 3.5, 's1', 4, '2026-10-01', 'lactose free', '2026-10-01T10:00:00.000Z']);
  assert.deepEqual(back, it);
});

test('quantity is stored as text so "12" or "1,5" are never reinterpreted, and old numeric cells still read', () => {
  assert.equal(itemToRow(item({ id: 'q', quantity: '12' }))[2], 12, 'a numeric quantity is stored as a real number');
  assert.equal(itemToRow(item({ id: 'q', quantity: '1,5' }))[2], 1.5, 'a decimal comma is read as a decimal');
  assert.equal(itemToRow(item({ id: 'q', quantity: '2 L' }))[2], '2 L', 'old text is kept as text');
  assert.equal(itemToRow(item({ id: 'q', quantity: '' }))[2], '');
  assert.equal(rowToItem(['q', 'Eggs', '12']).quantity, '12');
  assert.equal(rowToItem(['q', 'Eggs', 12]).quantity, '12');
  assert.equal(rowToItem(['q', 'Eggs', 1.5]).quantity, '1.5');
  assert.equal(rowToItem(['q', 'Eggs', '500 g']).quantity, '500 g');
});

test('amount paid in another currency is kept next to the converted price', () => {
  const it = item({ id: 'p', title: 'Camembert', price: 5.57, paidAmount: 3.5, paidCurrency: 'EUR' });
  const row = itemToRow(it);
  assert.deepEqual([row[3], row[9], row[10]], [5.57, 3.5, 'EUR']);
  const back = rowToItem(['p', 'Camembert', '', 5.57, '', 0, '', '', '', 3.5, 'EUR']);
  assert.deepEqual([back.price, back.paidAmount, back.paidCurrency], [5.57, 3.5, 'EUR']);
  // Old rows without the extra columns, or with junk in them, have no original amount.
  assert.deepEqual(rowToItem(['p', 'X', '', 2]).paidAmount, null);
  assert.deepEqual(rowToItem(['p', 'X', '', 2, '', 0, '', '', '', 3, 'euros']).paidCurrency, '');
  assert.deepEqual(itemToRow(item({ id: 'p', paidAmount: 3, paidCurrency: '' })).slice(9), ['', '']);
});

test('item rows: empty and odd values', () => {
  const blank = rowToItem(['x', 'Eggs']);
  assert.equal(blank.quantity, '');
  assert.equal(blank.price, null);
  assert.equal(blank.checkedDate, '');
  assert.equal(rowToItem(['x', 'Eggs', '', '', '', '', '', '', '']).price, null);
  assert.equal(rowToItem(['x', 'Eggs', 0]).quantity, '');
  assert.equal(rowToItem(['x', 'Eggs', 1, '4,25']).price, 4.25);
  assert.equal(rowToItem(['x', 'Eggs', 1, 0]).price, null, 'a 0,00 price means no price yet, like an empty cell');
  assert.equal(itemToRow(item({ id: 'z', price: null }))[3], '');
  assert.equal(itemToRow(item({ id: 'z', price: 1.005 }))[3], 1.01);
});

test('store rows round-trip', () => {
  const s = { id: 's1', name: 'Metro', city: 'Montreal', order: 2, hidden: true, currency: 'CAD' };
  const row = storeToRow(s);
  assert.equal(row.length, STORE_HEADERS.length);
  assert.deepEqual(rowToStore(row), s);
  assert.equal(rowToStore(['s2', 'X', '', 0, '', '']).hidden, false);
  assert.equal(rowToStore(['s2', 'X', '', 0, true, 'eur']).hidden, true);
  assert.equal(rowToStore(['s2', 'X', '', 0, '', 'eur']).currency, 'EUR');
});

test('pending list: per store, ordered, ticked items excluded', () => {
  const items = [
    item({ id: 'a', storeId: 's1', order: 2 }),
    item({ id: 'b', storeId: 's1', order: 1 }),
    item({ id: 'c', storeId: 's1', order: 0, checkedDate: '2026-10-01' }),
    item({ id: 'd', storeId: '', order: 0 }),
  ];
  assert.deepEqual(pendingItems(items, 's1').map((i) => i.id), ['b', 'a']);
  assert.deepEqual(pendingItems(items, '').map((i) => i.id), ['d']);
  assert.equal(nextOrder(items, 's1'), 3);
  assert.equal(nextOrder(items, 'nope'), 0);
});

test('sums ignore missing prices; ticked items group by day, newest first', () => {
  assert.equal(sumPrices([item({ price: 1.1 }), item({ price: 2.2 }), item({ price: null })]), 3.3);
  const items = [
    item({ id: 'a', storeId: 's1', checkedDate: '2026-10-01', price: 2 }),
    item({ id: 'b', storeId: 's1', checkedDate: '2026-10-03', price: 5 }),
    item({ id: 'c', storeId: 's1', checkedDate: '2026-10-03', price: 1 }),
    item({ id: 'd', storeId: 's2', checkedDate: '2026-10-03', price: 9 }),
  ];
  const groups = groupCheckedByDate(items, 's1');
  assert.deepEqual(groups.map((g) => [g.date, g.items.length, g.total]), [['2026-10-03', 2, 6], ['2026-10-01', 1, 2]]);
  assert.equal(groupCheckedByDate(items, 's1', 1).length, 1);
});

test('reorderList only reports positions that changed and keeps orders unique', () => {
  const list = [item({ id: 'a', order: 0 }), item({ id: 'b', order: 1 }), item({ id: 'c', order: 2 })];
  assert.deepEqual(reorderList(list, 0, 2), [{ id: 'b', order: 0 }, { id: 'c', order: 1 }, { id: 'a', order: 2 }]);
  assert.deepEqual(reorderList(list, 1, 1), []);
  assert.deepEqual(reorderList(list, 5, 0), []);
  assert.deepEqual(reorderList(list.slice(0, 2), 1, 0), [{ id: 'b', order: 0 }, { id: 'a', order: 1 }]);
  // Duplicate / gappy orders get renumbered.
  const messy = [item({ id: 'a', order: 5 }), item({ id: 'b', order: 5 }), item({ id: 'c', order: 9 })];
  const changes = reorderList(messy, 2, 0);
  const applied = Object.fromEntries(messy.map((i) => [i.id, i.order]));
  changes.forEach((c) => { applied[c.id] = c.order; });
  assert.equal(new Set(Object.values(applied)).size, 3);
  assert.ok(applied.c < applied.a && applied.a < applied.b);
});

test('suggestions: this store first (with its price), other stores by name only, skip what is on the list', () => {
  const items = [
    item({ id: '1', title: 'Milk', storeId: 's1', checkedDate: '2026-09-01', quantity: '2 L', price: 3 }),
    item({ id: '2', title: 'Milk', storeId: 's2', checkedDate: '2026-10-01', quantity: '1 L', price: 4 }),
    item({ id: '3', title: 'Milkshake mix', storeId: 's1', checkedDate: '2026-08-01' }),
    item({ id: '4', title: 'Bread', storeId: 's1', checkedDate: '2026-10-01' }),
    item({ id: '5', title: 'Bread', storeId: 's1', checkedDate: '', order: 0 }),
  ];
  const s = buildSuggestions(items, 'mil', 's1', 6, '2026-10-17');
  assert.deepEqual(s.map((x) => x.title), ['Milk', 'Milkshake mix'], 'what was bought at s1 comes first');
  assert.equal(s[0].quantity, '2 L', 'the pack size used at this store, not the other store');
  assert.equal(s[0].fromStoreId, undefined, 'bought here, so not marked as from another store');
  assert.equal(s[0].price, 3, 'bought here, so the price comes along');
  assert.equal(s[1].price, null, 'bought here without a price');
  assert.deepEqual(buildSuggestions(items, 'bre', 's1'), [], 'already on the list');
  assert.deepEqual(buildSuggestions(items, '', 's1'), []);
  // A store with no history still gets product names from the other stores, without a quantity or price.
  const elsewhere = buildSuggestions(items, 'mil', 's3', 6, '2026-10-17');
  assert.deepEqual(elsewhere.map((x) => x.title), ['Milk', 'Milkshake mix']);
  assert.ok(elsewhere.every((x) => x.quantity === '' && x.fromStoreId !== undefined && !('price' in x)), 'another store: name only, never its price');
  assert.equal(elsewhere[0].fromStoreId, 's2', 'last bought at s2');
  // Mixed: a product only bought elsewhere is listed after the ones bought here (same match quality).
  const mixed = buildSuggestions(items.concat(item({ id: '9', title: 'Milk chocolate', storeId: 's2', checkedDate: '2026-10-05' })), 'milk', 's1', 6, '2026-10-17');
  assert.deepEqual(mixed.map((x) => x.title), ['Milk', 'Milkshake mix', 'Milk chocolate']);
  assert.equal(mixed[2].fromStoreId, 's2');
  assert.equal(buildSuggestions(items, 'milk', '').length, 2, 'on the Anywhere list every store counts (one row per pack size)');
  assert.equal(lastPurchase(items, 'milk', 's1').id, '1');
  assert.equal(lastPurchase(items, 'MILK', 's9').id, '2');
  assert.equal(lastPurchase(items, 'nothing', 's1'), null);
});

test('suggestions: one row per way you bought it when a single product matches', () => {
  const items = [
    item({ id: '1', title: 'Eggs', storeId: 's1', checkedDate: '2026-10-10', quantity: '12' }),
    item({ id: '2', title: 'Eggs', storeId: 's1', checkedDate: '2026-10-01', quantity: '6' }),
    item({ id: '3', title: 'Eggs', storeId: 's1', checkedDate: '2026-09-20', quantity: '12' }),
    item({ id: '4', title: 'eggs', storeId: 's1', checkedDate: '2026-09-01', quantity: '' }),
    item({ id: '5', title: 'Eggs', storeId: 's2', checkedDate: '2026-10-12', quantity: '30' }),
  ];
  const s = buildSuggestions(items, 'egg', 's1');
  assert.deepEqual(s.map((x) => [x.quantity, x.count]), [['12', 2], ['6', 1], ['', 1]]);
  assert.equal(s[0].lastDate, '2026-10-10');
  // With several products matching, only the latest way of buying each is offered.
  const more = items.concat(item({ id: '6', title: 'Egg noodles', storeId: 's1', checkedDate: '2026-10-02', quantity: '400 g' }));
  assert.equal(buildSuggestions(more, 'egg', 's1').length, 2);
});

test('suggestions: unique quantity + price variants, with the price of this store', () => {
  const items = [
    item({ id: '1', title: 'Eggs', storeId: 's1', checkedDate: '2026-10-10', quantity: '12', price: 4.99 }),
    item({ id: '2', title: 'Eggs', storeId: 's1', checkedDate: '2026-10-03', quantity: '12', price: 4.99 }),   // same as above: one row
    item({ id: '3', title: 'Eggs', storeId: 's1', checkedDate: '2026-09-26', quantity: '12', price: 5.49 }),   // other price: own row
    item({ id: '4', title: 'Eggs', storeId: 's1', checkedDate: '2026-09-19', quantity: '6', price: 2.99 }),    // other quantity: own row
    item({ id: '5', title: 'Eggs', storeId: 's1', checkedDate: '2026-09-12', quantity: '12' }),                // no price: folded into a priced 12
    item({ id: '6', title: 'Eggs', storeId: 's2', checkedDate: '2026-10-12', quantity: '30', price: 9.99 }),   // other store: never offered with a price
  ];
  const s = buildSuggestions(items, 'egg', 's1');
  assert.deepEqual(s.map((x) => [x.quantity, x.price, x.count]), [['12', 4.99, 3], ['12', 5.49, 1], ['6', 2.99, 1]]);
  assert.equal(s[0].lastDate, '2026-10-10', 'newest first');
  // Paid in another currency: the original amount comes along, and differs as a variant.
  const abroad = [
    item({ id: 'a', title: 'Baguette', storeId: 'p', checkedDate: '2026-08-10', quantity: '2', price: 1.92, paidAmount: 1.3, paidCurrency: 'EUR' }),
    item({ id: 'b', title: 'Baguette', storeId: 'p', checkedDate: '2026-07-10', quantity: '2', price: 1.95, paidAmount: 1.3, paidCurrency: 'EUR' }),
  ];
  const b = buildSuggestions(abroad, 'bague', 'p');
  assert.equal(b.length, 2, 'the converted amount differs, so they are two variants');
  assert.deepEqual([b[0].paidAmount, b[0].paidCurrency], [1.3, 'EUR']);
  // The cap applies to a single product; the default is the list limit.
  const many = Array.from({ length: 9 }, (_, n) => item({ id: 'm' + n, title: 'Milk', storeId: 's1', checkedDate: '2026-09-' + String(10 + n), quantity: '1', price: 3 + n }));
  assert.equal(buildSuggestions(many, 'milk', 's1').length, 6);
  // Several matching products: one row each (the latest variant).
  const two = items.concat(item({ id: '7', title: 'Egg noodles', storeId: 's1', checkedDate: '2026-10-02', quantity: '400', price: 2 }));
  assert.deepEqual(buildSuggestions(two, 'egg', 's1').map((x) => [x.title, x.price]), [['Eggs', 4.99], ['Egg noodles', 2]]);
});

test('past trips: grouped by day and store, newest first, filterable', () => {
  const items = [
    item({ id: '1', title: 'Milk', storeId: 's1', checkedDate: '2026-10-10', price: 4, order: 1 }),
    item({ id: '2', title: 'Eggs', storeId: 's1', checkedDate: '2026-10-10', price: 5, order: 0 }),
    item({ id: '3', title: 'Rice', storeId: 's2', checkedDate: '2026-10-10', quantity: '5 kg' }),
    item({ id: '4', title: 'Bread', storeId: 's1', checkedDate: '2026-10-03' }),
    item({ id: '5', title: 'Still to buy', storeId: 's1', checkedDate: '' }),
  ];
  const all = buildTrips(items);
  assert.deepEqual(all.map((t) => [t.date, t.storeId, t.items.map((i) => i.title), t.total]), [
    ['2026-10-10', 's1', ['Eggs', 'Milk'], 9],
    ['2026-10-10', 's2', ['Rice'], 0],
    ['2026-10-03', 's1', ['Bread'], 0],
  ]);
  assert.equal(buildTrips(items, { storeId: 's2' }).length, 1);
  assert.equal(buildTrips(items, { storeId: '' }).length, 0);
  assert.deepEqual(buildTrips(items, { query: '5 kg' }).map((t) => t.items[0].title), ['Rice'], 'quantity text is searchable');
  assert.equal(buildTrips(items, { query: 'nothing' }).length, 0);
});

test('buying again: price only carries over inside the same store', () => {
  const src = item({ title: 'Camembert', quantity: '1', price: 5.57, paidAmount: 3.5, paidCurrency: 'EUR', storeId: 'paris', notes: 'ripe' });
  const same = copyForList(src);
  assert.deepEqual([same.title, same.quantity, same.notes, same.storeId, same.price, same.paidAmount, same.paidCurrency], ['Camembert', '1', 'ripe', 'paris', 5.57, 3.5, 'EUR']);
  const moved = copyForList(src, { storeId: 'metro' });
  assert.deepEqual([moved.price, moved.paidAmount, moved.paidCurrency], [null, null, ''], 'another store may use another currency');
  assert.equal(copyForList(src, { keepPrice: false }).price, null);
  assert.equal(copyForList(item({ title: 'X', price: null })).price, null);
  const keys = onListKeys([item({ title: 'Milk ', storeId: 's1' }), item({ title: 'Done', storeId: 's1', checkedDate: '2026-10-01' })]);
  assert.equal(keys.has(listKey({ title: 'milk', storeId: 's1' })), true);
  assert.equal(keys.has(listKey({ title: 'milk', storeId: 's2' })), false);
  assert.equal(keys.has(listKey({ title: 'Done', storeId: 's1' })), false, 'bought items are not on the list');
});

test('insights: monthly totals, store breakdown, top items', () => {
  const stores = [{ id: 's1', name: 'Metro' }, { id: 's2', name: 'Costco' }];
  const items = [
    item({ title: 'Milk', storeId: 's1', checkedDate: '2026-09-02', price: 10 }),
    item({ title: 'Milk', storeId: 's1', checkedDate: '2026-10-02', price: 5 }),
    item({ title: 'milk', storeId: 's2', checkedDate: '2026-10-03', price: 7.5 }),
    item({ title: 'Bread', storeId: '', checkedDate: '2026-10-03', price: 2 }),
    item({ title: 'Bread', storeId: 'gone', checkedDate: '2026-10-04', price: 1 }),
    item({ title: 'Eggs', storeId: 's1', checkedDate: '2026-10-04', price: null }),
    item({ title: 'Pending', storeId: 's1', checkedDate: '', price: 99 }),
  ];
  assert.deepEqual(spendingByMonth(items), [
    { month: '2026-09', total: 10, count: 1 },
    { month: '2026-10', total: 15.5, count: 4 },
  ]);
  assert.deepEqual(storeBreakdown(items, stores, '2026-10'), [
    { name: 'Costco', total: 7.5 },
    { name: 'Metro', total: 5 },
    { name: 'Anywhere', total: 2 },
    { name: 'Removed store', total: 1 },
  ]);
  const top = topItems(items);
  assert.deepEqual(top[0], { title: 'Milk', count: 3, total: 22.5 });
  assert.ok(!top.some((t) => t.title === 'Pending'));
});

test('estimateCurrentMonth projects from earlier months', () => {
  const monthly = [
    { month: '2026-07', total: 310, count: 5 },
    { month: '2026-08', total: 310, count: 5 },
    { month: '2026-09', total: 300, count: 5 },
    { month: '2026-10', total: 100, count: 2 },
  ];
  const est = estimateCurrentMonth(monthly, new Date(2026, 9, 10));
  assert.ok(est > 100 && est < 400, String(est));
  assert.equal(estimateCurrentMonth([{ month: '2026-10', total: 100, count: 1 }], new Date(2026, 9, 10)), null);
  assert.equal(estimateCurrentMonth([{ month: '2026-09', total: 100, count: 1 }], new Date(2026, 9, 10)), null);
});

test('Nutri import converts ids, prices, dates and store links, idempotently', () => {
  const t = new Date(2024, 4, 1, 12).getTime();
  const locations = [['Metro', 0, 'loc1', 'false', 'Montreal'], ['Costco', 1, 'loc2', 'true', ''], ['', 2, 'loc3', 'false', '']];
  const groceries = [
    ['g1', 'Milk', '2', '3,50', 0, 'loc1', t, '=...'],
    ['g2', 'Eggs', '', '', 1, 'unknown', '', ''],
    ['', 'No id', 1, '', 2, 'loc1', '', ''],
    ['g1', 'Duplicate id', 1, '', 3, 'loc1', '', ''],
  ];
  const a = convertNutriRows(groceries, locations, new Date(2026, 0, 1));
  assert.deepEqual(a.stores.map((s) => [s.id, s.name, s.hidden, s.city]), [['n_loc1', 'Metro', false, 'Montreal'], ['n_loc2', 'Costco', true, '']]);
  assert.equal(a.items.length, 2);
  assert.deepEqual([a.items[0].id, a.items[0].quantity, a.items[0].price, a.items[0].storeId, a.items[0].checkedDate], ['n_g1', '2', 3.5, 'n_loc1', '2024-05-01']);
  assert.equal(a.items[1].storeId, '', 'unknown store becomes Anywhere');
  assert.equal(a.items[1].checkedDate, '');
  assert.equal(a.items[1].quantity, '', 'Nutri left the amount blank, so it stays blank');
  assert.deepEqual(convertNutriRows(groceries, locations, new Date(2026, 0, 1)).items.map((i) => i.id), ['n_g1', 'n_g2']);
  assert.deepEqual(convertNutriRows(null, null), { stores: [], items: [] });
});

test('base currency guess follows the device region', () => {
  assert.equal(guessBaseCurrency('en-CA'), 'CAD');
  assert.equal(guessBaseCurrency('fr-FR'), 'EUR');
  assert.equal(guessBaseCurrency('de-CH'), 'CHF');
  assert.equal(guessBaseCurrency('en'), 'USD');
  assert.equal(guessBaseCurrency(''), 'USD');
});

test('date labels', () => {
  const now = new Date(2026, 9, 17);
  assert.equal(formatDateLabel('2026-10-17', now), 'today');
  assert.equal(formatDateLabel('2026-10-16', now), 'yesterday');
  assert.match(formatDateLabel('2026-03-04', now), /Mar/);
  assert.match(formatDateLabel('2025-03-04', now), /2025/);
  assert.match(formatMonthLabel('2026-10'), /2026/);
  assert.equal(formatMonthLabel(''), 'All time');
});

test('negative prices (discounts, refunds) are kept everywhere', () => {
  assert.equal(formatCurrency(-3.5, 'USD'), '-$3.50');
  assert.equal(formatCurrency(-0.001, 'USD'), '$0.00');
  assert.equal(sanitizeAmountText('-2,50'), '-2,50');
  assert.equal(flipSign('2.5'), '-2.5');
  assert.equal(flipSign('-2.5'), '2.5');
  assert.equal(flipSign(''), '');
  assert.equal(flipSign('-'), '');
  const coupon = item({ id: 'c', title: 'Coupon', price: -3.5, checkedDate: '2026-10-01' });
  const back = rowToItem(itemToRow(coupon));
  assert.equal(back.price, -3.5);
  const abroad = rowToItem(itemToRow({ ...coupon, price: -5.57, paidAmount: -3.5, paidCurrency: 'EUR' }));
  assert.deepEqual([abroad.price, abroad.paidAmount, abroad.paidCurrency], [-5.57, -3.5, 'EUR']);
  assert.equal(sumPrices([item({ id: 'a', price: 10 }), coupon]), 6.5, 'a discount reduces the total');
  const imported = convertNutriRows([['g1', 'Voucher', '', '-2.00', '1', '', '']], [], new Date(2026, 0, 1));
  assert.equal(imported.items[0].price, -2, 'Nutri discounts survive the import');
});

test('quantity input only accepts a plain number', () => {
  assert.equal(sanitizeQuantityText('12'), '12');
  assert.equal(sanitizeQuantityText('500 ml'), '500');
  assert.equal(sanitizeQuantityText('1,5'), '1,5');
  assert.equal(sanitizeQuantityText('1.5.2'), '1.52');
  assert.equal(sanitizeQuantityText('-3'), '3');
  assert.equal(sanitizeQuantityText('abc'), '');
  assert.equal(cleanQuantity('1,5'), '1.5');
  assert.equal(cleanQuantity('007'), '7');
  assert.equal(cleanQuantity('0'), '');
});
