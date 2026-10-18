/**
 * Add / edit item sheet. Shared by the Groceries page and the History page, so a purchase can be
 * corrected (price, date, quantity, store, notes) exactly like an item on the list. A price typed in
 * another currency is converted to the group's base currency at entry time, like Valu Finance.
 *
 * The sheet only collects and validates the values; the page decides how to save them:
 *   save       { id, isNew, values }   values: title, quantity, price, paidAmount, paidCurrency, notes, checkedDate, storeId
 *   duplicate  id
 *   delete     id
 *   close
 *
 * `seed` carries what to start from. For a new item: title, quantity, storeId and typedPrice (text from the
 * quick-add bar). For an existing item: the item itself.
 */

import { CURRENCIES } from './sheetsApi.js';
import { useFxConvert } from './useFxConvert.js';
import {
  localDateISO, isFutureDate, parseAmount, roundMoney, sanitizeAmountText, flipSign, cleanQuantity, sanitizeQuantityText,
  capitalizeFirst, parseCurrencyRates,
} from './groceryLogic.js';
import { STORAGE_PREFIX } from './config.js';

const { ref, reactive, computed, inject, nextTick, watch } = Vue;

export function amountText(n) {
  const s = String(n);
  return localStorage.getItem(STORAGE_PREFIX + 'number_format') === 'de-DE' ? s.replace('.', ',') : s;
}
/** A price field is never empty: it starts at 0,00 (as in Nutri). 0 simply means "no price yet". */
export function zeroText() { return amountText('0.00'); }
export function isZeroPrice(text) { const t = String(text ?? '').trim(); return t === '' || parseAmount(t) === 0; }

export default {
  props: {
    open: Boolean,
    isNew: Boolean,
    seed: { type: Object, default: null },
    stores: { type: Array, default: () => [] },
    settings: { type: Object, default: () => ({}) },
    /** Label of the main button when adding. */
    addLabel: { type: String, default: 'Add to list' },
    /** The secondary action of an existing item: a copy on the Groceries page asks for 'Duplicate', History for 'Add to list'. */
    duplicateLabel: { type: String, default: 'Duplicate' },
    duplicateIcon: { type: String, default: 'content_copy' },
    /** History: what was paid is a fact, so picking another store (to fix a mistake) must not wipe the price. */
    keepPriceOnStoreChange: Boolean,
  },
  emits: ['close', 'save', 'duplicate', 'delete'],

  setup(props, { emit }) {
    const showAlert = inject('showAlert', (m) => window.alert(m));

    const baseCurrency = computed(() => props.settings?.baseCurrency || 'USD');
    const trackPrices = computed(() => (props.settings?.trackPrices ?? 'true') !== 'false');
    const manualRates = computed(() => parseCurrencyRates(props.settings?.currencyRates));
    const storeById = computed(() => new Map((props.stores || []).map((s) => [s.id, s])));
    const storeCurrencyFor = (storeId) => storeById.value.get(storeId)?.currency || baseCurrency.value;

    const sheet = reactive({
      isNew: false, id: '', title: '', price: '', quantity: '', storeId: '',
      checkedDate: '', notes: '', payCurrency: '', currencyTouched: false, saving: false,
      keepPrice: null, keepPaidAmount: null, keepPaidCurrency: '',
    });
    const openDropdown = ref(null);
    const currencyOpen = ref(false);
    const currencySearch = ref('');
    const titleInput = ref(null);

    const payCurrencyRef = computed(() => sheet.payCurrency);
    const fxDate = computed(() => sheet.checkedDate || localDateISO());
    const fx = useFxConvert({
      foreignCurrency: payCurrencyRef,
      baseCurrency,
      dateStr: fxDate,
      setAmount: (v) => { sheet.price = v; },
      manualRates,
    });

    function resetSheetFx() {
      fx.reset();
      currencyOpen.value = false;
      currencySearch.value = '';
      openDropdown.value = null;
    }

    function initNew(seed) {
      resetSheetFx();
      Object.assign(sheet, {
        isNew: true, id: '', title: (seed.title || '').trim(), price: zeroText(), quantity: cleanQuantity(seed.quantity || ''),
        storeId: seed.storeId || '', checkedDate: '', notes: '', currencyTouched: false, saving: false,
        keepPrice: null, keepPaidAmount: null, keepPaidCurrency: '',
        payCurrency: storeCurrencyFor(seed.storeId || ''),
      });
      if (trackPrices.value && fx.needsFx.value) fx.toggle();
      // Whatever was typed in the bar's price box comes along (in the store's currency).
      const typedPrice = String(seed.typedPrice ?? '').trim();
      if (trackPrices.value && typedPrice !== '' && !isZeroPrice(typedPrice)) {
        if (fx.fxActive.value) fx.fxForeignAmount.value = typedPrice;
        else sheet.price = typedPrice;
      }
      nextTick(() => setTimeout(() => titleInput.value?.focus(), 150));
    }

    function initEdit(item) {
      resetSheetFx();
      Object.assign(sheet, {
        isNew: false, id: item.id, title: item.title,
        price: typeof item.price === 'number' ? String(item.price) : '',
        quantity: item.quantity, storeId: item.storeId || '', checkedDate: item.checkedDate || '',
        notes: item.notes || '', currencyTouched: false, saving: false, keepPrice: item.price ?? null,
        keepPaidAmount: item.paidAmount ?? null, keepPaidCurrency: item.paidCurrency || '',
        payCurrency: baseCurrency.value,
      });
      sheet.price = typeof item.price === 'number' ? amountText(item.price) : zeroText();
      if (!trackPrices.value) return;
      if (item.paidAmount && item.paidCurrency && typeof item.price === 'number') {
        // Bought abroad: reopen with the amount that was actually paid, not the converted one.
        sheet.payCurrency = item.paidCurrency;
        fx.restore(item.paidAmount, item.price);
      } else if (item.price === null || item.price === undefined) {
        // No price yet: start in the store's own currency.
        sheet.payCurrency = storeCurrencyFor(item.storeId || '');
        if (fx.needsFx.value) fx.toggle();
      }
    }

    watch(() => props.open, (isOpen) => {
      if (!isOpen) { resetSheetFx(); return; }
      if (props.isNew) initNew(props.seed || {});
      else if (props.seed) initEdit(props.seed);
    }, { immediate: true });

    function close() { emit('close'); }

    /**
     * Changing the store changes the currency: a price typed for a shop in EUR means nothing at a shop
     * in CAD. When the new store's currency is not the one the price is in, the price goes back to
     * 0,00 and the currency becomes the new store's (converting again if that is a foreign one).
     * A currency you picked yourself in this form is left alone.
     */
    function onStorePicked(storeId) {
      const priceCurrency = fx.fxActive.value ? sheet.payCurrency : baseCurrency.value;
      sheet.storeId = storeId;
      openDropdown.value = null;
      if (!trackPrices.value || sheet.currencyTouched || props.keepPriceOnStoreChange) return;
      const next = storeCurrencyFor(storeId);
      if (next === priceCurrency) return;
      fx.reset();
      sheet.price = zeroText();
      sheet.keepPrice = null;
      sheet.keepPaidAmount = null;
      sheet.keepPaidCurrency = '';
      sheet.payCurrency = next;
      if (fx.needsFx.value) fx.toggle();
    }

    function pickCurrency(code) {
      sheet.payCurrency = code;
      sheet.currencyTouched = true;
      currencyOpen.value = false;
      if (code === baseCurrency.value) fx.reset();
    }

    const filteredCurrencies = computed(() => {
      const q = currencySearch.value.trim().toLowerCase();
      const list = CURRENCIES.slice();
      for (const code of [baseCurrency.value, sheet.payCurrency]) {
        if (code && !list.some((c) => c.code === code)) list.push({ code, name: code });
      }
      return list.filter((c) => !q || c.code.toLowerCase().includes(q) || c.name.toLowerCase().includes(q));
    });
    const currencyLabel = (code) => {
      const c = CURRENCIES.find((x) => x.code === code);
      return c ? `${c.code} · ${c.name}` : code;
    };

    const activeStores = computed(() =>
      [...(props.stores || [])].filter((s) => !s.hidden).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name)));
    const storeLabel = (id) => (id ? (storeById.value.get(id)?.name || 'Anywhere') : 'Anywhere');
    const sheetStoreOptions = computed(() => {
      const list = activeStores.value.slice();
      const cur = storeById.value.get(sheet.storeId);
      if (cur && cur.hidden) list.push(cur);
      return list;
    });

    function collectSheetValues() {
      const title = capitalizeFirst(sheet.title.trim());
      if (!title) { showAlert('Give the item a name.'); return null; }
      const quantity = cleanQuantity(sheet.quantity);
      let price = sheet.keepPrice;
      let paidAmount = null;
      let paidCurrency = '';
      if (trackPrices.value) {
        const txt = String(sheet.price).trim();
        if (txt === '') price = null;
        else {
          const n = parseAmount(txt);
          if (!Number.isFinite(n)) { showAlert('That price does not look right.'); return null; }
          price = n === 0 ? null : roundMoney(n);
          // Typed in another currency: keep what was paid next to the converted price.
          if (fx.fxActive.value) {
            const foreign = fx.foreignValue();
            if (Number.isFinite(foreign) && foreign !== 0) { paidAmount = roundMoney(foreign); paidCurrency = fx.fxCurrency.value; }
          }
        }
      } else if (sheet.keepPrice !== null && !sheet.isNew) {
        paidAmount = sheet.keepPaidAmount;
        paidCurrency = sheet.keepPaidCurrency;
      }
      if (sheet.checkedDate && isFutureDate(sheet.checkedDate)) {
        showAlert('The bought date cannot be in the future.');
        return null;
      }
      return {
        title, quantity, price: price ?? null, paidAmount: price === null ? null : paidAmount, paidCurrency: price === null ? '' : paidCurrency,
        notes: sheet.notes.trim(), checkedDate: sheet.checkedDate || '', storeId: sheet.storeId || '',
      };
    }

    function saveSheet() {
      if (sheet.saving) return;
      if (fx.fxActive.value && fx.fxLoading.value) { showAlert('Still fetching the exchange rate, one moment.'); return; }
      if (fx.fxActive.value && sheet.price === '' && String(fx.fxForeignAmount.value).trim() !== '') {
        showAlert('The converted price is not ready. Enter the price in ' + baseCurrency.value + ' directly, or try again.');
        return;
      }
      const values = collectSheetValues();
      if (!values) return;
      emit('save', { id: sheet.id, isNew: sheet.isNew, values });
    }

    return {
      sheet, baseCurrency, trackPrices, fx, openDropdown, currencyOpen, currencySearch, titleInput,
      close, saveSheet, onStorePicked, pickCurrency, filteredCurrencies, currencyLabel, storeLabel, sheetStoreOptions,
      sanitizeAmountText, sanitizeQuantityText, flipSign, zeroText,
      duplicate: () => emit('duplicate', sheet.id),
      remove: () => emit('delete', sheet.id),
    };
  },

  template: `
    <div class="modal-overlay" :class="{ open }" @click.self="close">
      <div class="modal">
        <div class="sheet-handle"></div>
        <div class="modal-header">
          <h2>{{ sheet.isNew ? 'New item' : 'Edit item' }}</h2>
          <button class="btn-icon" @click="close"><span class="material-icons">close</span></button>
        </div>
        <div class="sheet-hero">
          <input ref="titleInput" class="sheet-hero-name" v-model="sheet.title" placeholder="What do you need?" autocomplete="off" @keydown.enter.prevent="saveSheet" />
          <template v-if="trackPrices">
            <input class="sheet-hero-amount" v-model="sheet.price" @input="sheet.price = sanitizeAmountText(sheet.price)" @focus="$event.target.select()"
                   type="text" inputmode="decimal" placeholder="0,00" :readonly="fx.fxActive.value"
                   :class="{ 'fx-readonly': fx.fxActive.value }" aria-label="Price" />
            <div class="sheet-hero-label">Price <span class="fx-base-tag">in {{ baseCurrency }}</span>
              <button v-if="!fx.fxActive.value" type="button" class="gl-sign-btn" aria-label="Make it a discount or refund (negative)" title="Negative amount: discount or refund" @click="sheet.price = flipSign(sheet.price)">+/−</button></div>
          </template>
        </div>
        <div v-if="trackPrices && fx.needsFx.value" class="fx-convert-section">
          <button class="fx-toggle-btn" @click="fx.toggle(); if (!fx.fxActive.value && sheet.price === '') sheet.price = zeroText()">
            <span class="material-icons fx-toggle-icon">currency_exchange</span>
            {{ fx.fxActive.value ? 'Cancel conversion' : 'Convert from ' + fx.fxCurrency.value }}
          </button>
          <div v-if="fx.fxActive.value" class="fx-convert-body">
            <div class="fx-input-row">
              <input class="fx-foreign-input" type="text" inputmode="decimal" v-model="fx.fxForeignAmount.value"
                     @input="fx.fxForeignAmount.value = sanitizeAmountText(fx.fxForeignAmount.value); fx.updateConverted()"
                     :placeholder="'Price in ' + fx.fxCurrency.value" />
              <button type="button" class="gl-sign-btn" aria-label="Make it a discount or refund (negative)" title="Negative amount: discount or refund" @click="fx.fxForeignAmount.value = flipSign(fx.fxForeignAmount.value); fx.updateConverted()">+/−</button>
              <span class="fx-currency-label">{{ fx.fxCurrency.value }}</span>
            </div>
            <div v-if="fx.fxLoading.value" class="fx-rate-info">Fetching rate...</div>
            <div v-else-if="fx.fxError.value" class="fx-rate-info fx-rate-error">{{ fx.fxError.value }} — enter the price in {{ baseCurrency }} directly.</div>
            <div v-else-if="fx.fxRate.value" class="fx-rate-info">1 {{ fx.fxCurrency.value }} = {{ fx.fxRate.value.toFixed(4) }} {{ baseCurrency }} <span class="fx-rate-date">({{ fx.fxRateDate.value }})</span></div>
            <div v-if="fx.fxIsFuture.value && fx.fxRate.value && !fx.fxLoading.value" class="fx-rate-info fx-future-hint">
              Using today's rate.
            </div>
          </div>
        </div>
        <div class="modal-body" @click="openDropdown = null">
          <div class="sheet-section-title">Details</div>
          <div class="sheet-list-item">
            <label>Quantity</label>
            <input v-model="sheet.quantity" @input="sheet.quantity = sanitizeQuantityText(sheet.quantity)" type="text" inputmode="decimal" autocomplete="off" maxlength="9"
                   placeholder="e.g. 12 or 500" aria-label="Quantity" />
          </div>
          <div class="sheet-list-item">
            <label>Store</label>
            <valu-dropdown :open="openDropdown === 'store'" @update:open="(v) => openDropdown = v ? 'store' : null">
              <template #label>{{ storeLabel(sheet.storeId) }}</template>
              <div v-for="s in sheetStoreOptions" :key="s.id" class="valu-dropdown-option" :class="{ selected: sheet.storeId === s.id }" @click="onStorePicked(s.id)">{{ s.name }}<small v-if="s.city" style="color:var(--color-text-hint);"> · {{ s.city }}</small></div>
              <div class="valu-dropdown-option" :class="{ selected: !sheet.storeId }" @click="onStorePicked('')">Anywhere</div>
            </valu-dropdown>
          </div>
          <div v-if="trackPrices" class="sheet-list-item">
            <label>Paid in</label>
            <valu-currency-picker v-model:open="currencyOpen" v-model:search="currencySearch">
              <template #label>{{ currencyLabel(sheet.payCurrency) }}</template>
              <div v-for="c in filteredCurrencies" :key="c.code" class="currency-picker-option" :class="{ selected: c.code === sheet.payCurrency }" @click="pickCurrency(c.code)">{{ c.code }} · {{ c.name }}</div>
              <div v-if="filteredCurrencies.length === 0" class="currency-picker-empty">No match</div>
            </valu-currency-picker>
          </div>
          <div class="sheet-list-item">
            <label>Bought on</label>
            <valu-date-field v-model="sheet.checkedDate" placeholder="Not bought yet" />
          </div>
          <div class="form-group" style="margin-top:16px;">
            <label class="form-label">Notes</label>
            <textarea class="form-input" v-model="sheet.notes" rows="2" placeholder="Brand, size, anything to remember"></textarea>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn-sheet-cta" @click="saveSheet" :disabled="!sheet.title.trim()">{{ sheet.isNew ? addLabel : 'Save changes' }}</button>
          <div class="modal-footer-row">
            <template v-if="!sheet.isNew">
              <button class="btn btn-text btn-danger" @click="remove">Delete</button>
              <button class="btn btn-text" @click="duplicate"><span class="material-icons" style="font-size:18px;vertical-align:middle;">{{ duplicateIcon }}</span> {{ duplicateLabel }}</button>
            </template>
            <button class="btn btn-text" @click="close">Cancel</button>
          </div>
        </div>
      </div>
    </div>
  `,
};
