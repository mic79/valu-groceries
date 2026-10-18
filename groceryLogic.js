/**
 * Pure helpers for Valu Groceries (no Vue, no network) so they can be unit tested with `node --test`.
 *
 * Sheet layout (one spreadsheet = one "group"):
 *   Items:  ID | Title | Quantity | Price | StoreID | Order | CheckedDate | Notes | CreatedAt | PaidAmount | PaidCurrency
 *   Stores: ID | Name | City | Order | Hidden | Currency
 *   Settings: Key | Value
 *
 * - Quantity is free text, used like a note ("12", "500 ml", "2 packs"); nothing is ever calculated from it.
 * - Price is the TOTAL for the line (not per unit), always stored in the group's base currency.
 * - PaidAmount/PaidCurrency remember what was typed when the price was entered in a foreign currency
 *   (Price holds the converted amount), so the list can show "€3.50" and editing starts from it.
 * - CheckedDate is empty while the item is still on the list; once ticked off it holds YYYY-MM-DD
 *   and the row becomes part of the purchase history.
 * - Hidden is "yes" or empty; Currency is the store's usual currency (empty = base currency).
 */

// ── Dates ──────────────────────────────────────────────────────────────────────

/** YYYY-MM-DD in the user's local time zone (toISOString() is UTC and can be off by a day). */
export function localDateISO(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Returns the string if it is a real YYYY-MM-DD calendar date, otherwise ''. */
export function normalizeDate(value) {
  const s = String(value ?? '').trim().replace(/^'/, '');
  const m = ISO_DATE_RE.exec(s);
  if (!m) return '';
  const y = +m[1], mo = +m[2] - 1, d = +m[3];
  const dt = new Date(y, mo, d);
  return dt.getFullYear() === y && dt.getMonth() === mo && dt.getDate() === d ? s : '';
}

/** Epoch milliseconds (as the old Nutri app stored them) to a local YYYY-MM-DD, or ''. */
export function dateFromEpochMs(value) {
  const n = typeof value === 'number' ? value : parseInt(String(value ?? '').trim(), 10);
  if (!Number.isFinite(n) || n <= 0) return '';
  const d = new Date(n);
  return Number.isNaN(d.getTime()) ? '' : localDateISO(d);
}

export function isFutureDate(iso, today = localDateISO()) {
  return !!iso && iso > today;
}

export function monthKey(iso) {
  return iso && iso.length >= 7 ? iso.slice(0, 7) : '';
}

// ── Numbers & money ────────────────────────────────────────────────────────────

/**
 * Locale-tolerant amount parser. "1.234,56", "1,234.56", "12,5", "12.5" and plain numbers all work:
 * whichever of "." and "," appears last is the decimal mark. Returns NaN when it is not a number.
 */
export function parseAmount(val) {
  if (typeof val === 'number') return val;
  if (!val || typeof val !== 'string') return NaN;
  const s = val.trim();
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  if (lastComma > lastDot) return parseFloat(s.replace(/\./g, '').replace(',', '.'));
  return parseFloat(s.replace(/,/g, ''));
}

/** Rounds to cents the way people expect ("1.005" becomes 1.01, not 1 because of binary floats). */
export function roundMoney(n) {
  const sign = n < 0 ? -1 : 1;
  return sign * Math.round((Math.abs(n) + Number.EPSILON) * 100) / 100;
}

/** Keeps only characters that make sense in an amount field (digits, one sign, "." or ","). */
export function sanitizeAmountText(raw) {
  if (typeof raw !== 'string') return raw;
  let s = raw.replace(/[^0-9.,-]/g, '');
  s = s.replace(/^(-?)(.*)/, (_, sign, rest) => sign + rest.replace(/-/g, ''));
  s = s.replace(/([.,])([.,])/g, '$1');
  s = s.replace(/([.,])([.,])/g, '$1');
  return s;
}

/** Flip an amount between positive and negative (discounts, refunds). Empty stays empty. */
export function flipSign(raw) {
  const s = String(raw ?? '').trim();
  if (s === '' || s === '-') return '';
  return s.startsWith('-') ? s.slice(1) : '-' + s;
}

function numberPref() {
  try {
    return (typeof localStorage !== 'undefined' && localStorage.getItem('vg_number_format')) || 'auto';
  } catch {
    return 'auto';
  }
}

/** Locale for number formatting from Settings > Number Format ('auto' = the device default). */
export function getNumberLocale() {
  const pref = numberPref();
  return pref === 'auto' ? undefined : pref;
}

/** A number as it should appear in an input box, honouring the "1.234,56" preference. */
export function amountToInput(num) {
  if (num === null || num === undefined || num === '' || Number.isNaN(Number(num))) return '';
  const str = Number(num).toString();
  return numberPref() === 'de-DE' ? str.replace('.', ',') : str;
}

/** "$12.50" style text: currency symbol + number formatted per the user's number-format preference. */
export function formatCurrency(amount, currency) {
  const value = Number(amount) || 0;
  try {
    const sym = new Intl.NumberFormat(undefined, {
      style: 'currency', currency: currency || 'USD', currencyDisplay: 'narrowSymbol',
    }).formatToParts(0).find((p) => p.type === 'currency')?.value || currency;
    const num = new Intl.NumberFormat(getNumberLocale(), {
      minimumFractionDigits: 2, maximumFractionDigits: 2,
    }).format(Math.abs(value));
    // Minus in front of the symbol ("-$3.50"), and never "-$0.00".
    return (value < 0 && Math.abs(value) >= 0.005 ? '-' : '') + sym + num;
  } catch {
    return value.toFixed(2) + ' ' + (currency || '');
  }
}

/** Plain number without a currency symbol (used in dense tables). */
export function formatNumber(amount) {
  try {
    return new Intl.NumberFormat(getNumberLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(amount) || 0);
  } catch {
    return (Number(amount) || 0).toFixed(2);
  }
}

const NUMERIC_QUANTITY = /^\d+(?:[.,]\d{1,3})?$/;

/**
 * Quantity is a plain number, so other tools (like Nutri's nutrition page) can read it: pieces for
 * counted foods, grams or millilitres for weight and volume (the food's Unit decides which).
 * New input is restricted to a number. Text written by older versions (or typed into the sheet by
 * hand, like "2 L") is kept as it is so nothing is lost, but it is single-line and capped.
 */
export function cleanQuantity(q) {
  if (q === null || q === undefined) return '';
  if (typeof q === 'number') return Number.isFinite(q) && q > 0 ? String(Math.round(q * 1000) / 1000) : '';
  const s = String(q).replace(/^'/, '').replace(/\s+/g, ' ').trim().slice(0, 40);
  if (NUMERIC_QUANTITY.test(s)) {
    const n = Number(s.replace(',', '.'));
    return n > 0 ? String(n) : '';
  }
  return s;
}

export function isNumericQuantity(q) {
  return NUMERIC_QUANTITY.test(String(q ?? ''));
}

/** For the quantity input: digits and at most one "." or "," (no sign, no letters), kept short. */
export function sanitizeQuantityText(raw) {
  if (typeof raw !== 'string') return raw;
  let s = raw.replace(/[^0-9.,]/g, '');
  const first = s.search(/[.,]/);
  if (first !== -1) s = s.slice(0, first + 1) + s.slice(first + 1).replace(/[.,]/g, '');
  return s.slice(0, 9);
}

export function capitalizeFirst(text) {
  const s = String(text ?? '');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** "USD:1.36,EUR:1.48" (Settings > currencyRates) to [{currency, rate}]. */
export function parseCurrencyRates(str) {
  return String(str || '').split(',').filter(Boolean).map((r) => {
    const [currency, rate] = r.split(':');
    return { currency, rate };
  });
}

// ── Row mapping ────────────────────────────────────────────────────────────────

export const ITEM_HEADERS = ['ID', 'Title', 'Quantity', 'Price', 'StoreID', 'Order', 'CheckedDate', 'Notes', 'CreatedAt', 'PaidAmount', 'PaidCurrency'];
export const STORE_HEADERS = ['ID', 'Name', 'City', 'Order', 'Hidden', 'Currency'];

const LOOKS_LIKE_NUMBER_OR_DATE = /^[\s+-]?[\d.,/:-]+$/;

/**
 * Free text goes into the sheet with USER_ENTERED so numbers and dates in the other columns stay
 * real numbers/dates. A title like "7" or "2024-05-01" would be converted too, so those get a
 * leading apostrophe (Sheets stores it as plain text and does not return the apostrophe).
 */
export function textCell(value) {
  const s = String(value ?? '');
  return LOOKS_LIKE_NUMBER_OR_DATE.test(s) ? "'" + s : s;
}

export function rowToItem(r) {
  const row = r || [];
  const price = row[3] === '' || row[3] === undefined || row[3] === null ? NaN : parseAmount(row[3]);
  const paid = row[9] === '' || row[9] === undefined || row[9] === null ? NaN : parseAmount(row[9]);
  const paidCurrency = String(row[10] ?? '').trim().toUpperCase();
  const hasPaid = Number.isFinite(paid) && paid !== 0 && /^[A-Z]{3}$/.test(paidCurrency);
  return {
    id: String(row[0] ?? ''),
    title: String(row[1] ?? ''),
    quantity: cleanQuantity(row[2]),
    price: Number.isFinite(price) && price !== 0 ? price : null,
    storeId: String(row[4] ?? ''),
    order: parseInt(row[5], 10) || 0,
    checkedDate: normalizeDate(row[6]),
    notes: String(row[7] ?? ''),
    createdAt: String(row[8] ?? ''),
    paidAmount: hasPaid ? paid : null,
    paidCurrency: hasPaid ? paidCurrency : '',
  };
}

/** A numeric quantity goes in as a real number (so it stays a number in the sheet); old text stays text. */
function quantityCell(value) {
  const q = cleanQuantity(value);
  return q !== '' && NUMERIC_QUANTITY.test(q) ? Number(q) : textCell(q);
}

/** Numbers are sent as JSON numbers (never as text) so they cannot be misread in comma-decimal locales. */
export function itemToRow(item) {
  const price = item.price === null || item.price === undefined || item.price === '' || Number.isNaN(Number(item.price))
    ? '' : roundMoney(Number(item.price));
  const hasPaid = Number.isFinite(Number(item.paidAmount)) && Number(item.paidAmount) !== 0 && /^[A-Z]{3}$/.test(String(item.paidCurrency || ''));
  return [
    item.id,
    textCell(item.title),
    quantityCell(item.quantity),
    price,
    item.storeId || '',
    Number(item.order) || 0,
    item.checkedDate ? "'" + item.checkedDate : '',
    textCell(item.notes),
    item.createdAt || '',
    hasPaid ? roundMoney(Number(item.paidAmount)) : '',
    hasPaid ? item.paidCurrency : '',
  ];
}

export function rowToStore(r) {
  const row = r || [];
  const hidden = String(row[4] ?? '').trim().toLowerCase();
  return {
    id: String(row[0] ?? ''),
    name: String(row[1] ?? ''),
    city: String(row[2] ?? ''),
    order: parseInt(row[3], 10) || 0,
    hidden: hidden === 'yes' || hidden === 'true' || hidden === '1',
    currency: String(row[5] ?? '').trim().toUpperCase(),
  };
}

export function storeToRow(store) {
  return [
    store.id,
    textCell(store.name),
    textCell(store.city),
    Number(store.order) || 0,
    store.hidden ? 'yes' : '',
    store.currency || '',
  ];
}

// ── Lists ──────────────────────────────────────────────────────────────────────

/** Items still to buy at a store ('' = items without a store), in list order. */
export function pendingItems(items, storeId) {
  return items
    .filter((i) => !i.checkedDate && (i.storeId || '') === (storeId || ''))
    .sort((a, b) => a.order - b.order || String(a.createdAt).localeCompare(String(b.createdAt)));
}

/** Next Order value for a new item at the end of a store's list. */
export function nextOrder(items, storeId) {
  const orders = items.filter((i) => (i.storeId || '') === (storeId || '')).map((i) => i.order);
  return orders.length ? Math.max(...orders) + 1 : 0;
}

/** Sum of known prices (items with no price count as 0). */
export function sumPrices(list) {
  return roundMoney(list.reduce((s, i) => s + (typeof i.price === 'number' ? i.price : 0), 0));
}

/** Checked-off items of a store grouped by day, newest day first. */
export function groupCheckedByDate(items, storeId, limitDays = Infinity) {
  const byDate = new Map();
  for (const i of items) {
    if (!i.checkedDate) continue;
    if (storeId !== undefined && (i.storeId || '') !== (storeId || '')) continue;
    if (!byDate.has(i.checkedDate)) byDate.set(i.checkedDate, []);
    byDate.get(i.checkedDate).push(i);
  }
  return [...byDate.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .slice(0, limitDays)
    .map(([date, list]) => ({
      date,
      items: list.sort((a, b) => a.order - b.order),
      total: sumPrices(list),
    }));
}

/**
 * Move one element within an ordered list and return the new Order values, only for entries whose
 * position changed. `list` is the visible, ordered array; the result is [{id, order}].
 */
export function reorderList(list, fromIndex, toIndex) {
  if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= list.length || toIndex >= list.length) return [];
  const orders = list.map((i) => i.order).sort((a, b) => a - b);
  // Orders may repeat or have gaps, so renumber the whole visible list 0..n-1 when they are not unique.
  const unique = new Set(orders).size === orders.length;
  const base = unique ? orders : list.map((_, idx) => idx);
  const next = list.slice();
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  const changes = [];
  next.forEach((item, idx) => {
    if (item.order !== base[idx]) changes.push({ id: item.id, order: base[idx] });
  });
  return changes;
}

// ── Suggestions (quick add) ────────────────────────────────────────────────────

const norm = (s) => String(s ?? '').trim().toLowerCase();

const hasMoney = (i) => typeof i.price === 'number' && i.price !== 0;

/**
 * The distinct ways a product was bought, newest first: one entry per quantity + price (+ foreign
 * amount) combination, with how often it happened. A purchase without a price is folded into a priced
 * variant of the same quantity instead of showing up as a second, poorer row.
 */
function uniqueVariants(newestFirst) {
  const title = newestFirst[0].title;
  const seen = new Map();
  const make = (i) => ({
    title,
    quantity: i.quantity,
    price: hasMoney(i) ? i.price : null,
    paidAmount: hasMoney(i) && i.paidAmount ? i.paidAmount : null,
    paidCurrency: hasMoney(i) && i.paidAmount ? i.paidCurrency : '',
    lastDate: i.checkedDate,
    count: 1,
  });
  const keyOf = (v) => [norm(v.quantity), v.price === null ? '' : Math.round(v.price * 100), v.paidAmount === null ? '' : v.paidCurrency + Math.round(v.paidAmount * 100)].join('|');
  for (const i of newestFirst) {
    const v = make(i);
    const k = keyOf(v);
    const cur = seen.get(k);
    if (cur) cur.count += 1; else seen.set(k, v);
  }
  const all = [...seen.values()];
  const out = [];
  for (const v of all) {
    if (v.price === null) {
      const priced = all.find((o) => o.price !== null && norm(o.quantity) === norm(v.quantity));
      if (priced) { priced.count += v.count; continue; }
    }
    out.push(v);
  }
  return out;
}

/**
 * Suggest earlier purchases while typing. Only ticked-off items count as history.
 *
 * - Products you bought in the selected store come first, as a product name plus how it was bought
 *   there: quantity and price (and the amount paid in a foreign currency, when there was one). Each
 *   distinct quantity/price combination is one variant, so "Eggs 12 $4.99", "Eggs 12 $5.49" and
 *   "Eggs 6 $2.99" are separate rows, and repeating the very same purchase never adds a row. When only
 *   one product matches, its variants are listed (newest first, up to `limit`); with several products
 *   each shows its latest variant. On the "Anywhere" list (storeId '') every store counts as "here".
 * - Products you only bought in other stores are offered after those, as a name only: a pack size or
 *   price from another store is a guess (and may be in another currency). `fromStoreId` says where it
 *   was last bought.
 * - Titles already on the list for this store are skipped.
 */
export function buildSuggestions(items, query, storeId, limit = 6, today = localDateISO()) {
  const q = norm(query);
  if (!q) return [];
  const sid = storeId || '';
  const isHere = (i) => !sid || (i.storeId || '') === sid;
  const onList = new Set(items.filter((i) => !i.checkedDate && (i.storeId || '') === sid).map((i) => norm(i.title)));

  const byTitle = new Map();
  for (const i of items) {
    if (!i.checkedDate || !i.title.trim()) continue;
    const key = norm(i.title);
    if (!key.includes(q) || onList.has(key)) continue;
    if (!byTitle.has(key)) byTitle.set(key, []);
    byTitle.get(key).push(i);
  }

  const monthAgo = new Date(); monthAgo.setDate(monthAgo.getDate() - 30);
  const recentCutoff = localDateISO(monthAgo);
  const products = [];
  for (const [key, all] of byTitle) {
    const here = all.filter(isHere);
    const list = here.length ? here : all;
    const newestFirst = list.slice().sort((a, b) => b.checkedDate.localeCompare(a.checkedDate));
    let variants;
    if (here.length) {
      variants = uniqueVariants(newestFirst);
    } else {
      variants = [{
        title: newestFirst[0].title, quantity: '', lastDate: newestFirst[0].checkedDate,
        count: list.length, fromStoreId: newestFirst[0].storeId || '',
      }];
    }
    products.push({
      variants,
      rank: key === q ? 0 : key.startsWith(q) ? 1 : 2,
      here: here.length > 0,
      score: list.length * (newestFirst[0].checkedDate >= recentCutoff ? 2 : 1),
      title: newestFirst[0].title,
    });
  }
  products.sort((a, b) => a.rank - b.rank || Number(b.here) - Number(a.here) || b.score - a.score || a.title.localeCompare(b.title));
  if (products.length === 1) return products[0].variants.slice(0, limit);
  return products.slice(0, limit).map((p) => p.variants[0]);
}

/** Most recent purchase of this exact title (case-insensitive), preferring the same store. */
export function lastPurchase(items, title, storeId) {
  const key = norm(title);
  if (!key) return null;
  const hits = items.filter((i) => i.checkedDate && norm(i.title) === key)
    .sort((a, b) => b.checkedDate.localeCompare(a.checkedDate));
  return hits.find((i) => (i.storeId || '') === (storeId || '')) || hits[0] || null;
}

// ── Reusing earlier purchases ──────────────────────────────────────────────────

/** Keys of what is still to buy, so copying a past trip can skip things already on the list. */
export function onListKeys(items) {
  return new Set(items.filter((i) => !i.checkedDate).map((i) => (i.storeId || '') + '|' + norm(i.title)));
}
export const listKey = (item) => (item.storeId || '') + '|' + norm(item.title);

/**
 * Past shopping trips (one per day and store), newest first. `storeId` filters to one store
 * (use '*' or undefined for all); `query` filters by title/quantity/notes.
 */
export function buildTrips(items, { storeId = '*', query = '' } = {}) {
  const q = norm(query);
  const map = new Map();
  for (const i of items) {
    if (!i.checkedDate) continue;
    if (storeId !== '*' && storeId !== undefined && (i.storeId || '') !== storeId) continue;
    if (q && !(norm(i.title).includes(q) || norm(i.quantity).includes(q) || norm(i.notes).includes(q))) continue;
    const key = i.checkedDate + '|' + (i.storeId || '');
    if (!map.has(key)) map.set(key, { key, date: i.checkedDate, storeId: i.storeId || '', items: [] });
    map.get(key).items.push(i);
  }
  return [...map.values()]
    .map((t) => ({ ...t, items: t.items.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title)), total: sumPrices(t.items) }))
    .sort((a, b) => b.date.localeCompare(a.date) || a.storeId.localeCompare(b.storeId));
}

/**
 * What to put on the list when buying something again. The old price is only kept (as an estimate)
 * when it stays in the same store, because another store may charge in another currency.
 */
export function copyForList(src, { storeId = src.storeId || '', keepPrice = true } = {}) {
  const sameStore = (src.storeId || '') === (storeId || '');
  const price = keepPrice && sameStore && typeof src.price === 'number' ? src.price : null;
  return {
    title: src.title,
    quantity: src.quantity || '',
    notes: src.notes || '',
    storeId: storeId || '',
    price,
    paidAmount: price !== null ? src.paidAmount ?? null : null,
    paidCurrency: price !== null ? src.paidCurrency || '' : '',
  };
}
// ── Spending insights ──────────────────────────────────────────────────────────

/** Purchases that have a price, i.e. what counts as spending. */
function purchases(items) {
  return items.filter((i) => i.checkedDate && typeof i.price === 'number');
}

/** [{month: 'YYYY-MM', total, count}] oldest first. */
export function spendingByMonth(items) {
  const map = new Map();
  for (const i of purchases(items)) {
    const m = monthKey(i.checkedDate);
    const cur = map.get(m) || { month: m, total: 0, count: 0 };
    cur.total += i.price;
    cur.count += 1;
    map.set(m, cur);
  }
  return [...map.values()].map((e) => ({ ...e, total: roundMoney(e.total) })).sort((a, b) => a.month.localeCompare(b.month));
}

/** Spending per store in one month ('YYYY-MM'), biggest first. Items without a store are "Anywhere". */
export function storeBreakdown(items, stores, month) {
  const names = new Map(stores.map((s) => [s.id, s.name]));
  const totals = new Map();
  for (const i of purchases(items)) {
    if (monthKey(i.checkedDate) !== month) continue;
    const name = names.get(i.storeId) || (i.storeId ? 'Removed store' : 'Anywhere');
    totals.set(name, (totals.get(name) || 0) + i.price);
  }
  return [...totals.entries()].map(([name, total]) => ({ name, total: roundMoney(total) })).sort((a, b) => b.total - a.total);
}

/** Most often bought items: [{title, count, total}]. */
export function topItems(items, limit = 8) {
  const map = new Map();
  for (const i of items) {
    if (!i.checkedDate || !i.title.trim()) continue;
    const key = i.title.trim().toLowerCase();
    const cur = map.get(key) || { title: i.title.trim(), count: 0, total: 0 };
    cur.count += 1;
    cur.total += typeof i.price === 'number' ? i.price : 0;
    map.set(key, cur);
  }
  return [...map.values()]
    .map((e) => ({ ...e, total: roundMoney(e.total) }))
    .sort((a, b) => b.count - a.count || b.total - a.total || a.title.localeCompare(b.title))
    .slice(0, limit);
}

/**
 * Projected total for the current month: what is spent so far plus the average daily spending of
 * up to the previous three months for the days that remain. Null when there is nothing to base it on.
 */
export function estimateCurrentMonth(monthly, now = new Date()) {
  const key = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const current = monthly.find((m) => m.month === key);
  if (!current) return null;
  const previous = monthly.filter((m) => m.month < key).slice(-3);
  if (previous.length === 0) return null;
  const dailyAverage = previous.reduce((sum, m) => {
    const [y, mo] = m.month.split('-').map(Number);
    return sum + m.total / new Date(y, mo, 0).getDate();
  }, 0) / previous.length;
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const remaining = Math.max(0, daysInMonth - now.getDate());
  return roundMoney(current.total + dailyAverage * remaining);
}

// ── Import from the old Nutri app ──────────────────────────────────────────────

/**
 * Convert rows from a Nutri spreadsheet into Valu Groceries rows.
 *   Nutri Groceries!A2:H : id, title, amount, price ("12,50"), order, locationId, checkedAtEpochMs, dateFormula
 *   Nutri Locations!A2:E : title, order, id, hidden ("true"/"false"), city
 * IDs get an "n_" prefix so importing the same sheet twice never creates duplicates.
 * Nutri prices have no currency, so they are taken to be in the group's base currency.
 */
export function convertNutriRows(groceryRows, locationRows, now = new Date()) {
  const stores = [];
  const storeIds = new Set();
  (locationRows || []).forEach((r, idx) => {
    const title = String(r?.[0] ?? '').trim();
    const oldId = String(r?.[2] ?? '').trim();
    if (!oldId || !title) return;
    const id = 'n_' + oldId;
    if (storeIds.has(id)) return;
    storeIds.add(id);
    stores.push({
      id, name: title, city: String(r?.[4] ?? '').trim(),
      order: parseInt(r?.[1], 10) || idx,
      hidden: String(r?.[3] ?? '').trim().toLowerCase().replace(/^'/, '') === 'true',
      currency: '',
    });
  });

  const items = [];
  const itemIds = new Set();
  (groceryRows || []).forEach((r, idx) => {
    const title = String(r?.[1] ?? '').trim();
    const oldId = String(r?.[0] ?? '').trim();
    if (!oldId || !title) return;
    const id = 'n_' + oldId;
    if (itemIds.has(id)) return;
    itemIds.add(id);
    const price = parseAmount(String(r?.[3] ?? ''));
    const oldStore = String(r?.[5] ?? '').trim();
    const checkedDate = dateFromEpochMs(r?.[6]);
    items.push({
      id,
      title,
      quantity: cleanQuantity(r?.[2]),
      price: Number.isFinite(price) && price !== 0 ? price : null,
      storeId: storeIds.has('n_' + oldStore) ? 'n_' + oldStore : '',
      order: parseInt(r?.[4], 10) || idx,
      checkedDate,
      notes: '',
      paidAmount: null,
      paidCurrency: '',
      createdAt: checkedDate ? checkedDate + 'T12:00:00.000Z' : now.toISOString(),
    });
  });
  return { stores, items };
}

// -- History: periods, sorting, products, copying, moving ----------------------

/**
 * The date range of a History period. kind: 'all', 'month' (a = 'YYYY-MM'), 'year' (a = 'YYYY'),
 * 'day' (a = 'YYYY-MM-DD') or 'range' (a = from, b = to, in either order). Empty from/to = no limit.
 */
export function periodRange(kind, a = '', b = '') {
  if (kind === 'month' && /^\d{4}-\d{2}$/.test(a)) {
    const [y, m] = a.split('-').map(Number);
    return { from: `${a}-01`, to: `${a}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}` };
  }
  if (kind === 'year' && /^\d{4}$/.test(a)) return { from: `${a}-01-01`, to: `${a}-12-31` };
  if (kind === 'day' && a) return { from: a, to: a };
  if (kind === 'range' && (a || b)) {
    if (a && b && a > b) return { from: b, to: a };
    return { from: a, to: b };
  }
  return { from: '', to: '' };
}

export function inRange(date, range) {
  return !!date && (!range.from || date >= range.from) && (!range.to || date <= range.to);
}

const hasPrice = (i) => typeof i.price === 'number' && i.price > 0;

/**
 * Sort purchases. 'newest' / 'oldest' (by day), 'price_desc' / 'price_asc' (items without a price last),
 * 'name' (A-Z) or 'store' (A-Z). Ties fall back to the newest day first, then list order.
 */
export function sortPurchases(list, sortId = 'newest', storeNameOf = () => '') {
  const byDateDesc = (a, b) => b.checkedDate.localeCompare(a.checkedDate) || a.order - b.order;
  const byPrice = (dir) => (a, b) => {
    const pa = hasPrice(a) ? a.price : null;
    const pb = hasPrice(b) ? b.price : null;
    if (pa === null && pb === null) return byDateDesc(a, b);
    if (pa === null) return 1;
    if (pb === null) return -1;
    return (pa - pb) * dir || byDateDesc(a, b);
  };
  const cmp = {
    newest: byDateDesc,
    oldest: (a, b) => a.checkedDate.localeCompare(b.checkedDate) || a.order - b.order,
    price_desc: byPrice(-1),
    price_asc: byPrice(1),
    name: (a, b) => a.title.localeCompare(b.title) || byDateDesc(a, b),
    store: (a, b) => (storeNameOf(a.storeId) || 'Anywhere').localeCompare(storeNameOf(b.storeId) || 'Anywhere') || byDateDesc(a, b),
  }[sortId] || byDateDesc;
  return [...list].sort(cmp);
}

/** A quantity as a plain number (decimal comma allowed), or null when it is empty or old free text. */
export function quantityNumber(quantity) {
  const q = parseFloat(String(quantity ?? '').trim().replace(',', '.'));
  return Number.isFinite(q) && q > 0 ? q : null;
}

/**
 * What a purchase measures, so that prices can be compared fairly: { basis, amount } or null when it cannot be
 * told. Without more knowledge a quantity follows the app's convention: from 10 up it is an amount of weight or
 * volume ('wt'), a small number counts pieces, and no quantity is one piece.
 */
export function defaultMeasure(item) {
  const raw = String(item.quantity ?? '').trim();
  const q = quantityNumber(raw);
  if (q === null) return raw === '' ? { basis: 'piece', amount: 1 } : null;
  return q >= 10 ? { basis: 'wt', amount: q } : { basis: 'piece', amount: q };
}

/** Weight (g, ml or unknown which of the two) and pieces cannot be compared with each other. */
const familyOf = (basis) => (basis === 'piece' ? 'piece' : 'weight');

/**
 * The price of one comparable unit in the given family: per 100 g / 100 ml for weight, per piece otherwise.
 * A purchase counted one way can still be read the other way when its measure knows both (`grams` of a piece
 * purchase, `pieces` of a weight purchase). Returns null when it cannot.
 */
function unitPriceIn(family, price, m) {
  if (family === 'piece') {
    const pieces = m.basis === 'piece' ? m.amount : m.pieces;
    return pieces > 0 ? price / pieces : null;
  }
  const grams = m.basis === 'piece' ? m.grams : m.amount;
  return grams > 0 ? (price / grams) * 100 : null;
}

const UNIT_LABELS = { g: 'per 100 g', ml: 'per 100 ml', wt: 'per 100 g or ml', piece: 'per piece' };

/**
 * One row per product (same name, ignoring case) over the given purchases: how often it was bought, what it
 * cost (average / lowest / highest, purchases with a price only) and where it was cheapest.
 *
 * A price is for the whole line, so a bigger pack always looks dearer. Stores are therefore compared on the
 * price of one unit: per 100 g (or ml) when the amount is known, per piece otherwise. `measure(item)` says what
 * a purchase measures ({basis: 'g' | 'ml' | 'wt' | 'piece', amount, grams?, pieces?}, or null); the default reads
 * the quantity.
 * A product uses the way it was bought most often (counted in pieces, or by weight). A purchase counted the
 * other way is converted when its measure knows both (a piece weight), otherwise it is left out of that
 * comparison and counted in `unitSkipped`. `unit` is null when no purchase could be compared.
 */
export function productStats(list, storeNameOf = () => '', measure = defaultMeasure) {
  const groups = new Map();
  for (const i of list) {
    const key = String(i.title || '').trim().toLowerCase();
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(i);
  }
  const avgOf = (nums) => (nums.length ? roundMoney(nums.reduce((s, n) => s + n, 0) / nums.length) : null);
  const mean = (nums) => (nums.length ? nums.reduce((s, n) => s + n, 0) / nums.length : null);
  const round4 = (n) => (n === null ? null : Math.round(n * 10000) / 10000);
  return [...groups.entries()].map(([key, rows]) => {
    const newest = rows.slice().sort((a, b) => b.checkedDate.localeCompare(a.checkedDate));
    const prices = rows.filter(hasPrice).map((i) => i.price);
    const lastPriced = newest.find(hasPrice);

    // How this product was bought most often (weight wins a tie: it compares across pack sizes).
    const measured = new Map(rows.filter(hasPrice).map((i) => [i, measure(i)]).filter(([, m]) => m));
    const tally = { weight: 0, piece: 0 };
    for (const m of measured.values()) tally[familyOf(m.basis)]++;
    const family = tally.weight === 0 && tally.piece === 0 ? null : tally.weight >= tally.piece ? 'weight' : 'piece';
    const unitPrice = new Map();
    let converted = 0;
    let gramsPerPiece = 0;
    for (const i of rows) {
      if (!hasPrice(i) || !measured.has(i)) continue;
      const m = measured.get(i);
      const u = unitPriceIn(family, i.price, m);
      if (u === null) continue;
      unitPrice.set(i, u);
      if ((family === 'piece') !== (m.basis === 'piece')) { // read the other way, through the piece weight
        converted++;
        gramsPerPiece = m.basis === 'piece' ? m.grams / m.amount : m.amount / m.pieces;
      }
    }
    let basis = null;
    if (family === 'piece') basis = 'piece';
    else if (family === 'weight') {
      const kinds = new Set([...unitPrice.keys()].map((i) => measured.get(i)).filter((m) => m.basis !== 'piece').map((m) => m.basis));
      basis = kinds.size === 1 ? [...kinds][0] : kinds.size === 0 ? 'g' : 'wt';
    }
    const unitValues = [...unitPrice.values()];
    const lastUnit = newest.find((i) => unitPrice.has(i));

    const stores = new Map();
    for (const i of rows) {
      const sid = i.storeId || '';
      if (!stores.has(sid)) stores.set(sid, { storeId: sid, name: storeNameOf(sid) || 'Anywhere', count: 0, prices: [], units: [], last: '' });
      const s = stores.get(sid);
      s.count++;
      if (hasPrice(i)) s.prices.push(i.price);
      if (unitPrice.has(i)) s.units.push(unitPrice.get(i));
      if (i.checkedDate > s.last) s.last = i.checkedDate;
    }
    const byStore = [...stores.values()].map((s) => ({
      storeId: s.storeId, name: s.name, count: s.count, last: s.last,
      avg: avgOf(s.prices), min: s.prices.length ? Math.min(...s.prices) : null, max: s.prices.length ? Math.max(...s.prices) : null,
      unitAvg: round4(mean(s.units)), unitMin: s.units.length ? round4(Math.min(...s.units)) : null, unitMax: s.units.length ? round4(Math.max(...s.units)) : null,
    })).sort((a, b) => (a.unitAvg ?? Infinity) - (b.unitAvg ?? Infinity) || (a.avg ?? Infinity) - (b.avg ?? Infinity) || b.count - a.count);
    const comparable = byStore.filter((s) => s.unitAvg !== null);
    const cheapestStoreId = comparable.length > 1 && comparable[0].unitAvg < comparable[comparable.length - 1].unitAvg ? comparable[0].storeId : null;
    return {
      key, title: newest[0].title, count: rows.length, priced: prices.length,
      total: roundMoney(prices.reduce((s, n) => s + n, 0)), avg: avgOf(prices),
      min: prices.length ? Math.min(...prices) : null, max: prices.length ? Math.max(...prices) : null,
      lastDate: newest[0].checkedDate, lastPrice: lastPriced ? lastPriced.price : null,
      unit: basis ? { basis, label: UNIT_LABELS[basis] } : null,
      unitAvg: round4(mean(unitValues)), unitMin: unitValues.length ? round4(Math.min(...unitValues)) : null,
      unitMax: unitValues.length ? round4(Math.max(...unitValues)) : null, unitLast: lastUnit ? round4(unitPrice.get(lastUnit)) : null,
      unitSkipped: prices.length - unitValues.length,
      // Purchases counted the other way (kilos of bananas next to bunches) and read through the piece weight.
      unitConverted: converted, gramsPerPiece: converted ? Math.round(gramsPerPiece) : 0,
      byStore, cheapestStoreId,
    };
  });
}

export const COPY_FIELDS = [
  { id: 'date', label: 'Date', header: 'Date' },
  { id: 'title', label: 'Item', header: 'Item' },
  { id: 'quantity', label: 'Quantity', header: 'Quantity' },
  { id: 'store', label: 'Store', header: 'Store' },
  { id: 'city', label: 'City', header: 'City' },
  { id: 'price', label: 'Price', header: 'Price' },
  { id: 'paid', label: 'Paid (original currency)', header: 'Paid' },
  { id: 'notes', label: 'Notes', header: 'Notes' },
];

/**
 * Text for the clipboard. format 'tsv' pastes straight into a spreadsheet, 'csv' into other tools.
 * Fields come out in the order of COPY_FIELDS, whatever order they are given in.
 */
export function itemsToText(list, {
  fields = ['date', 'title', 'quantity', 'store', 'price'], format = 'tsv', header = true,
  storeNameOf = () => '', storeCityOf = () => '', num = (n) => String(n),
} = {}) {
  const chosen = COPY_FIELDS.filter((f) => fields.includes(f.id));
  if (chosen.length === 0) return '';
  const value = (i, id) => {
    switch (id) {
      case 'date': return i.checkedDate || '';
      case 'title': return i.title || '';
      case 'quantity': return i.quantity || '';
      case 'store': return storeNameOf(i.storeId) || (i.storeId ? '' : 'Anywhere');
      case 'city': return storeCityOf(i.storeId) || '';
      case 'price': return typeof i.price === 'number' ? num(i.price) : '';
      case 'paid': return i.paidAmount && i.paidCurrency ? `${num(i.paidAmount)} ${i.paidCurrency}` : '';
      case 'notes': return i.notes || '';
      default: return '';
    }
  };
  const cell = format === 'csv'
    ? (s) => (/[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s)
    : (s) => s.replace(/[\t\r\n]+/g, ' ');
  const sep = format === 'csv' ? ',' : '\t';
  const lines = list.map((i) => chosen.map((f) => cell(String(value(i, f.id)))).join(sep));
  if (header) lines.unshift(chosen.map((f) => cell(f.header)).join(sep));
  return lines.join('\n');
}

/**
 * Move items to another store (mutates them). A price is in some currency (what was paid, or the base
 * currency): when the new store uses another one the price no longer means anything there, so it is cleared.
 * Returns how many prices were cleared.
 */
export function moveToStore(list, storeId, { startOrder = 0, targetCurrency, baseCurrency, trackPrices = true } = {}) {
  let order = startOrder;
  let cleared = 0;
  for (const i of list) {
    i.storeId = storeId;
    i.order = order++;
    const priceCurrency = i.paidAmount && i.paidCurrency ? i.paidCurrency : baseCurrency;
    if (trackPrices && typeof i.price === 'number' && priceCurrency !== targetCurrency) {
      i.price = null; i.paidAmount = null; i.paidCurrency = '';
      cleared++;
    }
  }
  return cleared;
}

// ── Defaults ───────────────────────────────────────────────────────────────────

const REGION_CURRENCY = {
  US: 'USD', CA: 'CAD', GB: 'GBP', AU: 'AUD', NZ: 'NZD', JP: 'JPY', CN: 'CNY', IN: 'INR', CH: 'CHF',
  SE: 'SEK', NO: 'NOK', DK: 'DKK', PL: 'PLN', CZ: 'CZK', HU: 'HUF', MX: 'MXN', BR: 'BRL', ZA: 'ZAR',
  KR: 'KRW', SG: 'SGD', HK: 'HKD', TW: 'TWD', TR: 'TRY',
  DE: 'EUR', FR: 'EUR', ES: 'EUR', IT: 'EUR', NL: 'EUR', BE: 'EUR', AT: 'EUR', PT: 'EUR', IE: 'EUR',
  FI: 'EUR', GR: 'EUR', LU: 'EUR', SK: 'EUR', SI: 'EUR', EE: 'EUR', LV: 'EUR', LT: 'EUR', CY: 'EUR',
  MT: 'EUR', HR: 'EUR',
};

/** A sensible starting base currency from the device language, e.g. 'en-CA' gives CAD. Falls back to USD. */
export function guessBaseCurrency(locale = (typeof navigator !== 'undefined' ? navigator.language : '')) {
  const region = String(locale || '').split('-')[1];
  return (region && REGION_CURRENCY[region.toUpperCase()]) || 'USD';
}
