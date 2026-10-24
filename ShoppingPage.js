/**
 * Shopping page (home): the live list per store, quick add with suggestions, tick off, reorder,
 * multi-select (move / delete), and the item sheet (price in a foreign currency is converted to the
 * group's base currency at entry time, exactly like Valu Finance).
 */

import SheetsApi, { TABS } from './sheetsApi.js';
import {
  localDateISO, isFutureDate, parseAmount, roundMoney, sanitizeAmountText, flipSign, formatCurrency, cleanQuantity, sanitizeQuantityText,
  capitalizeFirst, parseCurrencyRates, rowToItem, itemToRow, pendingItems, nextOrder, sumPrices,
  groupCheckedByDate, reorderList, buildSuggestions, copyForList, listKey, onListKeys, moveToStore,
} from './groceryLogic.js';
import { getRate } from './fxService.js';
import { formatDateLabel } from './dateLabels.js';
import { STORAGE_PREFIX } from './config.js';
import TripSheet from './TripSheet.js';
import StoreSheet from './StoreSheet.js';
import ItemSheet, { isZeroPrice } from './ItemSheet.js';

const { ref, reactive, computed, watch, inject, nextTick, onMounted, onUnmounted } = Vue;

const LS_STORE = STORAGE_PREFIX + 'store_';

/** One row of the list. Used for both the open items and the ticked-off groups. */
const GlItem = {
  props: ['item', 'done', 'selected', 'reorder', 'showPrice', 'currency', 'leaving'],
  emits: ['open', 'select', 'drag'],
  setup(props) {
    // The amount in the group's currency is what counts. If it was paid in another currency,
    // the original amount (€3.50) is shown smaller underneath.
    const hasPaid = computed(() => !!props.item.paidAmount && !!props.item.paidCurrency && typeof props.item.price === 'number');
    const priceText = computed(() => formatCurrency(typeof props.item.price === 'number' ? props.item.price : 0, props.currency));
    const priceSub = computed(() => (hasPaid.value ? formatCurrency(props.item.paidAmount, props.item.paidCurrency) : ''));
    return { priceText, priceSub };
  },
  template: `
    <div class="gl-item" :class="{ 'gl-item--done': done, 'gl-item--selected': selected, 'gl-item--leaving': leaving }"
         :data-row-id="item.id" @click="$emit('open', item)">
      <button type="button" class="gl-check gl-check--square" :class="{ checked: selected }" :disabled="reorder"
              role="checkbox" :aria-checked="!!selected" :aria-label="selected ? 'Deselect ' + item.title : 'Select ' + item.title"
              @click.stop="$emit('select', item)">
        <span class="gl-check-circle"><span class="material-icons">check</span></span>
      </button>
      <div class="gl-item-main">
        <div class="gl-item-head">
          <span class="gl-item-title">{{ item.title }}</span>
          <span v-if="item.quantity" class="gl-item-qty">{{ item.quantity }}</span>
        </div>
        <div v-if="item.notes" class="gl-item-sub">{{ item.notes }}</div>
      </div>
      <span v-if="showPrice && priceText" class="gl-item-price">
        {{ priceText }}
        <small v-if="priceSub" class="gl-item-price-sub">{{ priceSub }}</small>
      </span>
      <span v-if="reorder && !done" class="gl-drag-handle" aria-label="Drag to reorder"
            @pointerdown.prevent="$emit('drag', $event, item)" @click.stop>
        <span class="material-icons">drag_handle</span>
      </span>
    </div>`,
};

export default {
  components: { GlItem, TripSheet, StoreSheet, ItemSheet },
  props: ['sheetId', 'settings', 'stores', 'changeTick', 'groupName', 'pageIntent'],
  emits: ['go-home', 'navigate', 'refresh', 'settings-updated', 'stores-updated'],

  setup(props, { emit }) {
    const showAlert = inject('showAlert', (m) => window.alert(m));
    const showConfirm = inject('showConfirm', (m) => Promise.resolve(window.confirm(m)));

    const items = ref([]);
    const loading = ref(true);
    const loadError = ref('');
    const selectedStore = ref(null); // null = nothing chosen yet, so the first store opens
    const newTitle = ref('');
    const inputFocused = ref(false);
    const quickInput = ref(null);
    const listEl = ref(null);
    const reorderMode = ref(false);
    const selectedIds = ref([]);
    const hasSelection = computed(() => selectedIds.value.length > 0);
    const leaving = reactive({});
    const openDone = reactive({});
    const showMoveSheet = ref(false);
    const showTripSheet = ref(false);
    const showStoreSheet = ref(false);
    const showDateSheet = ref(false);
    const bulkDate = ref('');
    const newQty = ref('');
    const newPrice = ref('');
    let quickBusy = false;
    const toast = reactive({ text: '' });
    let toastTimer = 0;

    function say(text) {
      toast.text = text;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { toast.text = ''; }, 3800);
    }

    // ── Settings ──────────────────────────────────────────────────────────────
    const baseCurrency = computed(() => props.settings?.baseCurrency || 'USD');
    const trackPrices = computed(() => (props.settings?.trackPrices ?? 'true') !== 'false');
    const manualRates = computed(() => parseCurrencyRates(props.settings?.currencyRates));
    const today = () => localDateISO();

    // ── Stores and tabs ───────────────────────────────────────────────────────
    const activeStores = computed(() =>
      [...(props.stores || [])].filter((s) => !s.hidden).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name)));
    const storeById = computed(() => new Map((props.stores || []).map((s) => [s.id, s])));
    const storeNameOf = (id) => (storeById.value.get(id)?.name) || 'Anywhere';

    const tabs = computed(() => {
      const list = activeStores.value.map((s) => ({ id: s.id, name: s.name, count: pendingItems(items.value, s.id).length }));
      const looseCount = pendingItems(items.value, '').length;
      if (list.length === 0) return [{ id: '', name: 'My list', count: looseCount }];
      if (looseCount > 0 || selectedStore.value === '') list.push({ id: '', name: 'Anywhere', count: looseCount });
      return list;
    });
    const currentStoreId = computed(() => {
      const ids = tabs.value.map((t) => t.id);
      return ids.includes(selectedStore.value) ? selectedStore.value : (ids[0] ?? '');
    });
    const currentStore = computed(() => storeById.value.get(currentStoreId.value) || null);

    function selectTab(id) {
      selectedStore.value = id;
      try { localStorage.setItem(LS_STORE + props.sheetId, id); } catch { /* private mode */ }
      selectedIds.value = []; reorderMode.value = false;
    }

    const pending = computed(() => pendingItems(items.value, currentStoreId.value));
    const doneGroups = computed(() => groupCheckedByDate(items.value, currentStoreId.value).slice(0, 14));
    const estimate = computed(() => sumPrices(pending.value));
    const hasAnyPrice = computed(() => pending.value.some((i) => typeof i.price === 'number'));
    const isDoneOpen = (date) => openDone[date] ?? date === today();
    const toggleDone = (date) => { openDone[date] = !isDoneOpen(date); };

    function normaliseStoreIds() {
      // Items of a deleted store show under "Anywhere". Skipped while the stores are not known yet,
      // otherwise every item would lose its store.
      if (!props.stores || props.stores.length === 0) return;
      const known = new Set(props.stores.map((s) => s.id));
      for (const i of items.value) if (i.storeId && !known.has(i.storeId)) i.storeId = '';
    }
    // The stores list changed (or arrived late): re-read so items get their real store back.
    watch(() => props.stores, (now, before) => {
      const wasEmpty = !before || before.length === 0;
      if (wasEmpty && items.value.length && writesInFlight === 0) fetchItems(true); else normaliseStoreIds();
    });

    /** A store added right here: publish the new list and switch to its tab. */
    function onStoreSaved({ store, isNew }) {
      const next = isNew ? [...(props.stores || []), store] : (props.stores || []).map((s) => (s.id === store.id ? store : s));
      emit('stores-updated', next);
      showStoreSheet.value = false;
      if (isNew && !store.hidden) selectTab(store.id);
    }

    // ── Loading ───────────────────────────────────────────────────────────────
    let writesInFlight = 0;
    let writeChain = Promise.resolve();
    /** Writes run strictly one after another so a quick tick right after an add can never race it. */
    function enqueue(fn) {
      writesInFlight++;
      const p = writeChain.then(fn);
      writeChain = p.catch(() => {}).then(() => { writesInFlight--; });
      return p;
    }

    async function fetchItems(silent = false) {
      const sid = props.sheetId;
      if (!sid) return;
      if (!silent) { loading.value = true; loadError.value = ''; }
      try {
        const rows = await SheetsApi.getTabData(sid, TABS.ITEMS);
        if (sid !== props.sheetId) return;
        items.value = rows.map(rowToItem).filter((i) => i.id && i.title.trim());
        normaliseStoreIds();
        loadError.value = '';
      } catch {
        if (!silent) loadError.value = 'Could not load your list. Check your connection and try again.';
      } finally {
        if (sid === props.sheetId) loading.value = false;
      }
    }

    /** Set when Open list (or similar) asks for a specific store, so its tab can be scrolled into view once the strip renders. */
    let scrollTabIntoView = false;
    const tabsEl = ref(null);

    function restoreSelectedStore() {
      const intent = props.pageIntent;
      if (intent && Object.prototype.hasOwnProperty.call(intent, 'storeId')) {
        selectedStore.value = intent.storeId;
        try { localStorage.setItem(LS_STORE + props.sheetId, intent.storeId); } catch { /* private mode */ }
        scrollTabIntoView = true;
        return;
      }
      let saved = null;
      try { saved = localStorage.getItem(LS_STORE + props.sheetId); } catch { /* ignore */ }
      selectedStore.value = saved;
    }

    function scrollActiveStoreTabIntoView() {
      nextTick(() => {
        requestAnimationFrame(() => {
          const btn = tabsEl.value?.querySelector('.gl-store-tab.active');
          if (btn && btn.scrollIntoView) btn.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
        });
      });
    }

    watch(() => props.sheetId, () => { restoreSelectedStore(); items.value = []; fetchItems(); });
    watch(() => props.changeTick, () => {
      if (itemSheet.open || dragState || hasSelection.value || writesInFlight > 0) return;
      fetchItems(true);
    });
    watch(loading, (busy, wasBusy) => {
      if (wasBusy && !busy && scrollTabIntoView) {
        scrollTabIntoView = false;
        scrollActiveStoreTabIntoView();
      }
    });

    // ── Quick add ─────────────────────────────────────────────────────────────
    const suggestions = computed(() =>
      inputFocused.value ? buildSuggestions(items.value, newTitle.value, currentStoreId.value) : []);

    function scrollRowIntoView(id) {
      nextTick(() => {
        const el = listEl.value?.querySelector(`[data-row-id="${CSS.escape(id)}"]`);
        if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      });
    }

    function buildNewItem(fields = {}) {
      const storeId = fields.storeId ?? currentStoreId.value;
      return {
        id: SheetsApi.generateId(),
        title: '', quantity: '', price: null, paidAmount: null, paidCurrency: '', notes: '', checkedDate: '',
        storeId,
        order: nextOrder(items.value, storeId),
        createdAt: new Date().toISOString(),
        ...fields,
      };
    }

    function addItemNow(item) {
      items.value.push(item);
      enqueue(() => SheetsApi.appendRow(props.sheetId, TABS.ITEMS, itemToRow(item))).catch(() => {
        items.value = items.value.filter((i) => i.id !== item.id);
        showAlert('Could not save "' + item.title + '". Check your connection and try again.');
      });
    }

    function storeCurrencyFor(storeId) {
      return storeById.value.get(storeId)?.currency || baseCurrency.value;
    }

    /**
     * Price typed in the store's currency -> what to save: the converted price in the base currency
     * plus the original amount, so the list can still show "€3.50". Empty text means "no price".
     */
    async function resolvePrice(text, currency, date) {
      const txt = String(text ?? '').trim();
      if (txt === '') return { price: null, paidAmount: null, paidCurrency: '' };
      const n = parseAmount(txt);
      if (!Number.isFinite(n)) throw new Error('That price does not look right.');
      if (!currency || currency === baseCurrency.value) return { price: roundMoney(n), paidAmount: null, paidCurrency: '' };
      const res = await getRate(currency, baseCurrency.value, date && !isFutureDate(date) ? date : today());
      let rate = res && !res.error ? res.rate : null;
      if (rate == null) {
        const manual = parseFloat(manualRates.value.find((r) => r.currency === currency)?.rate);
        if (Number.isFinite(manual)) rate = manual;
      }
      if (rate == null) {
        throw new Error('Could not get the ' + currency + ' exchange rate. Check your connection, or use "Add with details" and enter the price in ' + baseCurrency.value + '.');
      }
      return { price: roundMoney(n * rate), paidAmount: roundMoney(n), paidCurrency: currency };
    }

    const quickPriceHint = computed(() => {
      const cur = storeCurrencyFor(currentStoreId.value);
      return cur === baseCurrency.value ? 'Price' : cur;
    });

    function quickAdd(suggestion) {
      if (quickBusy) return;
      const title = capitalizeFirst((suggestion ? suggestion.title : newTitle.value).trim());
      if (!title) return;
      // What you typed wins; picking a suggestion fills in how you bought it last time in this store:
      // quantity and (when prices are tracked) its price, as an estimate. Suggestions from other stores
      // carry no quantity or price. A price only comes along when the quantity is the one it was paid for.
      const typedQty = cleanQuantity(newQty.value);
      const quantity = typedQty || (suggestion ? suggestion.quantity : '');
      const fields = { title, quantity };
      if (suggestion && trackPrices.value && typeof suggestion.price === 'number' && (!typedQty || typedQty === cleanQuantity(suggestion.quantity))) {
        fields.price = suggestion.price;
        if (suggestion.paidAmount && suggestion.paidCurrency) {
          fields.paidAmount = suggestion.paidAmount;
          fields.paidCurrency = suggestion.paidCurrency;
        }
      }
      // A price typed in the bar wins over a suggested one. It is in the store's currency, so for a
      // foreign store it is converted first (which can take a moment, or fail).
      const typedPrice = trackPrices.value ? String(newPrice.value).trim() : '';
      const finish = (money) => {
        if (money) Object.assign(fields, money);
        const item = buildNewItem(fields);
        addItemNow(item);
        newTitle.value = '';
        newQty.value = '';
        newPrice.value = '';
        scrollRowIntoView(item.id);
        quickInput.value?.focus();
      };
      if (typedPrice === '' || isZeroPrice(typedPrice)) { finish(null); return; }
      quickBusy = true;
      resolvePrice(typedPrice, storeCurrencyFor(fields.storeId ?? currentStoreId.value), today())
        .then(finish)
        .catch((e) => showAlert(e.message))
        .finally(() => { quickBusy = false; });
    }

    /** Put copies of earlier purchases on the list; anything already there is skipped. */
    function addCopies(specs) {
      const keys = onListKeys(items.value);
      const nextBy = {};
      const fresh = [];
      let skipped = 0;
      for (const s of specs) {
        const k = listKey(s);
        if (keys.has(k)) { skipped++; continue; }
        keys.add(k);
        if (nextBy[s.storeId] === undefined) nextBy[s.storeId] = nextOrder(items.value, s.storeId);
        fresh.push(buildNewItem({ ...s, price: trackPrices.value ? s.price : null, order: nextBy[s.storeId]++, checkedDate: '' }));
      }
      if (fresh.length) {
        items.value.push(...fresh);
        enqueue(() => SheetsApi.appendRows(props.sheetId, TABS.ITEMS, fresh.map(itemToRow))).catch(() => {
          const ids = new Set(fresh.map((f) => f.id));
          items.value = items.value.filter((i) => !ids.has(i.id));
          showAlert('Could not add the items. Check your connection and try again.');
        });
      }
      say(fresh.length
        ? `Added ${fresh.length} ${fresh.length === 1 ? 'item' : 'items'} to the list` + (skipped ? ` · ${skipped} already there` : '')
        : 'Everything was already on the list');
      return fresh;
    }

    function onTripAdd(specs) {
      showTripSheet.value = false;
      const fresh = addCopies(specs);
      // Show where they landed when that is another store's list.
      const first = fresh[0];
      if (first && !fresh.some((f) => f.storeId === currentStoreId.value)) selectTab(first.storeId);
    }

    // ── Price prompt right after ticking ──────────────────────────────────────
    const snack = reactive({ itemId: '', title: '', currency: '', text: '', busy: false });
    let snackTimer = 0;
    function hideSnack() { clearTimeout(snackTimer); snack.itemId = ''; snack.text = ''; snack.busy = false; }
    function armSnack() {
      clearTimeout(snackTimer);
      snackTimer = setTimeout(() => { if (!snack.text.trim() && !snack.busy) hideSnack(); }, 9000);
    }
    async function showPriceSnack(item) {
      if (snack.itemId && snack.text.trim()) await saveSnack(); // never lose a price that was being typed
      Object.assign(snack, { itemId: item.id, title: item.title, currency: storeCurrencyFor(item.storeId), text: '', busy: false });
      armSnack();
    }
    async function saveSnack() {
      const item = items.value.find((i) => i.id === snack.itemId);
      if (!item || !snack.text.trim()) { hideSnack(); return; }
      snack.busy = true;
      try {
        const money = await resolvePrice(snack.text, snack.currency, item.checkedDate);
        const before = { price: item.price, paidAmount: item.paidAmount, paidCurrency: item.paidCurrency };
        Object.assign(item, money);
        persistItem(item, () => Object.assign(item, before));
        hideSnack();
      } catch (e) {
        snack.busy = false;
        showAlert(e.message);
      }
    }
    function undoSnack() {
      const item = items.value.find((i) => i.id === snack.itemId);
      hideSnack();
      if (item && item.checkedDate) toggleChecked(item);
    }

    // ── Ticking off ───────────────────────────────────────────────────────────
    function persistItem(item, revert) {
      return enqueue(() => SheetsApi.updateRow(props.sheetId, TABS.ITEMS, item.id, itemToRow(item))).catch(() => {
        if (revert) revert();
        showAlert('Could not save that change. Check your connection and try again.');
      });
    }

    function toggleChecked(item) {
      if (leaving[item.id]) return;
      const wasDone = !!item.checkedDate;
      const before = { checkedDate: item.checkedDate, order: item.order };
      leaving[item.id] = true;
      setTimeout(() => {
        delete leaving[item.id];
        if (wasDone) {
          item.checkedDate = '';
          item.order = nextOrder(items.value.filter((i) => i.id !== item.id), item.storeId);
        } else {
          item.checkedDate = today();
        }
        persistItem(item, () => Object.assign(item, before));
        if (wasDone && snack.itemId === item.id) hideSnack();
        // At the till is when you know the price: offer to type it right away (in the store's currency).
        if (!wasDone && trackPrices.value && item.price === null) showPriceSnack(item);
      }, 170);
    }

    // ── Selection (always on, like Nutri) ─────────────────────────────────────
    // The square in front of a row selects it; the bar at the bottom then acts on the selection.
    // Once something is selected, tapping anywhere on a row adds or drops it.
    function clearSelection() { selectedIds.value = []; }
    function toggleSelect(item) {
      const i = selectedIds.value.indexOf(item.id);
      if (i >= 0) selectedIds.value.splice(i, 1); else selectedIds.value.push(item.id);
    }
    function onRowOpen(item) {
      if (reorderMode.value) return;
      if (hasSelection.value) { toggleSelect(item); return; }
      openEdit(item);
    }
    const selectedItems = computed(() => items.value.filter((i) => selectedIds.value.includes(i.id)));
    /** Sum of the selected items' prices (in the group's currency); null when none of them has a price. */
    const selectedTotal = computed(() => (trackPrices.value && selectedItems.value.some((i) => typeof i.price === 'number')
      ? sumPrices(selectedItems.value) : null));

    const allPendingSelected = computed(() => pending.value.length > 0 && pending.value.every((i) => selectedIds.value.includes(i.id)));
    const somePendingSelected = computed(() => pending.value.some((i) => selectedIds.value.includes(i.id)));
    /** Select everything still to buy in this store, or drop that selection when it is already complete. */
    function selectAll() {
      const ids = pending.value.map((i) => i.id);
      selectedIds.value = allPendingSelected.value
        ? selectedIds.value.filter((id) => !ids.includes(id))
        : [...new Set([...selectedIds.value, ...ids])];
    }

    /** The square on a day header picks (or drops) everything bought that day. */
    function toggleGroupSelect(g) {
      const ids = g.items.map((i) => i.id);
      const all = ids.every((id) => selectedIds.value.includes(id));
      selectedIds.value = all
        ? selectedIds.value.filter((id) => !ids.includes(id))
        : [...new Set([...selectedIds.value, ...ids])];
    }
    const groupSelected = (g) => g.items.length > 0 && g.items.every((i) => selectedIds.value.includes(i.id));

    const hasDoneSelected = computed(() => selectedItems.value.some((i) => i.checkedDate));
    const hasPendingSelected = computed(() => selectedItems.value.some((i) => !i.checkedDate));

    /** Buy again: copies of the selected (already bought) items go on the list as new items. */
    function addAgain() {
      const list = selectedItems.value.filter((i) => i.checkedDate);
      if (!list.length) return;
      addCopies(list.map((i) => copyForList(i, { storeId: (storeById.value.has(i.storeId) ? i.storeId : ''), keepPrice: true })));
      clearSelection();
    }

    function openDateSheet() {
      bulkDate.value = today();
      showDateSheet.value = true;
    }

    /** Set the bought date of the selection ('' puts everything back on the list). */
    function applyBulkDate(date) {
      if (date && isFutureDate(date)) { showAlert('The bought date cannot be in the future.'); return; }
      const list = selectedItems.value;
      if (!list.length) return;
      showDateSheet.value = false;
      const before = list.map((i) => ({ i, checkedDate: i.checkedDate, order: i.order }));
      const others = items.value.filter((i) => !list.includes(i));
      const nextBy = {};
      list.forEach((i) => {
        if (date) { i.checkedDate = date; return; }
        if (!i.checkedDate) return;
        i.checkedDate = '';
        if (nextBy[i.storeId] === undefined) nextBy[i.storeId] = nextOrder(others, i.storeId);
        i.order = nextBy[i.storeId]++;
      });
      enqueue(() => SheetsApi.batchUpdateRows(props.sheetId, TABS.ITEMS, list.map((i) => ({ id: i.id, values: itemToRow(i) })))).catch(() => {
        before.forEach((b) => { b.i.checkedDate = b.checkedDate; b.i.order = b.order; });
        showAlert('Could not save that change. Check your connection and try again.');
      });
      clearSelection();
    }

    function checkOffSelected() {
      const list = selectedItems.value.filter((i) => !i.checkedDate);
      if (!list.length) return;
      if (list.length === 1) { // one item: same path as before, so the price box can offer itself
        clearSelection();
        toggleChecked(list[0]);
        return;
      }
      const before = list.map((i) => ({ i, checkedDate: i.checkedDate }));
      list.forEach((i) => { i.checkedDate = today(); });
      enqueue(() => SheetsApi.batchUpdateRows(props.sheetId, TABS.ITEMS, list.map((i) => ({ id: i.id, values: itemToRow(i) })))).catch(() => {
        before.forEach((b) => { b.i.checkedDate = b.checkedDate; });
        showAlert('Could not save that change. Check your connection and try again.');
      });
      clearSelection();
    }

    async function deleteSelected() {
      const list = selectedItems.value;
      if (!list.length) return;
      const n = list.length;
      if (!(await showConfirm(`Delete ${n} item${n === 1 ? '' : 's'}?`))) return;
      const ids = list.map((i) => i.id);
      const removed = list.slice();
      items.value = items.value.filter((i) => !ids.includes(i.id));
      enqueue(() => SheetsApi.deleteRows(props.sheetId, TABS.ITEMS, ids)).catch(() => {
        items.value.push(...removed);
        showAlert('Could not delete. Check your connection and try again.');
      });
      clearSelection();
    }

    function moveSelectedTo(storeId) {
      showMoveSheet.value = false;
      const list = selectedItems.value;
      if (!list.length) return;
      const before = list.map((i) => ({ i, storeId: i.storeId, order: i.order, price: i.price, paidAmount: i.paidAmount, paidCurrency: i.paidCurrency }));
      // A price that is in another currency than the new store's is cleared (see moveToStore).
      const target = storeCurrencyFor(storeId);
      const cleared = moveToStore(list, storeId, {
        startOrder: nextOrder(items.value, storeId), targetCurrency: target, baseCurrency: baseCurrency.value, trackPrices: trackPrices.value,
      });
      if (cleared > 0) say(`${cleared === 1 ? 'Price' : cleared + ' prices'} cleared: ${storeNameOf(storeId)} uses ${target}.`);
      enqueue(() => SheetsApi.batchUpdateRows(props.sheetId, TABS.ITEMS, list.map((i) => ({ id: i.id, values: itemToRow(i) })))).catch(() => {
        before.forEach((b) => { Object.assign(b.i, { storeId: b.storeId, order: b.order, price: b.price, paidAmount: b.paidAmount, paidCurrency: b.paidCurrency }); });
        showAlert('Could not move the items. Check your connection and try again.');
      });
      clearSelection();
    }

    // ── Reorder (drag) ────────────────────────────────────────────────────────
    let dragState = null;

    function toggleReorder() {
      reorderMode.value = !reorderMode.value;
      selectedIds.value = [];
    }

    function startDrag(e, item) {
      if (dragState) return;
      const list = pending.value;
      const index = list.findIndex((i) => i.id === item.id);
      const rows = [...(listEl.value?.querySelectorAll('[data-pending-row] [data-row-id]') || [])];
      if (index < 0 || rows.length !== list.length) return;
      const scroller = rows[index].closest('.main-content');
      dragState = {
        index, rows, target: index, scroller,
        h: rows[index].offsetHeight + 8,
        startY: e.clientY, lastY: e.clientY,
        startScroll: scroller ? scroller.scrollTop : 0,
        raf: 0, handle: e.currentTarget, pointerId: e.pointerId,
      };
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* not supported */ }
      rows[index].classList.add('gl-item--dragging');
      window.addEventListener('pointermove', onDragMove);
      window.addEventListener('pointerup', endDrag);
      window.addEventListener('pointercancel', cancelDrag);
      dragState.raf = requestAnimationFrame(dragFrame);
    }

    function onDragMove(e) { if (dragState) dragState.lastY = e.clientY; }

    function dragFrame() {
      const d = dragState;
      if (!d) return;
      if (d.scroller) {
        const r = d.scroller.getBoundingClientRect();
        if (d.lastY < r.top + 70) d.scroller.scrollTop -= 10;
        else if (d.lastY > r.bottom - 70) d.scroller.scrollTop += 10;
      }
      const dy = d.lastY - d.startY + (d.scroller ? d.scroller.scrollTop - d.startScroll : 0);
      const target = Math.max(0, Math.min(d.rows.length - 1, d.index + Math.round(dy / d.h)));
      d.target = target;
      d.rows.forEach((row, i) => {
        if (i === d.index) row.style.transform = `translateY(${dy}px)`;
        else if (target > d.index && i > d.index && i <= target) row.style.transform = `translateY(${-d.h}px)`;
        else if (target < d.index && i >= target && i < d.index) row.style.transform = `translateY(${d.h}px)`;
        else row.style.transform = '';
      });
      d.raf = requestAnimationFrame(dragFrame);
    }

    function finishDrag() {
      const d = dragState;
      dragState = null;
      cancelAnimationFrame(d.raf);
      window.removeEventListener('pointermove', onDragMove);
      window.removeEventListener('pointerup', endDrag);
      window.removeEventListener('pointercancel', cancelDrag);
      try { d.handle.releasePointerCapture(d.pointerId); } catch { /* already released */ }
      // Clear without animating back, Vue is about to put the rows in their new order.
      d.rows.forEach((row) => {
        row.style.transition = 'none';
        row.style.transform = '';
        row.classList.remove('gl-item--dragging');
      });
      requestAnimationFrame(() => d.rows.forEach((row) => { row.style.transition = ''; }));
      return d;
    }

    function endDrag() {
      const d = finishDrag();
      if (d.target !== d.index) commitReorder(d.index, d.target);
    }
    function cancelDrag() { finishDrag(); }

    function commitReorder(from, to) {
      const list = pending.value;
      const changes = reorderList(list, from, to);
      if (!changes.length) return;
      const before = changes.map((c) => ({ item: items.value.find((i) => i.id === c.id), order: items.value.find((i) => i.id === c.id)?.order }));
      changes.forEach((c) => { const it = items.value.find((i) => i.id === c.id); if (it) it.order = c.order; });
      const moved = changes.map((c) => items.value.find((i) => i.id === c.id)).filter(Boolean);
      enqueue(() => SheetsApi.batchUpdateRows(props.sheetId, TABS.ITEMS, moved.map((i) => ({ id: i.id, values: itemToRow(i) })))).catch(() => {
        before.forEach((b) => { if (b.item) b.item.order = b.order; });
        showAlert('Could not save the new order. Check your connection and try again.');
      });
    }

    // ── Item sheet (new + edit): the form itself lives in ItemSheet.js ─────────
    const itemSheet = reactive({ open: false, isNew: false, seed: null });

    function openNew() {
      itemSheet.seed = { title: newTitle.value, quantity: newQty.value, storeId: currentStoreId.value, typedPrice: newPrice.value };
      itemSheet.isNew = true;
      itemSheet.open = true;
    }

    function openEdit(item) {
      itemSheet.seed = item;
      itemSheet.isNew = false;
      itemSheet.open = true;
    }

    function closeSheet() { itemSheet.open = false; }

    function onSheetSave({ id, isNew, values: v }) {
      if (isNew) {
        const item = buildNewItem({ ...v, order: nextOrder(items.value, v.storeId) });
        closeSheet();
        newTitle.value = '';
        newQty.value = '';
        newPrice.value = '';
        addItemNow(item);
        if (!item.checkedDate && item.storeId === currentStoreId.value) scrollRowIntoView(item.id);
        return;
      }

      const item = items.value.find((i) => i.id === id);
      if (!item) { closeSheet(); return; }
      const before = { ...item };
      const storeChanged = (item.storeId || '') !== v.storeId;
      Object.assign(item, v);
      if (storeChanged) item.order = nextOrder(items.value.filter((i) => i.id !== item.id), v.storeId);
      closeSheet();
      persistItem(item, () => Object.assign(item, before));
    }

    function duplicateFromSheet(id) {
      const src = items.value.find((i) => i.id === id);
      if (!src) return;
      const copy = buildNewItem({
        ...copyForList(src, { keepPrice: true }),
        order: nextOrder(items.value, src.storeId),
      });
      closeSheet();
      addItemNow(copy);
      scrollRowIntoView(copy.id);
    }

    async function deleteFromSheet(id) {
      const item = items.value.find((i) => i.id === id);
      if (!item) return;
      if (!(await showConfirm('Delete "' + item.title + '"?'))) return;
      closeSheet();
      items.value = items.value.filter((i) => i.id !== item.id);
      enqueue(() => SheetsApi.deleteRows(props.sheetId, TABS.ITEMS, [item.id])).catch(() => {
        items.value.push(item);
        showAlert('Could not delete. Check your connection and try again.');
      });
    }

    // ── Helpers for the template ──────────────────────────────────────────────
    const fmt = (n) => formatCurrency(n, baseCurrency.value);

    onMounted(() => {
      restoreSelectedStore();
      fetchItems();
    });
    onUnmounted(() => { if (dragState) cancelDrag(); });

    return {
      items, loading, loadError, fetchItems, trackPrices, baseCurrency, fmt, formatCurrency,
      tabs, tabsEl, currentStoreId, currentStore, selectTab, activeStores,
      pending, doneGroups, estimate, hasAnyPrice, isDoneOpen, toggleDone, formatDateLabel,
      storeNameOf, newTitle, inputFocused, quickInput, suggestions, quickAdd, listEl, leaving,
      toggleChecked, onRowOpen, startDrag,
      reorderMode, toggleReorder, hasSelection, clearSelection, toggleSelect, allPendingSelected, somePendingSelected,
      selectedIds, selectedItems, selectedTotal, selectAll,
      checkOffSelected, deleteSelected, moveSelectedTo, showMoveSheet,
      toggleGroupSelect, groupSelected, hasDoneSelected, hasPendingSelected, addAgain,
      showTripSheet, onTripAdd, showDateSheet, bulkDate, openDateSheet, applyBulkDate,
      newQty, newPrice, quickPriceHint, toast, snack, saveSnack, undoSnack, armSnack, hideSnack,
      storeCurrencyFor, today,
      yesterday: () => { const d = new Date(); d.setDate(d.getDate() - 1); return localDateISO(d); },
      itemSheet, openNew, closeSheet, onSheetSave, duplicateFromSheet, deleteFromSheet,
      sanitizeAmountText, sanitizeQuantityText, flipSign,
      showStoreSheet, onStoreSaved,
    };
  },

  template: `
    <div class="subpage">
      <div class="subpage-scroll">
      <div class="subpage-nav">
        <button class="subpage-back subpage-back--colored" @click="$emit('go-home')">
          <span class="material-icons">arrow_back</span>
        </button>
        <h1 class="subpage-nav-title">Groceries</h1>
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

    <div class="gl-page">
      <div v-if="loading" class="loading" style="padding-top:60px;"><div class="spinner"></div>Loading your list...</div>

      <div v-else-if="loadError" class="empty-state gl-empty">
        <span class="material-icons">cloud_off</span>
        <h3>Something went wrong</h3>
        <p>{{ loadError }}</p>
        <button class="btn-link" @click="fetchItems()">Try again</button>
      </div>

      <template v-else>
        <div class="gl-store-tabs" v-if="activeStores.length > 0" ref="tabsEl" role="tablist">
          <button v-for="t in tabs" :key="t.id || '__none'" class="gl-store-tab" :class="{ active: t.id === currentStoreId }"
                  role="tab" :aria-selected="t.id === currentStoreId" @click="selectTab(t.id)">
            {{ t.name }}<span v-if="t.count > 0" class="gl-store-tab-count">{{ t.count }}</span>
          </button>
          <button class="gl-store-tab gl-store-tab--add" @click="showStoreSheet = true"><span class="material-icons">add</span>Store</button>
        </div>

        <div class="gl-summary">
          <div class="gl-summary-main">
            <button v-if="pending.length > 0" type="button" class="gl-check gl-check--square gl-summary-check"
                    :class="{ checked: allPendingSelected, partial: !allPendingSelected && somePendingSelected }" :disabled="reorderMode"
                    role="checkbox" :aria-checked="allPendingSelected ? 'true' : (somePendingSelected ? 'mixed' : 'false')"
                    :aria-label="allPendingSelected ? 'Deselect all' : 'Select all'" @click="selectAll">
              <span class="gl-check-circle"><span class="material-icons">{{ !allPendingSelected && somePendingSelected ? 'remove' : 'check' }}</span></span>
            </button>
            <div>
              <template v-if="pending.length > 0">
                {{ pending.length }} {{ pending.length === 1 ? 'item' : 'items' }}
                <template v-if="trackPrices"> · <span class="gl-summary-total">{{ fmt(estimate) }}</span></template>
              </template>
              <template v-else>Nothing to buy</template>
            </div>
          </div>
          <div class="gl-summary-actions">
            <button class="gl-icon-btn" aria-label="Add from a previous trip" title="Add from a previous trip" @click="showTripSheet = true"><span class="material-icons">playlist_add</span></button>
            <button class="gl-icon-btn" :class="{ active: reorderMode }" aria-label="Reorder items" @click="toggleReorder" :disabled="pending.length < 2"><span class="material-icons">swap_vert</span></button>
            <button class="gl-icon-btn" aria-label="Refresh" @click="fetchItems(true)"><span class="material-icons">refresh</span></button>
          </div>
        </div>

        <div class="gl-main-area" ref="listEl">
          <div v-if="items.length === 0" class="empty-state gl-empty">
            <span class="material-icons">shopping_basket</span>
            <h3>Your list is empty</h3>
            <p>Type what you need below and press enter. Select items to mark them as bought. Add a quantity (a number, like 12 or 500) if it helps you pick the right product.</p>
            <button v-if="activeStores.length === 0" class="btn-link" @click="showStoreSheet = true">Add the stores you shop at</button>
          </div>

          <div class="gl-list" v-if="pending.length > 0">
            <div v-for="item in pending" :key="item.id" data-pending-row>
              <gl-item :item="item" :done="false" :selected="selectedIds.includes(item.id)"
                       :reorder="reorderMode" :show-price="trackPrices" :currency="baseCurrency" :leaving="!!leaving[item.id]"
                       @open="onRowOpen" @select="toggleSelect" @drag="startDrag" />
            </div>
          </div>
          <div v-else-if="items.length > 0 && doneGroups.length > 0" class="empty-state gl-empty" style="padding-bottom:8px;">
            <span class="material-icons">done_all</span>
            <h3>All done here</h3>
            <p>Everything on this list has been bought.</p>
          </div>

          <div class="gl-list" v-for="g in doneGroups" :key="g.date">
            <button class="gl-done-head" :class="{ open: isDoneOpen(g.date) }" @click="toggleDone(g.date)">
              <span class="gl-check gl-check--square" :class="{ checked: groupSelected(g) }" role="checkbox" tabindex="0"
                    :aria-checked="groupSelected(g)" :aria-label="'Select everything from ' + formatDateLabel(g.date)"
                    @click.stop="toggleGroupSelect(g)" @keydown.enter.stop.prevent="toggleGroupSelect(g)" @keydown.space.stop.prevent="toggleGroupSelect(g)">
                <span class="gl-check-circle"><span class="material-icons">check</span></span>
              </span>
              <span>{{ formatDateLabel(g.date) }}</span>
              <span v-if="trackPrices && g.total !== 0" class="gl-done-head-total">{{ fmt(g.total) }}</span>
              <span class="material-icons" :style="trackPrices && g.total !== 0 ? '' : 'margin-left:auto'">expand_more</span>
            </button>
            <template v-if="isDoneOpen(g.date)">
              <gl-item v-for="item in g.items" :key="item.id" :item="item" :done="true" :selected="selectedIds.includes(item.id)"
                       :reorder="false" :show-price="trackPrices" :currency="baseCurrency" :leaving="!!leaving[item.id]"
                       @open="onRowOpen" @select="toggleSelect" />
            </template>
          </div>
        </div>

        <!-- Bottom bars: quick add, select actions, or reorder hint -->
        <div v-if="hasSelection" class="gl-select-bar gl-select-bar--stack">
          <div class="gl-select-top">
            <span class="gl-select-count">{{ selectedIds.length }} selected<template v-if="selectedTotal !== null"> · <strong>{{ fmt(selectedTotal) }}</strong></template></span>
            <button class="gl-icon-btn" aria-label="Clear selection" @click="clearSelection"><span class="material-icons">close</span></button>
          </div>
          <div class="gl-select-actions">
            <button v-if="hasPendingSelected" class="gl-act" :disabled="selectedIds.length === 0" @click="checkOffSelected"><span class="material-icons">done</span>Bought</button>
            <button v-if="hasDoneSelected" class="gl-act" :disabled="selectedIds.length === 0" @click="addAgain"><span class="material-icons">add_shopping_cart</span>Buy again</button>
            <button class="gl-act" :disabled="selectedIds.length === 0" @click="openDateSheet"><span class="material-icons">event</span>Date</button>
            <button class="gl-act" :disabled="selectedIds.length === 0 || activeStores.length === 0" @click="showMoveSheet = true"><span class="material-icons">drive_file_move</span>Move</button>
            <button class="gl-act gl-act--danger" :disabled="selectedIds.length === 0" @click="deleteSelected"><span class="material-icons">delete</span>Delete</button>
          </div>
        </div>
        <div v-else-if="reorderMode" class="gl-select-bar">
          <span class="gl-select-count">Drag the handles to reorder</span>
          <button class="btn btn-text" @click="toggleReorder">Done</button>
        </div>
        <div v-else class="gl-quick">
          <div v-if="suggestions.length > 0" class="gl-suggest" role="listbox">
            <button v-for="s in suggestions" :key="s.title + '|' + s.quantity + '|' + s.price + '|' + s.paidAmount + '|' + s.fromStoreId" class="gl-suggest-item" @mousedown.prevent @click="quickAdd(s)">
              <span class="material-icons">history</span>
              <span class="gl-suggest-main">{{ s.title }}</span>
              <span v-if="s.quantity" class="gl-item-qty">{{ s.quantity }}</span>
              <span v-if="trackPrices && typeof s.price === 'number'" class="gl-suggest-price">{{ fmt(s.price) }}<small v-if="s.paidAmount && s.paidCurrency">{{ formatCurrency(s.paidAmount, s.paidCurrency) }}</small></span>
              <span class="gl-suggest-meta">{{ s.fromStoreId !== undefined ? (storeNameOf(s.fromStoreId)) : formatDateLabel(s.lastDate) }}</span>
            </button>
          </div>
          <div v-if="toast.text" class="gl-toast" role="status">{{ toast.text }}</div>
          <div v-if="snack.itemId" class="gl-snack">
            <div class="gl-snack-head"><span class="material-icons">check_circle</span><span class="gl-snack-title">{{ snack.title }}</span>
              <button type="button" class="gl-snack-undo" @click="undoSnack">Undo</button>
              <button type="button" class="gl-icon-btn gl-snack-close" aria-label="Dismiss" @click="hideSnack"><span class="material-icons">close</span></button>
            </div>
            <form class="gl-snack-row" @submit.prevent="saveSnack">
              <input class="gl-snack-input" v-model="snack.text" type="text" inputmode="decimal" autocomplete="off"
                     :placeholder="'Price in ' + snack.currency" aria-label="Price"
                     @input="snack.text = sanitizeAmountText(snack.text); armSnack()" @focus="armSnack()" />
              <button type="button" class="gl-sign-btn" aria-label="Make it a discount or refund (negative)" title="Negative amount: discount or refund" @click="snack.text = flipSign(snack.text); armSnack()">+/−</button>
              <span class="gl-snack-cur">{{ snack.currency }}</span>
              <button type="submit" class="gl-snack-save" :disabled="snack.busy">Save price</button>
            </form>
          </div>
          <form class="gl-quick-row" @submit.prevent="quickAdd()">
            <input ref="quickInput" class="gl-quick-input" v-model="newTitle" type="text" enterkeyhint="done"
                   autocomplete="off" autocapitalize="sentences" aria-label="Add an item"
                   :placeholder="currentStore ? 'Add to ' + currentStore.name + '...' : 'Add an item...'"
                   @focus="inputFocused = true" @blur="inputFocused = false" />
            <input class="gl-quick-qty" v-model="newQty" @input="newQty = sanitizeQuantityText(newQty)" type="text" inputmode="decimal" autocomplete="off" aria-label="Quantity"
                   placeholder="Qty" maxlength="9" />
            <input v-if="trackPrices" class="gl-quick-qty gl-quick-price" v-model="newPrice" @input="newPrice = sanitizeAmountText(newPrice)" @focus="$event.target.select()"
                   type="text" inputmode="decimal" autocomplete="off" :aria-label="'Price in ' + quickPriceHint" :placeholder="quickPriceHint" maxlength="10" />
            <button type="button" class="gl-quick-btn" aria-label="Add with details" @mousedown.prevent @click="openNew"><span class="material-icons">tune</span></button>
            <button type="submit" class="gl-quick-btn gl-quick-btn--go" aria-label="Add" :disabled="!newTitle.trim()" @mousedown.prevent><span class="material-icons">add</span></button>
          </form>
        </div>
      </template>

      <store-sheet :open="showStoreSheet" :store="null" :stores="stores || []" :sheet-id="sheetId" :base-currency="baseCurrency"
                   @close="showStoreSheet = false" @saved="onStoreSaved" />
      <trip-sheet :open="showTripSheet" :items="items" :stores="stores" :current-store-id="currentStoreId"
                  :track-prices="trackPrices" :base-currency="baseCurrency"
                  @close="showTripSheet = false" @add="onTripAdd" />

      <!-- Date sheet (for the selection) -->
      <div class="modal-overlay" :class="{ open: showDateSheet }" @click.self="showDateSheet = false">
        <div class="modal">
          <div class="sheet-handle"></div>
          <div class="modal-header">
            <h2>Bought on</h2>
            <button class="btn-icon" @click="showDateSheet = false"><span class="material-icons">close</span></button>
          </div>
          <div class="modal-body">
            <p class="gl-sheet-hint">Set the purchase date of the {{ selectedIds.length }} selected {{ selectedIds.length === 1 ? 'item' : 'items' }}. Handy to log a shop you did earlier.</p>
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
              <button class="btn btn-text" @click="applyBulkDate('')">Not bought yet (back on the list)</button>
              <button class="btn btn-text" @click="showDateSheet = false">Cancel</button>
            </div>
          </div>
        </div>
      </div>

      <!-- Move sheet -->
      <div class="modal-overlay" :class="{ open: showMoveSheet }" @click.self="showMoveSheet = false">
        <div class="modal">
          <div class="sheet-handle"></div>
          <div class="modal-header">
            <h2>Move to</h2>
            <button class="btn-icon" @click="showMoveSheet = false"><span class="material-icons">close</span></button>
          </div>
          <div class="modal-body" style="padding:0 0 16px;">
            <div v-for="s in activeStores" :key="s.id" class="month-picker-option" :class="{ selected: s.id === currentStoreId }" @click="moveSelectedTo(s.id)">
              <span class="month-picker-label">{{ s.name }}</span><span class="month-picker-total">{{ s.city }}</span>
            </div>
            <div class="month-picker-option" :class="{ selected: currentStoreId === '' }" @click="moveSelectedTo('')">
              <span class="month-picker-label">Anywhere</span><span class="month-picker-total"></span>
            </div>
          </div>
        </div>
      </div>

      <item-sheet :open="itemSheet.open" :is-new="itemSheet.isNew" :seed="itemSheet.seed" :stores="stores || []" :settings="settings"
                  @close="closeSheet" @save="onSheetSave" @duplicate="duplicateFromSheet" @delete="deleteFromSheet" />
    </div>
      </div>
    </div>
  `,
};
