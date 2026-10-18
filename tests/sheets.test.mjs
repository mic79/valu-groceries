// Data layer tests that need no network: the formula-injection guard and the in-memory Demo group.
import test from 'node:test';
import assert from 'node:assert/strict';
import SheetsApi, { TABS, neutralizeFormula, groupNameFromTitle, DEMO_SHEET_ID } from '../sheetsApi.js';
import { rowToItem, rowToStore, itemToRow, pendingItems, spendingByMonth } from '../groceryLogic.js';
import { resetDemo } from '../demoData.js';

test('formula injection guard', () => {
  assert.equal(neutralizeFormula('=IMPORTXML("x")'), "'=IMPORTXML(\"x\")");
  assert.equal(neutralizeFormula('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(neutralizeFormula('+cmd|calc'), "'+cmd|calc");
  assert.equal(neutralizeFormula('-5'), '-5');
  assert.equal(neutralizeFormula('-12.50'), '-12.50');
  assert.equal(neutralizeFormula('Milk'), 'Milk');
  assert.equal(neutralizeFormula(3.5), 3.5);
  assert.equal(neutralizeFormula(''), '');
});

test('group names drop the app prefix', () => {
  assert.equal(groupNameFromTitle('Valu Groceries: Family'), 'Family');
  assert.equal(groupNameFromTitle('Something else'), 'Something else');
});

test('demo group behaves like a sheet: read, append, update, delete', async () => {
  resetDemo();
  const settings = await SheetsApi.getSettings(DEMO_SHEET_ID);
  assert.equal(settings.baseCurrency, 'CAD');
  assert.equal(settings.trackPrices, 'true');

  const stores = (await SheetsApi.getTabData(DEMO_SHEET_ID, TABS.STORES)).map(rowToStore);
  assert.ok(stores.length >= 3);
  assert.ok(stores.some((s) => s.currency === 'EUR'), 'demo has a foreign-currency store');

  const before = (await SheetsApi.getTabData(DEMO_SHEET_ID, TABS.ITEMS)).map(rowToItem);
  assert.ok(before.some((i) => !i.checkedDate), 'demo has open items');
  assert.ok(spendingByMonth(before).length >= 6, 'demo has months of history');

  const id = SheetsApi.generateId();
  const fresh = { id, title: 'Test oats', quantity: '2 kg', price: 4.5, paidAmount: null, paidCurrency: '', storeId: stores[0].id, order: 99, checkedDate: '', notes: '', createdAt: new Date().toISOString() };
  await SheetsApi.appendRow(DEMO_SHEET_ID, TABS.ITEMS, itemToRow(fresh));
  let items = (await SheetsApi.getTabData(DEMO_SHEET_ID, TABS.ITEMS)).map(rowToItem);
  assert.deepEqual(items.find((i) => i.id === id), fresh);
  assert.ok(pendingItems(items, stores[0].id).some((i) => i.id === id));

  await SheetsApi.updateRow(DEMO_SHEET_ID, TABS.ITEMS, id, itemToRow({ ...fresh, checkedDate: '2026-10-01' }));
  items = (await SheetsApi.getTabData(DEMO_SHEET_ID, TABS.ITEMS)).map(rowToItem);
  assert.equal(items.find((i) => i.id === id).checkedDate, '2026-10-01');

  await SheetsApi.deleteRows(DEMO_SHEET_ID, TABS.ITEMS, [id]);
  items = (await SheetsApi.getTabData(DEMO_SHEET_ID, TABS.ITEMS)).map(rowToItem);
  assert.ok(!items.some((i) => i.id === id));
  assert.equal(items.length, before.length);
});

test('generated ids are unique', () => {
  const ids = new Set(Array.from({ length: 500 }, () => SheetsApi.generateId()));
  assert.equal(ids.size, 500);
});
