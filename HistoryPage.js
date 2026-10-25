/**
 * History page: everything that was ticked off.
 *
 *  - Period: all time, a year, a month, one day or a date range.
 *  - Filters: search (item, notes, store, city) and one or more stores.
 *  - Two views: by day (purchases) or by product (how often, total / average / lowest / highest price, cheapest store).
 *  - Tap a purchase to correct it (same sheet as on the list) or to put it on the list again.
 *  - Select: add to the list, change the date, move to a store, copy to the clipboard (you choose the fields) or delete.
 *
 * Changes are shown at once and saved in the background (one write at a time); a failed write is rolled back.
 */

import SheetsApi, { TABS } from './sheetsApi.js';
import ItemSheet, { amountText } from './ItemSheet.js';
import { STORAGE_PREFIX } from './config.js';
import { copyText } from './clipboard.js';
import {
  formatCurrency, rowToItem, itemToRow, nextOrder, sumPrices, monthKey, localDateISO, isFutureDate, copyForList, listKey, onListKeys,
  periodRange, inRange, sortPurchases, productStats, COPY_FIELDS, itemsToText, moveToStore,
} from './groceryLogic.js';
import { formatDayHeading, formatMonthLabel, formatDateLabel } from './dateLabels.js';
import { rowToNutrition, readLookup, nutritionMeasure } from './nutritionLogic.js';
import { groupNutritionOn } from './nutritionFlags.js';

const { ref, reactive, computed, watch, inject, onMounted } = Vue;

const PAGE_SIZE = 150;
const COPY_PREFS_KEY = STORAGE_PREFIX + 'copy_prefs';
const DEFAULT_COPY = { fields: ['date', 'title', 'quantity', 'store', 'price'], format: 'tsv', header: true };

const SORTS = [
  { id: 'newest', label: 'Newest first', icon: 'arrow_downward' },
  { id: 'oldest', label: 'Oldest first', icon: 'arrow_upward' },
  { id: 'price_desc', label: 'Price: high to low', icon: 'trending_down' },
  { id: 'price_asc', label: 'Price: low to high', icon: 'trending_up' },
  { id: 'name', label: 'Name A–Z', icon: 'sort_by_alpha' },
  { id: 'store', label: 'Store A–Z', icon: 'storefront' },
];
const PRODUCT_SORTS = [
  { id: 'most', label: 'Bought most often', icon: 'repeat' },
  { id: 'recent', label: 'Bought most recently', icon: 'schedule' },
  { id: 'total_desc', label: 'Total spent: high to low', icon: 'payments' },
  { id: 'avg_desc', label: 'Average price: high to low', icon: 'trending_down' },
  { id: 'name', label: 'Name A–Z', icon: 'sort_by_alpha' },
];

function loadCopyPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(COPY_PREFS_KEY) || 'null');
    if (!saved) return { ...DEFAULT_COPY, fields: [...DEFAULT_COPY.fields] };
    const known = COPY_FIELDS.map((f) => f.id);
    return {
      fields: Array.isArray(saved.fields) ? saved.fields.filter((f) => known.includes(f)) : [...DEFAULT_COPY.fields],
      format: saved.format === 'csv' ? 'csv' : 'tsv',
      header: saved.header !== false,
    };
  } catch {
    return { ...DEFAULT_COPY, fields: [...DEFAULT_COPY.fields] };
  }
}

export default {
  components: { ItemSheet },
  props: ['sheetId', 'settings', 'stores', 'changeTick'],
  emits: ['go-home', 'navigate'],

  setup(props) {
    const showAlert = inject('showAlert', (m) => window.alert(m));
    const showConfirm = inject('showConfirm', (m) => Promise.resolve(window.confirm(m)));

    const items = ref([]);
    const nutriEntries = ref([]);
    const loading = ref(true);
    const loadError = ref('');

    // What is shown
    const period = reactive({ kind: 'month', a: '', b: '' });
    const storeFilter = ref([]); // store ids; '__none' = Anywhere
    const search = ref('');
    const view = ref('days');
    const sortId = ref('newest');
    const productSortId = ref('most');
    const limit = ref(PAGE_SIZE);
    const expandedProduct = ref('');
    let periodChosen = false;

    // Sheets
    const sheets = reactive({ period: false, store: false, sort: false, date: false, move: false, copy: false });
    const storeSearch = ref('');
    const customFrom = ref('');
    const customTo = ref('');
    const itemSheet = reactive({ open: false, seed: null });
    const bulkDate = ref('');
    const copy = reactive(loadCopyPrefs());

    // Selection
    const selecting = ref(false);
    const selectedIds = ref([]);
    const selectedSet = computed(() => new Set(selectedIds.value));

    const toast = ref('');
    let toastTimer = 0;

    const baseCurrency = computed(() => props.settings?.baseCurrency || 'USD');
    const trackPrices = computed(() => (props.settings?.trackPrices ?? 'true') !== 'false');
    const groupNutri = computed(() => groupNutritionOn(props.settings));
    const fmt = (n) => formatCurrency(n, baseCurrency.value);
    const today = () => localDateISO();
    const yesterday = () => { const d = new Date(); d.setDate(d.getDate() - 1); return localDateISO(d); };
    const storeById = computed(() => new Map((props.stores || []).map((s) => [s.id, s])));
    const storeName = (id) => storeById.value.get(id)?.name || '';
    const storeCity = (id) => storeById.value.get(id)?.city || '';
    const effStore = (i) => (storeById.value.has(i.storeId) ? i.storeId : '');
    const paidText = (i) => (i.paidAmount ? formatCurrency(i.paidAmount, i.paidCurrency) : '');
    const activeStores = computed(() =>
      [...(props.stores || [])].filter((s) => !s.hidden).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name)));

    const purchases = computed(() => items.value.filter((i) => i.checkedDate));

    const duplicateNames = computed(() => {
      const seen = new Map();
      for (const s of props.stores || []) seen.set(s.name.toLowerCase(), (seen.get(s.name.toLowerCase()) || 0) + 1);
      return new Set([...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k));
    });
    /** "Metro" or, when several stores share the name, "Metro · Toronto". */
    function storeLabel(id) {
      const name = storeName(id);
      if (!name) return 'Anywhere';
      const city = storeCity(id);
      return city && duplicateNames.value.has(name.toLowerCase()) ? name + ' · ' + city : name;
    }
    const storeButtonLabel = computed(() => {
      const ids = storeFilter.value;
      if (ids.length === 0) return 'Store';
      if (ids.length === 1) return ids[0] === '__none' ? 'Anywhere' : storeLabel(ids[0]);
      return ids.length + ' stores';
    });

    // ── Period ────────────────────────────────────────────────────────────────
    const range = computed(() => periodRange(period.kind, period.a, period.b));

    /**
     * Stores that actually appear in the current period (counts for that period). The picker only
     * lists these — other stores are irrelevant until you change the period.
     */
    const periodStores = computed(() => {
      const counts = new Map();
      for (const i of purchases.value) {
        if (!inRange(i.checkedDate, range.value)) continue;
        const id = effStore(i);
        counts.set(id, (counts.get(id) || 0) + 1);
      }
      const list = (props.stores || []).filter((s) => counts.has(s.id))
        .map((s) => ({ id: s.id, name: s.name, city: s.city || '', count: counts.get(s.id) }))
        .sort((a, b) => a.name.localeCompare(b.name) || a.city.localeCompare(b.city));
      if (counts.has('')) list.push({ id: '__none', name: 'Anywhere', city: '', count: counts.get('') });
      return list;
    });
    const periodStoreIds = computed(() => periodStores.value.map((s) => s.id));
    const periodLabel = computed(() => {
      if (period.kind === 'month') return formatMonthLabel(period.a);
      if (period.kind === 'year') return period.a;
      if (period.kind === 'day') return formatDayHeading(period.a);
      if (period.kind === 'range') {
        const { from, to } = range.value;
        if (from && to) return formatDateLabel(from) + ' – ' + formatDateLabel(to);
        return from ? 'From ' + formatDateLabel(from) : 'Until ' + formatDateLabel(to);
      }
      return 'All time';
    });
    const periodOptions = computed(() => {
      const years = new Map();
      for (const i of purchases.value) {
        const m = monthKey(i.checkedDate);
        const y = m.slice(0, 4);
        if (!years.has(y)) years.set(y, { key: y, total: 0, count: 0, months: new Map() });
        const yr = years.get(y);
        if (!yr.months.has(m)) yr.months.set(m, { key: m, label: formatMonthLabel(m), total: 0, count: 0 });
        const mo = yr.months.get(m);
        const p = typeof i.price === 'number' ? i.price : 0;
        yr.total += p; yr.count++; mo.total += p; mo.count++;
      }
      return [...years.values()]
        .sort((a, b) => b.key.localeCompare(a.key))
        .map((y) => ({ ...y, months: [...y.months.values()].sort((a, b) => b.key.localeCompare(a.key)) }));
    });
    const allTimeTotal = computed(() => sumPrices(purchases.value));

    function setPeriod(kind, a = '', b = '') {
      periodChosen = true;
      Object.assign(period, { kind, a, b });
      sheets.period = false;
    }
    function openPeriodSheet() {
      customFrom.value = period.kind === 'day' || period.kind === 'range' ? range.value.from : '';
      customTo.value = period.kind === 'range' ? range.value.to : '';
      sheets.period = true;
    }
    /** One date = that day; two dates = a range. */
    function applyCustom() {
      const from = customFrom.value;
      const to = customTo.value;
      if (!from && !to) return;
      if (from && to && from !== to) setPeriod('range', from, to);
      else setPeriod('day', from || to);
    }
    function chooseDefaultPeriod() {
      if (periodChosen) return;
      const current = monthKey(localDateISO());
      const months = periodOptions.value.flatMap((y) => y.months.map((m) => m.key));
      const key = months.includes(current) ? current : months[0];
      if (key) Object.assign(period, { kind: 'month', a: key, b: '' });
      else Object.assign(period, { kind: 'all', a: '', b: '' });
    }

    // ── The list ──────────────────────────────────────────────────────────────
    const filtered = computed(() => {
      const q = search.value.trim().toLowerCase();
      const stores = storeFilter.value;
      return purchases.value.filter((i) => {
        if (!inRange(i.checkedDate, range.value)) return false;
        if (stores.length && !stores.includes(effStore(i) || '__none')) return false;
        if (!q) return true;
        const sid = effStore(i);
        return i.title.toLowerCase().includes(q) || (i.notes || '').toLowerCase().includes(q)
          || storeName(sid).toLowerCase().includes(q) || storeCity(sid).toLowerCase().includes(q);
      });
    });

    /**
     * Empty filter = every store in this period. Checkmarks stay put while you toggle; the row order
     * does not reshuffle, so you can turn stores off and on without hunting for them again.
     */
    function storeFilterChecked(id) {
      if (!storeFilter.value.length) return true;
      return storeFilter.value.includes(id);
    }

    function setStoreFilter(ids) {
      const all = periodStoreIds.value;
      if (!ids.length || (ids.length === all.length && all.every((id) => ids.includes(id)))) {
        storeFilter.value = [];
        return;
      }
      storeFilter.value = ids;
    }

    function toggleStoreFilter(id) {
      if (!storeFilter.value.length) {
        setStoreFilter(periodStoreIds.value.filter((x) => x !== id));
        return;
      }
      const ids = storeFilter.value;
      setStoreFilter(ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]);
    }

    /** Only stores with purchases in this period; A–Z (stable while toggles change). */
    const storeFilterOptions = computed(() => {
      const q = storeSearch.value.trim().toLowerCase();
      return periodStores.value.filter((s) => !q || s.name.toLowerCase().includes(q) || s.city.toLowerCase().includes(q));
    });

    const sorted = computed(() => sortPurchases(filtered.value, sortId.value, storeName));
    const grouped = computed(() => sortId.value === 'newest' || sortId.value === 'oldest');
    const shown = computed(() => sorted.value.slice(0, limit.value));
    const groups = computed(() => {
      if (!grouped.value) return [{ date: '', items: shown.value, total: 0, flat: true }];
      const map = new Map();
      for (const i of shown.value) {
        if (!map.has(i.checkedDate)) map.set(i.checkedDate, []);
        map.get(i.checkedDate).push(i);
      }
      return [...map.entries()].map(([date, list]) => ({ date, items: list, total: sumPrices(list), flat: false }));
    });
    const total = computed(() => sumPrices(filtered.value));

    // Nutrition data (read only) tells how much a purchase weighs, so prices can be compared per 100 g.
    const measure = computed(() => nutritionMeasure(readLookup(nutriEntries.value, filtered.value.map((i) => i.title))));

    const products = computed(() => {
      const list = productStats(filtered.value, storeName, measure.value);
      const by = {
        most: (a, b) => b.count - a.count || a.title.localeCompare(b.title),
        recent: (a, b) => b.lastDate.localeCompare(a.lastDate) || a.title.localeCompare(b.title),
        total_desc: (a, b) => (b.total ?? 0) - (a.total ?? 0) || a.title.localeCompare(b.title),
        avg_desc: (a, b) => (b.avg ?? -1) - (a.avg ?? -1) || a.title.localeCompare(b.title),
        name: (a, b) => a.title.localeCompare(b.title),
      }[productSortId.value];
      return list.sort(by);
    });
    const shownProducts = computed(() => products.value.slice(0, limit.value));

    const remaining = computed(() => (view.value === 'days' ? sorted.value.length : products.value.length) - limit.value);
    const sortOptions = computed(() => (view.value === 'days' ? SORTS : PRODUCT_SORTS));
    const activeSortId = computed(() => (view.value === 'days' ? sortId.value : productSortId.value));
    const hasFilters = computed(() => period.kind !== 'all' || storeFilter.value.length > 0 || !!search.value.trim());

    watch([() => period.kind, () => period.a, () => period.b, storeFilter, search, sortId, productSortId, view], () => {
      limit.value = PAGE_SIZE;
      expandedProduct.value = '';
    });
    // Drop store picks that no longer appear in the new period (or collapse back to “all”).
    watch(periodStoreIds, (ids) => {
      if (!storeFilter.value.length) return;
      const allowed = new Set(ids);
      setStoreFilter(storeFilter.value.filter((id) => allowed.has(id)));
    });
    watch(view, () => { if (view.value !== 'days') clearSelection(); });

    function pickSort(id) {
      if (view.value === 'days') sortId.value = id; else productSortId.value = id;
      sheets.sort = false;
    }
    function clearFilters() {
      periodChosen = true;
      Object.assign(period, { kind: 'all', a: '', b: '' });
      storeFilter.value = [];
      search.value = '';
    }
    /** A price per unit is only worth showing when it says more than the price itself (weight, or different quantities). */
    function showUnit(p) {
      if (!p.unit || p.unitAvg === null) return false;
      return p.unit.basis !== 'piece' || (p.avg !== null && Math.abs(p.unitAvg - p.avg) > 0.005);
    }
    /** The footnote under a product's stores: how the comparison was made and what it could not include. */
    function unitNote(p) {
      const n = (k, one, many) => (k === 1 ? one : many);
      let text = 'Stores are compared ' + p.unit.label + ', so pack sizes do not matter.';
      if (p.unitConverted > 0) {
        text += ' ' + p.unitConverted + ' ' + n(p.unitConverted, 'purchase was', 'purchases were') + ' logged the other way (pieces or grams) and ' +
          n(p.unitConverted, 'was', 'were') + ' converted with ' + p.gramsPerPiece + ' g per piece from Nutrition, so ' + n(p.unitConverted, 'its price is', 'their prices are') + ' approximate.';
      }
      if (p.unitSkipped > 0) {
        text += ' ' + p.unitSkipped + ' ' + n(p.unitSkipped, 'purchase has', 'purchases have') + ' a quantity that cannot be compared and ' + n(p.unitSkipped, 'is', 'are') +
          ' left out. Give ' + n(p.unitSkipped, 'it', 'them') + ' a clear quantity (2000 for 2 kg or 2 L, for example) to include ' + n(p.unitSkipped, 'it', 'them') + '.';
      }
      if (p.unit.basis === 'wt') text += ' Add this product to Nutrition to tell grams from millilitres.';
      return text;
    }    function toggleProduct(key) { expandedProduct.value = expandedProduct.value === key ? '' : key; }
    function showPurchases(p) { search.value = p.title; view.value = 'days'; }

    // ── Loading and saving ────────────────────────────────────────────────────
    let writeChain = Promise.resolve();
    /** Writes run one after another, so two quick changes can never race each other. */
    function enqueue(fn) {
      const p = writeChain.then(fn);
      writeChain = p.catch(() => {});
      return p;
    }
    function say(text) { toast.value = text; clearTimeout(toastTimer); toastTimer = setTimeout(() => { toast.value = ''; }, 3800); }

    async function load(silent = false, announce = false) {
      const sid = props.sheetId;
      if (!sid) return;
      if (!silent) { loading.value = true; loadError.value = ''; }
      try {
        const [rows, nutriRows] = await Promise.all([
          SheetsApi.getTabData(sid, TABS.ITEMS),
          groupNutri.value ? SheetsApi.getTabData(sid, TABS.NUTRITION).catch(() => []) : Promise.resolve([]),
        ]);
        if (sid !== props.sheetId) return;
        items.value = rows.map(rowToItem).filter((i) => i.id && i.title.trim());
        nutriEntries.value = nutriRows.map(rowToNutrition).filter((e) => e.id);
        loadError.value = '';
        chooseDefaultPeriod();
        if (announce) say('Up to date');
      } catch {
        if (!silent) loadError.value = 'Could not load your history. Check your connection and try again.';
        else if (announce) showAlert('Could not refresh. Check your connection and try again.');
      } finally {
        loading.value = false;
      }
    }

    function persist(item, revert) {
      return enqueue(() => SheetsApi.updateRow(props.sheetId, TABS.ITEMS, item.id, itemToRow(item))).catch(() => {
        revert();
        showAlert('Could not save that change. Check your connection and try again.');
      });
    }

    // ── One purchase ──────────────────────────────────────────────────────────
    function onRow(i) {
      if (selecting.value) { toggleSelected(i.id); return; }
      itemSheet.seed = i;
      itemSheet.open = true;
    }
    function closeSheet() { itemSheet.open = false; }

    function onSheetSave({ id, values: v }) {
      const item = items.value.find((i) => i.id === id);
      closeSheet();
      if (!item) return;
      const before = { ...item };
      Object.assign(item, v);
      const backOnList = !item.checkedDate;
      if (backOnList) item.order = nextOrder(items.value.filter((i) => i !== item), item.storeId);
      persist(item, () => Object.assign(item, before));
      if (backOnList) say('"' + item.title + '" is back on your list');
    }

    /** Puts copies of the given purchases on the shopping list (skipping what is already on it). */
    function addToList(chosen) {
      const all = items.value;
      const keys = onListKeys(all);
      const nextBy = {};
      const fresh = [];
      let skipped = 0;
      for (const src of chosen) {
        const storeId = storeById.value.has(src.storeId) ? src.storeId : '';
        const spec = copyForList(src, { storeId, keepPrice: trackPrices.value });
        if (keys.has(listKey(spec))) { skipped++; continue; }
        keys.add(listKey(spec));
        if (nextBy[storeId] === undefined) nextBy[storeId] = nextOrder(all, storeId);
        fresh.push({ ...spec, id: SheetsApi.generateId(), order: nextBy[storeId]++, checkedDate: '', createdAt: new Date().toISOString() });
      }
      if (fresh.length) {
        all.push(...fresh);
        enqueue(() => SheetsApi.appendRows(props.sheetId, TABS.ITEMS, fresh.map(itemToRow))).catch(() => {
          items.value = items.value.filter((i) => !fresh.includes(i));
          showAlert('Could not add them to your list. Check your connection and try again.');
        });
      }
      say(fresh.length
        ? 'Added ' + fresh.length + (fresh.length === 1 ? ' item' : ' items') + ' to your list' + (skipped ? ' · ' + skipped + ' already there' : '')
        : (chosen.length === 1 ? 'Already on your list' : 'Everything was already on your list'));
    }
    function addFromSheet(id) {
      const item = items.value.find((i) => i.id === id);
      closeSheet();
      if (item) addToList([item]);
    }

    async function deleteItems(list) {
      const n = list.length;
      if (!n) return false;
      const what = n === 1 ? '"' + list[0].title + '"' : n + ' items';
      if (!(await showConfirm('Delete ' + what + ' from your history?'))) return false;
      const ids = list.map((i) => i.id);
      const removed = list.slice();
      items.value = items.value.filter((i) => !ids.includes(i.id));
      enqueue(() => SheetsApi.deleteRows(props.sheetId, TABS.ITEMS, ids)).catch(() => {
        items.value.push(...removed);
        showAlert('Could not delete. Check your connection and try again.');
      });
      return true;
    }
    async function deleteFromSheet(id) {
      const item = items.value.find((i) => i.id === id);
      if (item && (await deleteItems([item]))) closeSheet();
    }

    // ── Selection and bulk actions ────────────────────────────────────────────
    function toggleSelect() { selecting.value = !selecting.value; selectedIds.value = []; }
    function clearSelection() { selecting.value = false; selectedIds.value = []; }
    function toggleSelected(id) {
      const idx = selectedIds.value.indexOf(id);
      if (idx >= 0) selectedIds.value.splice(idx, 1); else selectedIds.value.push(id);
    }
    const selectedItems = computed(() => sortPurchases(items.value.filter((i) => i.checkedDate && selectedSet.value.has(i.id)), sortId.value, storeName));
    const selectedTotal = computed(() => {
      const priced = selectedItems.value.filter((i) => typeof i.price === 'number');
      return trackPrices.value && priced.length ? sumPrices(priced) : null;
    });
    const daySelected = (d) => d.items.length > 0 && d.items.every((i) => selectedSet.value.has(i.id));
    function toggleDay(d) {
      const ids = d.items.map((i) => i.id);
      selectedIds.value = daySelected(d)
        ? selectedIds.value.filter((id) => !ids.includes(id))
        : [...new Set([...selectedIds.value, ...ids])];
    }
    const allSelected = computed(() => sorted.value.length > 0 && sorted.value.every((i) => selectedSet.value.has(i.id)));
    function toggleAll() {
      selectedIds.value = allSelected.value ? [] : sorted.value.map((i) => i.id);
    }

    function addSelectedToList() {
      const list = selectedItems.value;
      if (!list.length) return;
      addToList(list);
      clearSelection();
    }

    function openDateSheet() { bulkDate.value = today(); sheets.date = true; }
    /** Sets the bought date of the selection ('' puts everything back on the shopping list). */
    function applyBulkDate(date) {
      if (date && isFutureDate(date)) { showAlert('The bought date cannot be in the future.'); return; }
      const list = selectedItems.value;
      if (!list.length) return;
      sheets.date = false;
      const before = list.map((i) => ({ i, checkedDate: i.checkedDate, order: i.order }));
      const others = items.value.filter((i) => !list.includes(i));
      const nextBy = {};
      list.forEach((i) => {
        i.checkedDate = date;
        if (date) return;
        if (nextBy[i.storeId] === undefined) nextBy[i.storeId] = nextOrder(others, i.storeId);
        i.order = nextBy[i.storeId]++;
      });
      enqueue(() => SheetsApi.batchUpdateRows(props.sheetId, TABS.ITEMS, list.map((i) => ({ id: i.id, values: itemToRow(i) })))).catch(() => {
        before.forEach((b) => { b.i.checkedDate = b.checkedDate; b.i.order = b.order; });
        showAlert('Could not save that change. Check your connection and try again.');
      });
      if (!date) say(list.length + (list.length === 1 ? ' item is' : ' items are') + ' back on your list');
      clearSelection();
    }

    /** Moves the selection to another store. What was paid stays as it is. */
    function moveSelectedTo(storeId) {
      sheets.move = false;
      const list = selectedItems.value;
      if (!list.length) return;
      const before = list.map((i) => ({ i, storeId: i.storeId, order: i.order }));
      moveToStore(list, storeId, { startOrder: nextOrder(items.value, storeId), baseCurrency: baseCurrency.value, trackPrices: false });
      enqueue(() => SheetsApi.batchUpdateRows(props.sheetId, TABS.ITEMS, list.map((i) => ({ id: i.id, values: itemToRow(i) })))).catch(() => {
        before.forEach((b) => { b.i.storeId = b.storeId; b.i.order = b.order; });
        showAlert('Could not move the items. Check your connection and try again.');
      });
      say('Moved ' + list.length + (list.length === 1 ? ' item' : ' items') + ' to ' + (storeName(storeId) || 'Anywhere'));
      clearSelection();
    }

    async function deleteSelected() {
      if (await deleteItems(selectedItems.value)) clearSelection();
    }

    // ── Copy to the clipboard ─────────────────────────────────────────────────
    const copyFieldList = computed(() => COPY_FIELDS.filter((f) => trackPrices.value || (f.id !== 'price' && f.id !== 'paid')));
    const copyOptions = computed(() => ({
      fields: copy.fields, format: copy.format, header: copy.header,
      storeNameOf: (id) => storeName(id), storeCityOf: (id) => storeCity(id), num: (n) => amountText(Number(n).toFixed(2)),
    }));
    const copyPreview = computed(() => {
      const list = selectedItems.value;
      if (!list.length || !copy.fields.length) return '';
      const text = itemsToText(list.slice(0, 3), copyOptions.value);
      return list.length > 3 ? text + '\n… and ' + (list.length - 3) + ' more' : text;
    });
    function openCopySheet() {
      if (!selectedItems.value.length) return;
      sheets.copy = true;
    }
    function toggleCopyField(id) {
      copy.fields = copy.fields.includes(id) ? copy.fields.filter((f) => f !== id) : [...copy.fields, id];
    }
    watch(copy, () => {
      try { localStorage.setItem(COPY_PREFS_KEY, JSON.stringify({ fields: copy.fields, format: copy.format, header: copy.header })); } catch { /* private mode */ }
    }, { deep: true });
    async function doCopy() {
      const list = selectedItems.value;
      if (!list.length || !copy.fields.length) return;
      const ok = await copyText(itemsToText(list, copyOptions.value));
      sheets.copy = false;
      if (ok) say('Copied ' + list.length + (list.length === 1 ? ' item' : ' items') + (copy.format === 'csv' ? ' as CSV' : ' for a spreadsheet'));
      else showAlert('Could not copy to the clipboard. Your browser may not allow it here.');
    }

    watch(() => props.changeTick, () => { if (!itemSheet.open && !selecting.value) load(true); });
    onMounted(() => load());

    return {
      items, loading, loadError, load, period, periodLabel, periodOptions, allTimeTotal, setPeriod, openPeriodSheet, applyCustom,
      customFrom, customTo, search, view, sheets, storeSearch, storeFilter, storeFilterOptions, storeButtonLabel,
      storeFilterChecked, toggleStoreFilter,
      periodStores, storeLabel, storeCity, hasFilters, clearFilters,
      groups, shown, sorted, total, products: shownProducts, remaining, limit, PAGE_SIZE,
      sortOptions, activeSortId, pickSort, showUnit, unitNote, toggleProduct, expandedProduct, showPurchases,
      onRow, itemSheet, closeSheet, onSheetSave, addFromSheet, deleteFromSheet,
      selecting, selectedIds, selectedSet, selectedItems, selectedTotal, allSelected, toggleSelect, clearSelection, toggleAll, daySelected, toggleDay,
      addSelectedToList, openDateSheet, bulkDate, applyBulkDate, moveSelectedTo, activeStores, deleteSelected,
      copy, copyFieldList, copyPreview, openCopySheet, toggleCopyField, doCopy,
      toast, trackPrices, fmt, today, yesterday, paidText, storeName, grouped,
      formatDayHeading, formatDateLabel,
      purchasesCount: computed(() => purchases.value.length),
    };
  },

  template: `
    <div class="subpage">
      <div class="subpage-scroll">
      <div class="subpage-nav">
        <button class="subpage-back subpage-back--colored" @click="$emit('go-home')">
          <span class="material-icons">arrow_back</span>
        </button>
        <h1 class="subpage-nav-title">History</h1>
        <div class="valu-orb-sm subpage-orb-inline">
          <div class="spheres">
            <div class="spheres-group">
              <div class="sphere s1"></div>
              <div class="sphere s2"></div>
              <div class="sphere s3"></div>
            </div>
          </div>
        </div>
      </div>

      <div v-if="loading" class="loading" style="padding-top:40px;"><div class="spinner"></div>Loading history...</div>

      <div v-else-if="loadError" class="empty-state" style="padding-top:40px;">
        <span class="material-icons">cloud_off</span>
        <h3>Something went wrong</h3>
        <p>{{ loadError }}</p>
        <button class="btn-link" @click="load()">Try again</button>
      </div>

      <template v-else>
        <div class="subpage-header">
          <button class="subpage-month-btn" @click="openPeriodSheet">
            <span>{{ periodLabel }}</span>
            <span class="material-icons subpage-month-arrow">unfold_more</span>
          </button>
          <h2 v-if="trackPrices" class="subpage-balance">{{ fmt(total) }}</h2>
          <h2 v-else class="subpage-balance">{{ sorted.length }} {{ sorted.length === 1 ? 'item' : 'items' }}</h2>
        </div>

        <div v-if="purchasesCount > 0" class="gl-hist-toolbar">
          <div class="gl-hist-views" role="tablist">
            <button class="gl-store-tab" :class="{ active: view === 'days' }" role="tab" :aria-selected="view === 'days'" @click="view = 'days'">Purchases</button>
            <button class="gl-store-tab" :class="{ active: view === 'products' }" role="tab" :aria-selected="view === 'products'" @click="view = 'products'">Products</button>
          </div>
          <button class="gl-icon-btn" aria-label="Refresh" title="Refresh" @click="load(true, true)"><span class="material-icons">refresh</span></button>
        </div>

        <div class="subpage-filter-bar gl-hist-bar" v-if="purchasesCount > 0">
          <div class="subpage-filter-search" :class="{ expanded: search }">
            <span class="material-icons subpage-filter-search-icon">search</span>
            <input class="subpage-filter-search-input" v-model="search" placeholder="Search..." />
            <button v-if="search" class="subpage-filter-search-clear" aria-label="Clear search" @click="search = ''">
              <span class="material-icons">close</span>
            </button>
          </div>
          <button v-if="view === 'days'" class="subpage-filter-btn" :class="{ active: selecting }" @click="toggleSelect" aria-label="Select purchases">
            <span class="material-icons" style="font-size:16px;">checklist</span>
            <span>Select</span>
          </button>
          <button v-if="periodStores.length > 1" class="subpage-filter-btn" :class="{ active: storeFilter.length }" @click="sheets.store = true">
            <span class="material-icons" style="font-size:16px;">storefront</span>
            <span class="gl-hist-btn-label">{{ storeButtonLabel }}</span>
          </button>
          <button class="subpage-filter-btn" :class="{ active: activeSortId !== (view === 'days' ? 'newest' : 'most') }" @click="sheets.sort = true" aria-label="Sort">
            <span class="material-icons" style="font-size:16px;">sort</span>
          </button>
        </div>

        <!-- Purchases -->
        <div class="valu-list" v-if="view === 'days' && shown.length > 0">
          <template v-for="d in groups" :key="d.date || 'flat'">
            <div v-if="!d.flat" class="gl-day-head" :class="{ 'gl-day-head--select': selecting }" @click="selecting && toggleDay(d)">
              <span class="gl-day-head-title">
                <span v-if="selecting" class="gl-check gl-check--square" :class="{ checked: daySelected(d) }" aria-hidden="true">
                  <span class="gl-check-circle"><span class="material-icons">check</span></span>
                </span>
                {{ formatDayHeading(d.date) }}
              </span>
              <span v-if="trackPrices && d.total !== 0">{{ fmt(d.total) }}</span>
            </div>
            <div v-for="i in d.items" :key="i.id" class="valu-list-item" :class="{ 'gl-hist-selected': selecting && selectedSet.has(i.id) }" @click="onRow(i)">
              <div class="valu-list-row">
                <span v-if="selecting" class="gl-check gl-check--square" :class="{ checked: selectedSet.has(i.id) }" aria-hidden="true" style="margin-right:6px;">
                  <span class="gl-check-circle"><span class="material-icons">check</span></span>
                </span>
                <div class="valu-list-body">
                  <div class="valu-list-top">
                    <div class="valu-list-name">{{ i.title }}</div>
                    <div v-if="i.quantity || trackPrices" class="gl-item-metrics">
                      <span v-if="i.quantity" class="gl-item-qty">{{ i.quantity }}</span>
                      <span v-if="trackPrices" class="gl-item-price" :class="{ 'gl-item-price--none': typeof i.price !== 'number' }">
                        <span>{{ typeof i.price === 'number' ? fmt(i.price) : '—' }}</span>
                        <small v-if="paidText(i)" class="gl-item-price-sub">{{ paidText(i) }}</small>
                      </span>
                    </div>
                  </div>
                  <div class="valu-list-sub">
                    <template v-if="d.flat">{{ formatDateLabel(i.checkedDate) }} · </template>{{ storeLabel(i.storeId) }}<span v-if="i.notes"> · {{ i.notes }}</span>
                  </div>
                </div>
              </div>
            </div>
          </template>
        </div>

        <!-- Products -->
        <div class="valu-list" v-if="view === 'products' && products.length > 0">
          <div v-for="p in products" :key="p.key" class="valu-list-item" @click="toggleProduct(p.key)">
            <div class="valu-list-row">
              <div class="valu-list-body">
                <div class="valu-list-top">
                  <div class="valu-list-name">{{ p.title }}<span class="gl-item-qty" style="margin-left:8px;vertical-align:1px;">{{ p.count }}×</span></div>
                  <div v-if="trackPrices && p.avg !== null" class="gl-item-price">
                    <span>{{ fmt(p.total) }}</span>
                    <small class="gl-item-price-sub">avg {{ fmt(p.avg) }}</small>
                  </div>
                </div>
                <div class="valu-list-sub">
                  Last {{ formatDateLabel(p.lastDate) }}<span v-if="trackPrices && p.min !== null && p.min !== p.max"> · {{ fmt(p.min) }} – {{ fmt(p.max) }}</span>
                  <span v-if="trackPrices && p.cheapestStoreId !== null" class="gl-prod-cheap"> · cheapest at {{ storeLabel(p.cheapestStoreId) }}<template v-if="showUnit(p)">{{ ' ' + p.unit.label }}</template></span>
                </div>
                <div v-if="trackPrices && showUnit(p)" class="valu-list-sub">
                  {{ fmt(p.unitAvg) }} {{ p.unit.label }}<span v-if="p.unitMin !== p.unitMax"> · {{ fmt(p.unitMin) }} – {{ fmt(p.unitMax) }}</span>
                </div>
                <div v-if="expandedProduct === p.key" class="gl-prod-detail" @click.stop>
                  <div v-for="s in p.byStore" :key="s.storeId" class="gl-prod-store">
                    <span class="gl-prod-store-name">{{ storeLabel(s.storeId) }}<span v-if="p.cheapestStoreId === s.storeId" class="gl-prod-badge">cheapest</span></span>
                    <span class="gl-prod-store-meta">{{ s.count }}×<template v-if="trackPrices && showUnit(p) && s.unitAvg !== null"> · <strong>{{ fmt(s.unitAvg) }} {{ p.unit.label }}</strong></template><template v-if="trackPrices && s.avg !== null"> · {{ fmt(s.avg) }}<template v-if="s.min !== s.max"> ({{ fmt(s.min) }} – {{ fmt(s.max) }})</template><template v-if="showUnit(p)"> paid</template></template></span>
                  </div>
                  <p v-if="trackPrices && showUnit(p)" class="gl-prod-note">{{ unitNote(p) }}</p>
                  <button class="btn btn-text btn-sm" style="padding-left:0;" @click="showPurchases(p)">See these purchases</button>
                </div>
              </div>
              <span class="material-icons gl-prod-chevron" aria-hidden="true">{{ expandedProduct === p.key ? 'expand_less' : 'expand_more' }}</span>
            </div>
          </div>
        </div>

        <button v-if="remaining > 0" class="btn-link gl-hist-more" @click="limit += PAGE_SIZE">Show more ({{ remaining }} left)</button>

        <div v-if="((view === 'days' && sorted.length === 0) || (view === 'products' && products.length === 0)) && purchasesCount > 0" class="empty-state">
          <span class="material-icons">filter_list</span>
          <h3>Nothing found</h3>
          <p>Try another period or clear the filters.</p>
          <button v-if="hasFilters" class="btn-link" style="margin-top:8px;" @click="clearFilters">Show all history</button>
        </div>

        <div v-if="purchasesCount === 0" class="empty-state" style="padding-top:40px;">
          <span class="material-icons">history</span>
          <h3>No history yet</h3>
          <p>Items you mark as bought on your shopping list show up here.</p>
        </div>

        <div v-if="selecting" class="gl-hist-spacer"></div>
      </template>
      </div>

      <div v-if="toast" class="gl-toast gl-toast--floating" :class="{ 'gl-toast--above-bar': selecting }" role="status">{{ toast }}</div>

      <div v-if="selecting" class="gl-select-bar gl-select-bar--stack gl-select-bar--fixed">
        <div class="gl-select-top">
          <span class="gl-select-count"><template v-if="selectedIds.length">{{ selectedIds.length }} selected<template v-if="selectedTotal !== null"> · <strong>{{ fmt(selectedTotal) }}</strong></template></template>
            <template v-else>Tap purchases or a day</template></span>
          <button class="btn btn-text btn-sm" @click="toggleAll">{{ allSelected ? 'None' : 'All ' + sorted.length }}</button>
          <button class="gl-icon-btn" aria-label="Cancel" @click="clearSelection"><span class="material-icons">close</span></button>
        </div>
        <div class="gl-select-actions">
          <button class="gl-act" :disabled="selectedIds.length === 0" @click="addSelectedToList"><span class="material-icons">add_shopping_cart</span>Add to list</button>
          <button class="gl-act" :disabled="selectedIds.length === 0" @click="openDateSheet"><span class="material-icons">event</span>Date</button>
          <button class="gl-act" :disabled="selectedIds.length === 0 || activeStores.length === 0" @click="sheets.move = true"><span class="material-icons">drive_file_move</span>Move</button>
          <button class="gl-act" :disabled="selectedIds.length === 0" @click="openCopySheet"><span class="material-icons">content_copy</span>Copy</button>
          <button class="gl-act gl-act--danger" :disabled="selectedIds.length === 0" @click="deleteSelected"><span class="material-icons">delete</span>Delete</button>
        </div>
      </div>

      <!-- Period -->
      <div class="modal-overlay" :class="{ open: sheets.period }" @click.self="sheets.period = false">
        <div class="modal">
          <div class="sheet-handle"></div>
          <div class="modal-header">
            <h2>Select Period</h2>
            <button class="btn-icon" @click="sheets.period = false"><span class="material-icons">close</span></button>
          </div>
          <div class="modal-body" style="padding:0;">
            <div class="month-picker-option" :class="{ selected: period.kind === 'all' }" @click="setPeriod('all')">
              <span class="month-picker-label">All time</span>
              <span class="month-picker-total">{{ trackPrices ? fmt(allTimeTotal) : purchasesCount + ' items' }}</span>
            </div>
            <template v-for="y in periodOptions" :key="y.key">
              <div class="month-picker-option gl-period-year" :class="{ selected: period.kind === 'year' && period.a === y.key }" @click="setPeriod('year', y.key)">
                <span class="month-picker-label">{{ y.key }}</span>
                <span class="month-picker-total">{{ trackPrices ? fmt(y.total) : y.count + ' items' }}</span>
              </div>
              <div v-for="m in y.months" :key="m.key" class="month-picker-option gl-period-month" :class="{ selected: period.kind === 'month' && period.a === m.key }" @click="setPeriod('month', m.key)">
                <span class="month-picker-label">{{ m.label }}</span>
                <span class="month-picker-total">{{ trackPrices ? fmt(m.total) : m.count + ' items' }}</span>
              </div>
            </template>
            <div class="gl-period-custom">
              <div class="sheet-section-title" style="padding-left:0;">A day or a range</div>
              <p class="gl-sheet-hint">Pick one date for a single day, or two for everything in between.</p>
              <div class="sheet-list-item"><label>From</label><valu-date-field v-model="customFrom" placeholder="Pick a date" /></div>
              <div class="sheet-list-item"><label>To</label><valu-date-field v-model="customTo" placeholder="Optional" /></div>
              <button class="btn-sheet-cta" style="margin-top:12px;" :disabled="!customFrom && !customTo" @click="applyCustom">Show</button>
            </div>
          </div>
        </div>
      </div>

      <!-- Stores -->
      <div class="modal-overlay" :class="{ open: sheets.store }" @click.self="sheets.store = false">
        <div class="modal">
          <div class="sheet-handle"></div>
          <div class="modal-header">
            <h2>Stores</h2>
            <button class="btn-icon" @click="sheets.store = false"><span class="material-icons">close</span></button>
          </div>
          <div class="modal-body" style="padding:0 0 8px;">
            <div class="gl-store-pick-search">
              <span class="material-icons">search</span>
              <input v-model="storeSearch" placeholder="Search by name or city" />
            </div>
            <div v-for="s in storeFilterOptions" :key="s.id" class="month-picker-option gl-store-pick-row" @click="toggleStoreFilter(s.id)">
              <span class="gl-check gl-check--square" :class="{ checked: storeFilterChecked(s.id) }" aria-hidden="true" style="margin-right:10px;">
                <span class="gl-check-circle"><span class="material-icons">check</span></span>
              </span>
              <span class="month-picker-label">{{ s.name }}<small v-if="s.city" style="color:var(--color-text-hint);"> · {{ s.city }}</small></span>
              <span class="month-picker-total">{{ s.count }}</span>
            </div>
            <div v-if="storeFilterOptions.length === 0" class="currency-picker-empty">No match</div>
          </div>
          <div class="modal-footer">
            <button class="btn-sheet-cta" @click="sheets.store = false">Done</button>
            <div class="modal-footer-row">
              <button class="btn btn-text" :disabled="!storeFilter.length" @click="storeFilter = []">All stores</button>
            </div>
          </div>
        </div>
      </div>

      <!-- Sort -->
      <div class="modal-overlay" :class="{ open: sheets.sort }" @click.self="sheets.sort = false">
        <div class="modal">
          <div class="sheet-handle"></div>
          <div class="modal-header">
            <h2>Sort by</h2>
            <button class="btn-icon" @click="sheets.sort = false"><span class="material-icons">close</span></button>
          </div>
          <div class="modal-body" style="padding:0 0 16px;">
            <div v-for="o in sortOptions" :key="o.id" class="month-picker-option" :class="{ selected: activeSortId === o.id }" @click="pickSort(o.id)">
              <span class="month-picker-label"><span class="material-icons gl-sort-icon">{{ o.icon }}</span>{{ o.label }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Date for the selection -->
      <div class="modal-overlay" :class="{ open: sheets.date }" @click.self="sheets.date = false">
        <div class="modal">
          <div class="sheet-handle"></div>
          <div class="modal-header">
            <h2>Bought on</h2>
            <button class="btn-icon" @click="sheets.date = false"><span class="material-icons">close</span></button>
          </div>
          <div class="modal-body">
            <p class="gl-sheet-hint">Change the purchase date of the {{ selectedIds.length }} selected {{ selectedIds.length === 1 ? 'item' : 'items' }}.</p>
            <div class="gl-chip-row" style="padding:0 0 12px;">
              <button class="gl-filter-chip" :class="{ active: bulkDate === today() }" @click="bulkDate = today()">Today</button>
              <button class="gl-filter-chip" :class="{ active: bulkDate === yesterday() }" @click="bulkDate = yesterday()">Yesterday</button>
            </div>
            <div class="sheet-list-item">
              <label>Date</label>
              <valu-date-field v-model="bulkDate" placeholder="Pick a date" />
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn-sheet-cta" :disabled="!bulkDate" @click="applyBulkDate(bulkDate)">Set date</button>
            <div class="modal-footer-row">
              <button class="btn btn-text" @click="applyBulkDate('')">Not bought (back on the list)</button>
              <button class="btn btn-text" @click="sheets.date = false">Cancel</button>
            </div>
          </div>
        </div>
      </div>

      <!-- Move the selection to a store -->
      <div class="modal-overlay" :class="{ open: sheets.move }" @click.self="sheets.move = false">
        <div class="modal">
          <div class="sheet-handle"></div>
          <div class="modal-header">
            <h2>Move to</h2>
            <button class="btn-icon" @click="sheets.move = false"><span class="material-icons">close</span></button>
          </div>
          <div class="modal-body" style="padding:0 0 16px;">
            <p class="gl-sheet-hint" style="padding:0 16px;">Prices stay as they were.</p>
            <div v-for="s in activeStores" :key="s.id" class="month-picker-option" @click="moveSelectedTo(s.id)">
              <span class="month-picker-label">{{ s.name }}</span><span class="month-picker-total">{{ s.city }}</span>
            </div>
            <div class="month-picker-option" @click="moveSelectedTo('')">
              <span class="month-picker-label">Anywhere</span><span class="month-picker-total"></span>
            </div>
          </div>
        </div>
      </div>

      <!-- Copy the selection to the clipboard -->
      <div class="modal-overlay" :class="{ open: sheets.copy }" @click.self="sheets.copy = false">
        <div class="modal">
          <div class="sheet-handle"></div>
          <div class="modal-header">
            <h2>Copy {{ selectedItems.length }} {{ selectedItems.length === 1 ? 'item' : 'items' }}</h2>
            <button class="btn-icon" @click="sheets.copy = false"><span class="material-icons">close</span></button>
          </div>
          <div class="modal-body">
            <div class="sheet-section-title" style="padding-left:0;">Include</div>
            <div v-for="f in copyFieldList" :key="f.id" class="gl-copy-field" @click="toggleCopyField(f.id)">
              <span class="gl-check gl-check--square" :class="{ checked: copy.fields.includes(f.id) }" aria-hidden="true">
                <span class="gl-check-circle"><span class="material-icons">check</span></span>
              </span>
              <span>{{ f.label }}</span>
            </div>
            <div class="sheet-section-title" style="padding-left:0;margin-top:12px;">Format</div>
            <div class="gl-chip-row" style="padding:0 0 4px;">
              <button class="gl-filter-chip" :class="{ active: copy.format === 'tsv' }" @click="copy.format = 'tsv'">Spreadsheet (tabs)</button>
              <button class="gl-filter-chip" :class="{ active: copy.format === 'csv' }" @click="copy.format = 'csv'">CSV (commas)</button>
            </div>
            <div class="gl-copy-field" @click="copy.header = !copy.header">
              <span class="gl-check gl-check--square" :class="{ checked: copy.header }" aria-hidden="true">
                <span class="gl-check-circle"><span class="material-icons">check</span></span>
              </span>
              <span>First row with the column names</span>
            </div>
            <div class="sheet-section-title" style="padding-left:0;margin-top:12px;">Preview</div>
            <pre class="gl-copy-preview">{{ copyPreview || 'Choose at least one field.' }}</pre>
            <p class="gl-sheet-hint">Your choices are remembered for next time. Nothing is saved or sent anywhere: the text only goes to your clipboard.</p>
          </div>
          <div class="modal-footer">
            <button class="btn-sheet-cta" :disabled="copy.fields.length === 0" @click="doCopy">Copy to clipboard</button>
            <div class="modal-footer-row">
              <button class="btn btn-text" @click="sheets.copy = false">Cancel</button>
            </div>
          </div>
        </div>
      </div>

      <item-sheet :open="itemSheet.open" :is-new="false" :seed="itemSheet.seed" :stores="stores || []" :settings="settings"
                  duplicate-label="Add to list" duplicate-icon="add_shopping_cart" :keep-price-on-store-change="true"
                  @close="closeSheet" @save="onSheetSave" @duplicate="addFromSheet" @delete="deleteFromSheet" />
    </div>
  `,
};
