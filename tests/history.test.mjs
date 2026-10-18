// Unit tests for the History helpers: periods, sorting, products, clipboard text, moving to a store.
import test from 'node:test';
import assert from 'node:assert/strict';
import { periodRange, inRange, sortPurchases, productStats, itemsToText, moveToStore } from '../groceryLogic.js';

const item = (o) => ({ id: 'i' + Math.random(), title: 'Milk', quantity: '', price: null, paidAmount: null, paidCurrency: '', storeId: '', order: 0, checkedDate: '2026-10-01', notes: '', createdAt: '', ...o });
const names = { a: 'Metro', b: 'Costco' };
const nameOf = (id) => names[id] || '';

test('periods: month, year, day and range (either order)', () => {
  assert.deepEqual(periodRange('month', '2026-02'), { from: '2026-02-01', to: '2026-02-28' });
  assert.deepEqual(periodRange('month', '2028-02'), { from: '2028-02-01', to: '2028-02-29' });
  assert.deepEqual(periodRange('year', '2026'), { from: '2026-01-01', to: '2026-12-31' });
  assert.deepEqual(periodRange('day', '2026-10-15'), { from: '2026-10-15', to: '2026-10-15' });
  assert.deepEqual(periodRange('range', '2026-10-20', '2026-10-05'), { from: '2026-10-05', to: '2026-10-20' });
  assert.deepEqual(periodRange('range', '2026-10-05', ''), { from: '2026-10-05', to: '' });
  assert.deepEqual(periodRange('all'), { from: '', to: '' });
  const r = periodRange('range', '2026-10-05', '2026-10-20');
  assert.equal(inRange('2026-10-05', r), true);
  assert.equal(inRange('2026-10-20', r), true);
  assert.equal(inRange('2026-10-21', r), false);
  assert.equal(inRange('2026-10-04', r), false);
  assert.equal(inRange('2026-10-04', periodRange('all')), true);
});

test('sorting purchases', () => {
  const list = [
    item({ id: '1', title: 'Pasta', price: 2, checkedDate: '2026-10-02', storeId: 'b' }),
    item({ id: '2', title: 'Apples', price: 5, checkedDate: '2026-10-05', storeId: 'a' }),
    item({ id: '3', title: 'Milk', price: null, checkedDate: '2026-10-03', storeId: 'a' }),
    item({ id: '4', title: 'Bread', price: 3, checkedDate: '2026-10-01', storeId: '' }),
  ];
  const ids = (s) => sortPurchases(list, s, nameOf).map((i) => i.id).join('');
  assert.equal(ids('newest'), '2314');
  assert.equal(ids('oldest'), '4132');
  assert.equal(ids('price_desc'), '2413', 'highest first, no price last');
  assert.equal(ids('price_asc'), '1423', 'lowest first, no price last');
  assert.equal(ids('name'), '2431');
  assert.equal(ids('store'), '4123', 'Anywhere, Costco, Metro (newest first within a store)');
  assert.equal(list[0].id, '1', 'does not reorder the input');
});

test('products: counts, averages, range and the cheapest store', () => {
  const list = [
    item({ title: 'Milk', price: 4, storeId: 'a', checkedDate: '2026-10-01' }),
    item({ title: 'milk', price: 5, storeId: 'a', checkedDate: '2026-10-08' }),
    item({ title: 'Milk', price: 3, storeId: 'b', checkedDate: '2026-10-05' }),
    item({ title: 'Milk', price: null, storeId: 'b', checkedDate: '2026-10-06' }),
    item({ title: 'Eggs', price: 6, storeId: 'a', checkedDate: '2026-10-02' }),
  ];
  const stats = productStats(list, nameOf);
  const milk = stats.find((p) => p.key === 'milk');
  assert.equal(milk.count, 4);
  assert.equal(milk.priced, 3);
  assert.equal(milk.avg, 4);
  assert.equal(milk.min, 3);
  assert.equal(milk.max, 5);
  assert.equal(milk.total, 12);
  assert.equal(milk.lastDate, '2026-10-08');
  assert.equal(milk.lastPrice, 5);
  assert.equal(milk.title, 'milk', 'shows the name as last written');
  assert.deepEqual(milk.byStore.map((s) => [s.name, s.count, s.avg]), [['Costco', 2, 3], ['Metro', 2, 4.5]]);
  assert.equal(milk.cheapestStoreId, 'b');
  const eggs = stats.find((p) => p.key === 'eggs');
  assert.equal(eggs.cheapestStoreId, null, 'one store: nothing to compare');
  assert.equal(productStats([item({ title: ' ' })]).length, 0);
});

test('products: items without any price still count', () => {
  const [p] = productStats([item({ title: 'Salt' }), item({ title: 'Salt' })], nameOf);
  assert.equal(p.count, 2);
  assert.equal(p.avg, null);
  assert.equal(p.min, null);
  assert.equal(p.lastPrice, null);
});

test('clipboard text: chosen fields in a fixed order, header, tabs and csv', () => {
  const list = [
    item({ title: 'Milk', quantity: '2', price: 4.5, storeId: 'a', checkedDate: '2026-10-01', notes: 'organic' }),
    item({ title: 'Wine, red', price: 12, paidAmount: 8, paidCurrency: 'EUR', storeId: 'zz', checkedDate: '2026-10-02', notes: 'a\tb\nc' }),
  ];
  const opts = { storeNameOf: nameOf, storeCityOf: (id) => (id === 'a' ? 'Toronto' : ''), num: (n) => String(n).replace('.', ',') };
  assert.equal(
    itemsToText(list, { ...opts, fields: ['price', 'title', 'date'], format: 'tsv', header: true }),
    'Date\tItem\tPrice\n2026-10-01\tMilk\t4,5\n2026-10-02\tWine, red\t12',
  );
  assert.equal(
    itemsToText(list, { ...opts, fields: ['title', 'store', 'city', 'paid', 'notes'], format: 'csv', header: false }),
    'Milk,Metro,Toronto,,organic\n"Wine, red",,,8 EUR,"a\tb\nc"',
  );
  assert.equal(itemsToText(list, { ...opts, fields: [] }), '');
  assert.equal(itemsToText([item({ title: 'X' })], { fields: ['title', 'store'], header: false }), 'X\tAnywhere');
  assert.equal(itemsToText([item({ title: 'say "hi"' })], { fields: ['title'], format: 'csv', header: false }), '"say ""hi"""');
});

test('moving to a store clears prices that are in another currency', () => {
  const list = [
    item({ id: '1', price: 4, storeId: 'a', order: 5 }),
    item({ id: '2', price: 7, paidAmount: 5, paidCurrency: 'EUR', storeId: 'a', order: 6 }),
    item({ id: '3', price: null, storeId: 'a', order: 7 }),
  ];
  const cleared = moveToStore(list, 'b', { startOrder: 10, targetCurrency: 'CAD', baseCurrency: 'CAD' });
  assert.equal(cleared, 1);
  assert.deepEqual(list.map((i) => [i.storeId, i.order, i.price]), [['b', 10, 4], ['b', 11, null], ['b', 12, null]]);
  assert.equal(list[1].paidAmount, null);
  assert.equal(list[1].paidCurrency, '');

  const abroad = [item({ price: 3, storeId: 'a' })];
  assert.equal(moveToStore(abroad, 'c', { targetCurrency: 'EUR', baseCurrency: 'CAD' }), 1, 'a base-currency price means nothing in a euro store');
  const sameEuro = [item({ price: 3, paidAmount: 2, paidCurrency: 'EUR', storeId: 'a' })];
  assert.equal(moveToStore(sameEuro, 'c', { targetCurrency: 'EUR', baseCurrency: 'CAD' }), 0);
  assert.equal(sameEuro[0].price, 3);
  const off = [item({ price: 3 })];
  assert.equal(moveToStore(off, 'c', { targetCurrency: 'EUR', baseCurrency: 'CAD', trackPrices: false }), 0);
});
