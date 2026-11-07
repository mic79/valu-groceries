// Foreign-price refresh when putting history items back on the list.
import test from 'node:test';
import assert from 'node:assert/strict';
import { refreshForeignListPrices } from '../fxService.js';

test('refreshForeignListPrices re-converts paid amounts with today\'s rate', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ rate: 1.5, date: '2026-11-07' }),
  });
  try {
    const [updated] = await refreshForeignListPrices(
      [{ title: 'Wine', price: 10, paidAmount: 8, paidCurrency: 'EUR' }],
      { baseCurrency: 'USD', date: '2026-11-07' },
    );
    assert.equal(updated.paidAmount, 8);
    assert.equal(updated.paidCurrency, 'EUR');
    assert.equal(updated.price, 12); // 8 * 1.5
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('refreshForeignListPrices leaves base-currency and unpriced specs alone', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return { ok: true, json: async () => ({ rate: 2 }) }; };
  try {
    const out = await refreshForeignListPrices(
      [
        { title: 'Milk', price: 4, paidAmount: null, paidCurrency: '' },
        { title: 'Bread', price: 3, paidAmount: 3, paidCurrency: 'USD' },
      ],
      { baseCurrency: 'USD', date: '2026-11-07' },
    );
    assert.equal(calls, 0);
    assert.equal(out[0].price, 4);
    assert.equal(out[1].price, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('refreshForeignListPrices keeps the old base price when the rate is missing', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 500 });
  try {
    const [updated] = await refreshForeignListPrices(
      [{ title: 'Tea', price: 9, paidAmount: 6, paidCurrency: 'GBP' }],
      { baseCurrency: 'USD', date: '2026-11-08' },
    );
    assert.equal(updated.price, 9);
    assert.equal(updated.paidAmount, 6);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('applyForeignPricesForDate mutates items using the given purchase date', async () => {
  const { applyForeignPricesForDate } = await import('../fxService.js');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ rate: 2, date: '2026-10-01' }),
  });
  try {
    const item = { title: 'Wine', price: 7, paidAmount: 5, paidCurrency: 'EUR' };
    const changed = await applyForeignPricesForDate([item], {
      baseCurrency: 'USD',
      date: '2026-10-01',
    });
    assert.equal(changed, true);
    assert.equal(item.price, 10); // 5 * 2
    assert.equal(item.paidAmount, 5);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
