/**
 * Built-in Demo group ("Quick look"): lives in memory only, no Google account or Sheet involved.
 * Edits work during the session so the whole app can be tried out, but nothing is saved.
 * The data mimics a Sheet: the same tabs and row layout, so the pages cannot tell the difference.
 */

import { itemToRow, storeToRow, localDateISO } from './groceryLogic.js';

export const DEMO_SHEET_ID = '__vg_demo__';

export function isDemoSheet(id) {
  return id === DEMO_SHEET_ID;
}

export function demoGroupMeta() {
  return { id: DEMO_SHEET_ID, name: 'Valu Groceries: Demo', modifiedTime: new Date().toISOString() };
}

// ── Settings ───────────────────────────────────────────────────────────────────

const overrides = {};

export function demoSettingsObject() {
  return {
    groupName: 'Demo',
    baseCurrency: 'CAD',
    trackPrices: 'true',
    trackNutrition: 'true',
    currencyRates: 'EUR:1.48,USD:1.36',
    createdAt: '',
    createdBy: '',
  };
}

export function getDemoSettings() {
  return { ...demoSettingsObject(), ...overrides };
}

export function setDemoOverride(key, value) {
  overrides[key] = value;
}

export function setDemoOverrides(obj) {
  Object.assign(overrides, obj);
}

// ── Seed data ──────────────────────────────────────────────────────────────────

function seededRandom(seed) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

const STORES = [
  { id: 'demo_s_metro', name: 'Metro', city: 'Toronto', order: 0, hidden: false, currency: '' },
  { id: 'demo_s_costco', name: 'Costco', city: 'Toronto', order: 1, hidden: false, currency: '' },
  { id: 'demo_s_market', name: "Farmers' market", city: 'Toronto', order: 2, hidden: false, currency: '' },
  { id: 'demo_s_paris', name: 'Carrefour (Paris)', city: 'Paris', order: 3, hidden: false, currency: 'EUR' },
];

// [title, typical line price in CAD, [[store, usual quantity text], ...]]. The same product can be
// bought in a different pack size at each store, which is what the suggestions show.
const CATALOG = [
  ['Milk', 4.29, [['metro', '2000']]], ['Eggs', 4.99, [['metro', '12'], ['costco', '30']]], ['Bread', 3.49, [['metro', '1']]],
  ['Bananas', 2.1, [['metro', '6'], ['market', '1000']]], ['Apples', 5.5, [['market', '1500'], ['metro', '6']]],
  ['Chicken thighs', 11.5, [['metro', '800'], ['costco', '2000']]],
  ['Ground beef', 9.8, [['metro', '500']]], ['Pasta', 2.2, [['metro', '500']]], ['Tomato sauce', 3.1, [['metro', '2']]],
  ['Rice', 12.99, [['costco', '5000']]], ['Olive oil', 24.99, [['costco', '1000']]], ['Coffee beans', 16.5, [['metro', '340'], ['costco', '1000']]],
  ['Yogurt', 6.58, [['metro', '700']]], ['Cheddar', 7.2, [['metro', '300'], ['costco', '1000']]],
  ['Spinach', 3.99, [['metro', '300'], ['market', '200']]],
  ['Tomatoes', 4.2, [['market', '1000']]], ['Carrots', 2.5, [['market', '1000'], ['metro', '900']]], ['Butter', 5.9, [['metro', '454']]],
  ['Toilet paper', 22.99, [['costco', '30']]], ['Dish soap', 3.8, [['metro', '']]], ['Orange juice', 4.5, [['metro', '1500']]],
  ['Salmon fillets', 13.9, [['costco', '1000'], ['metro', '400']]], ['Oats', 4.6, [['metro', '1000']]],
  ['Frozen berries', 9.99, [['costco', '1500']]],
];

const MONTHS_BACK = 30; // a few years, so the yearly views have something to show
const TRIP_DAYS = [3, 9, 15, 22, 27];

function buildItems() {
  const rand = seededRandom(7);
  const now = new Date();
  const today = localDateISO(now);
  const rows = [];
  let n = 1;
  const storeByKey = { metro: 'demo_s_metro', costco: 'demo_s_costco', market: 'demo_s_market' };

  for (let back = MONTHS_BACK - 1; back >= 0; back--) {
    const first = new Date(now.getFullYear(), now.getMonth() - back, 1);
    const y = first.getFullYear();
    const m = first.getMonth() + 1;
    const dim = new Date(y, m, 0).getDate();
    for (const day of TRIP_DAYS) {
      if (day > dim) continue;
      const date = `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      if (date >= today) continue;
      const count = 4 + Math.floor(rand() * 5);
      for (let k = 0; k < count; k++) {
        const [title, base, where] = CATALOG[Math.floor(rand() * CATALOG.length)];
        const price = Math.round(base * (0.85 + rand() * 0.3) * 100) / 100;
        const [store, quantity] = where[Math.floor(rand() * where.length)];
        rows.push(itemToRow({
          id: `demo_i_${n++}`, title, quantity, price, storeId: storeByKey[store],
          order: k, checkedDate: date, notes: '', createdAt: date + 'T12:00:00.000Z',
        }));
      }
    }
  }

  // One trip abroad, entered in EUR and converted to CAD (the original EUR amount is kept).
  const trip = new Date(now.getFullYear(), now.getMonth() - 2, 12);
  const tripDate = localDateISO(trip);
  [['Baguette', '2', 1.3, 1.92], ['Camembert', '1', 3.4, 5.03], ['Croissants', '4', 4.8, 7.1], ['Red wine', '750', 9.5, 14.06]].forEach(([title, quantity, eur, cad], k) => {
    rows.push(itemToRow({
      id: `demo_i_${n++}`, title, quantity, price: cad, storeId: 'demo_s_paris', order: k,
      checkedDate: tripDate, notes: '', createdAt: tripDate + 'T12:00:00.000Z',
      paidAmount: eur, paidCurrency: 'EUR',
    }));
  });

  // The live shopping list.
  const todo = [
    ['Milk', '2000', 4.29, 'demo_s_metro'], ['Eggs', '12', 4.99, 'demo_s_metro'], ['Bread', '1', 3.49, 'demo_s_metro'],
    ['Chicken thighs', '800', 11.5, 'demo_s_metro'], ['Spinach', '300', null, 'demo_s_metro'], ['Yogurt', '700', 6.58, 'demo_s_metro'],
    ['Olive oil', '1000', 24.99, 'demo_s_costco'], ['Toilet paper', '30', null, 'demo_s_costco'],
    ['Tomatoes', '1000', null, 'demo_s_market'], ['Apples', '1500', 5.5, 'demo_s_market'],
  ];
  const perStore = {};
  todo.forEach(([title, quantity, price, storeId]) => {
    perStore[storeId] = (perStore[storeId] ?? -1) + 1;
    rows.push(itemToRow({
      id: `demo_i_${n++}`, title, quantity, price, storeId, order: perStore[storeId],
      checkedDate: '', notes: '', createdAt: new Date().toISOString(),
    }));
  });

  // A couple already ticked off today, so the "checked off" section has something to show.
  [['Bananas', '6', 2.1, 'demo_s_metro'], ['Coffee beans', '340', 16.5, 'demo_s_metro']].forEach(([title, quantity, price, storeId], k) => {
    rows.push(itemToRow({
      id: `demo_i_${n++}`, title, quantity, price, storeId, order: 100 + k,
      checkedDate: today, notes: '', createdAt: new Date().toISOString(),
    }));
  });
  return rows;
}
// ── In-memory "sheet" ──────────────────────────────────────────────────────────

let tables = null;

function ensureTables() {
  if (!tables) {
    tables = {
      Items: buildItems(),
      Stores: STORES.map(storeToRow),
      Nutrition: [],
    };
  }
  return tables;
}

/** Sheets does not return the leading apostrophe used to force plain text. */
function unwrap(row) {
  return row.map((c) => (typeof c === 'string' && c.startsWith("'") ? c.slice(1) : c));
}

/** Read rows for a range like "Items!A2:Z" (always from row 2: headers are not stored). */
export function demoValuesForRange(range) {
  const tab = String(range).split('!')[0].replace(/'/g, '');
  if (tab === 'Settings') return Object.entries(getDemoSettings()).map(([k, v]) => [k, v]);
  const t = ensureTables();
  return (t[tab] || []).map((r) => unwrap(r));
}

export function demoAppendRows(tab, rows) {
  const t = ensureTables();
  if (!t[tab]) t[tab] = [];
  rows.forEach((r) => t[tab].push(r.slice()));
}

export function demoUpdateRow(tab, id, values) {
  const t = ensureTables();
  const idx = (t[tab] || []).findIndex((r) => String(r[0]) === String(id));
  if (idx >= 0) t[tab][idx] = values.slice();
}

export function demoDeleteRows(tab, ids) {
  const t = ensureTables();
  const gone = new Set(ids.map(String));
  t[tab] = (t[tab] || []).filter((r) => !gone.has(String(r[0])));
}

/** Reset the demo to its starting state (used when leaving the demo). */
export function resetDemo() {
  tables = null;
  for (const k of Object.keys(overrides)) delete overrides[k];
}
