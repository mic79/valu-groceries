/**
 * Add / edit store sheet. Shared by the Stores page and the shopping page ("+ Store"), so a store can
 * be added right where the need comes up. It saves to the sheet itself and reports the result:
 *   saved   { store, isNew }   the store as written
 *   deleted id                 the store id that was removed (its items were moved to "Anywhere")
 */

import SheetsApi, { TABS, CURRENCIES } from './sheetsApi.js';
import { storeToRow, rowToItem, itemToRow, capitalizeFirst } from './groceryLogic.js';

const { ref, reactive, computed, watch, inject, nextTick } = Vue;

export default {
  props: {
    open: Boolean,
    /** The store to edit, or null to add a new one. */
    store: { type: Object, default: null },
    /** All current stores (used to put a new one last). */
    stores: { type: Array, default: () => [] },
    sheetId: String,
    baseCurrency: { type: String, default: 'USD' },
  },
  emits: ['close', 'saved', 'deleted'],

  setup(props, { emit }) {
    const showAlert = inject('showAlert', (m) => window.alert(m));
    const showConfirm = inject('showConfirm', (m) => Promise.resolve(window.confirm(m)));

    const sheet = reactive({ isNew: true, id: '', name: '', city: '', currency: '', hidden: false, saving: false });
    const currencyOpen = ref(false);
    const currencySearch = ref('');
    const nameInput = ref(null);

    watch(() => props.open, (isOpen) => {
      if (!isOpen) return;
      const s = props.store;
      Object.assign(sheet, s
        ? { isNew: false, id: s.id, name: s.name, city: s.city || '', currency: s.currency || '', hidden: !!s.hidden, saving: false }
        : { isNew: true, id: '', name: '', city: '', currency: '', hidden: false, saving: false });
      currencyOpen.value = false; currencySearch.value = '';
      if (!s) nextTick(() => setTimeout(() => nameInput.value?.focus(), 150));
    }, { immediate: true });

    function close() { if (!sheet.saving) emit('close'); }

    const filteredCurrencies = computed(() => {
      const q = currencySearch.value.trim().toLowerCase();
      return CURRENCIES.filter((c) => !q || c.code.toLowerCase().includes(q) || c.name.toLowerCase().includes(q));
    });
    const currencyLabel = (code) => {
      if (!code) return 'Same as group (' + props.baseCurrency + ')';
      const c = CURRENCIES.find((x) => x.code === code);
      return c ? `${c.code} · ${c.name}` : code;
    };
    function pickCurrency(code) { sheet.currency = code; currencyOpen.value = false; }

    async function save() {
      const name = capitalizeFirst(sheet.name.trim());
      if (!name) { showAlert('Give the store a name.'); return; }
      sheet.saving = true;
      try {
        if (sheet.isNew) {
          const order = props.stores.length ? Math.max(...props.stores.map((s) => s.order)) + 1 : 0;
          const store = { id: SheetsApi.generateId(), name, city: sheet.city.trim(), order, hidden: sheet.hidden, currency: sheet.currency };
          await SheetsApi.appendRow(props.sheetId, TABS.STORES, storeToRow(store));
          emit('saved', { store, isNew: true });
        } else {
          const old = props.stores.find((s) => s.id === sheet.id);
          if (!old) { emit('close'); return; }
          const store = { ...old, name, city: sheet.city.trim(), hidden: sheet.hidden, currency: sheet.currency };
          await SheetsApi.updateRow(props.sheetId, TABS.STORES, store.id, storeToRow(store));
          emit('saved', { store, isNew: false });
        }
      } catch {
        showAlert('Could not save the store. Check your connection and try again.');
      } finally {
        sheet.saving = false;
      }
    }

    async function remove() {
      const store = props.stores.find((s) => s.id === sheet.id);
      if (!store) return;
      if (!(await showConfirm('Delete "' + store.name + '"? Its items stay in your history and move to "Anywhere".'))) return;
      sheet.saving = true;
      try {
        // Re-home the items first, so nothing is left pointing at a store that no longer exists.
        const rows = await SheetsApi.getTabData(props.sheetId, TABS.ITEMS);
        const moved = rows.map(rowToItem).filter((i) => i.id && i.storeId === store.id);
        moved.forEach((i) => { i.storeId = ''; });
        if (moved.length) {
          await SheetsApi.batchUpdateRows(props.sheetId, TABS.ITEMS, moved.map((i) => ({ id: i.id, values: itemToRow(i) })));
        }
        await SheetsApi.deleteRows(props.sheetId, TABS.STORES, [store.id]);
        emit('deleted', store.id);
      } catch {
        showAlert('Could not delete the store. Check your connection and try again.');
      } finally {
        sheet.saving = false;
      }
    }

    return { sheet, currencyOpen, currencySearch, nameInput, close, save, remove, filteredCurrencies, currencyLabel, pickCurrency };
  },

  template: `
    <div class="modal-overlay" :class="{ open }" @click.self="close">
      <div class="modal">
        <div class="sheet-handle"></div>
        <div class="modal-header">
          <h2>{{ sheet.isNew ? 'New store' : 'Edit store' }}</h2>
          <button class="btn-icon" @click="close"><span class="material-icons">close</span></button>
        </div>
        <div class="sheet-hero">
          <input ref="nameInput" class="sheet-hero-name-solo" v-model="sheet.name" placeholder="Store name" autocomplete="off" @keydown.enter.prevent="save" />
        </div>
        <div class="modal-body">
          <div class="sheet-section-title">Details</div>
          <div class="sheet-list-item">
            <label>City or branch</label>
            <input type="text" v-model="sheet.city" placeholder="Optional" autocomplete="off" />
          </div>
          <div class="sheet-list-item">
            <label>Currency</label>
            <valu-currency-picker v-model:open="currencyOpen" v-model:search="currencySearch">
              <template #label>{{ currencyLabel(sheet.currency) }}</template>
              <div class="currency-picker-option" :class="{ selected: !sheet.currency }" @click="pickCurrency('')">Same as group ({{ baseCurrency }})</div>
              <div v-for="c in filteredCurrencies" :key="c.code" class="currency-picker-option" :class="{ selected: c.code === sheet.currency }" @click="pickCurrency(c.code)">{{ c.code }} · {{ c.name }}</div>
              <div v-if="filteredCurrencies.length === 0" class="currency-picker-empty">No match</div>
            </valu-currency-picker>
          </div>
          <p style="font-size:12px;color:var(--color-text-hint);margin:4px 0 12px;">
            For shops abroad: prices you enter here are converted to {{ baseCurrency }} using the exchange rate of the day.
          </p>
          <div class="list-item" style="padding-left:0;padding-right:0;">
            <div class="list-item-content">
              <div class="list-item-title">Show this store</div>
              <div class="list-item-subtitle">Turn off to remove it from the Groceries page. Nothing is deleted.</div>
            </div>
            <label class="toggle">
              <input type="checkbox" :checked="!sheet.hidden" aria-label="Show this store" @change="sheet.hidden = !$event.target.checked" />
              <div class="toggle-track"></div>
              <div class="toggle-thumb"></div>
            </label>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn-sheet-cta" @click="save" :disabled="!sheet.name.trim() || sheet.saving">{{ sheet.saving ? 'Saving…' : (sheet.isNew ? 'Add store' : 'Save changes') }}</button>
          <div class="modal-footer-row">
            <button v-if="!sheet.isNew" class="btn btn-text btn-danger" :disabled="sheet.saving" @click="remove">Delete</button>
            <button class="btn btn-text" :disabled="sheet.saving" @click="close">Cancel</button>
          </div>
        </div>
      </div>
    </div>
  `,
};
