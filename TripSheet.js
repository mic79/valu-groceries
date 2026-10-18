/**
 * "Add from a previous trip": pick a whole shopping day, several days, or single items from what
 * you bought before and put them on the list again. Quantity and notes come along; the old price
 * only comes along (as an estimate) when the item stays in the same store, because another store
 * may charge in another currency. Items already on the list are marked and cannot be picked twice.
 */

import { buildTrips, copyForList, listKey, onListKeys, formatCurrency } from './groceryLogic.js';
import { formatDayHeading } from './dateLabels.js';
import { STORAGE_PREFIX } from './config.js';

const { ref, reactive, computed, watch } = Vue;

const LS_KEEP = STORAGE_PREFIX + 'trip_keep_price';
const PAGE = 25;

export default {
  props: ['open', 'items', 'stores', 'currentStoreId', 'trackPrices', 'baseCurrency'],
  emits: ['close', 'add'],

  setup(props, { emit }) {
    const search = ref('');
    const scope = ref('*');
    const selected = ref(new Set());
    const expanded = reactive({});
    const shown = ref(PAGE);
    const everythingHere = ref(false);
    const keepPrice = ref((() => { try { return localStorage.getItem(LS_KEEP) !== 'no'; } catch { return true; } })());

    const storeName = (id) => (props.stores || []).find((s) => s.id === id)?.name || '';
    const knownStore = (id) => !!id && (props.stores || []).some((s) => s.id === id);
    const currentName = computed(() => storeName(props.currentStoreId));

    watch(() => props.open, (o) => {
      if (!o) return;
      search.value = '';
      scope.value = props.currentStoreId && knownStore(props.currentStoreId) ? props.currentStoreId : '*';
      selected.value = new Set();
      Object.keys(expanded).forEach((k) => delete expanded[k]);
      shown.value = PAGE;
      everythingHere.value = false;
    });
    watch([search, scope], () => { shown.value = PAGE; });
    watch(keepPrice, (v) => { try { localStorage.setItem(LS_KEEP, v ? 'yes' : 'no'); } catch { /* private mode */ } });

    /** Stores that have history, for the filter chips. */
    const scopes = computed(() => {
      const ids = new Set((props.items || []).filter((i) => i.checkedDate).map((i) => i.storeId || ''));
      const list = (props.stores || []).filter((s) => ids.has(s.id)).map((s) => ({ id: s.id, name: s.name }));
      if (ids.has('')) list.push({ id: '', name: 'Anywhere' });
      return list;
    });

    const allTrips = computed(() => (props.open ? buildTrips(props.items || [], { storeId: scope.value, query: search.value }) : []));
    const trips = computed(() => allTrips.value.slice(0, shown.value));
    const isOpen = (t, idx) => expanded[t.key] ?? (idx === 0 || !!search.value.trim());

    const onList = computed(() => onListKeys(props.items || []));
    const destFor = (i) => (everythingHere.value && props.currentStoreId ? props.currentStoreId : (knownStore(i.storeId) ? i.storeId : ''));
    const isOnList = (i) => onList.value.has(listKey({ title: i.title, storeId: destFor(i) }));

    function toggleItem(i) {
      if (isOnList(i)) return;
      const s = new Set(selected.value);
      if (s.has(i.id)) s.delete(i.id); else s.add(i.id);
      selected.value = s;
    }
    const pickable = (t) => t.items.filter((i) => !isOnList(i));
    const tripState = (t) => {
      const p = pickable(t);
      if (!p.length) return 'none';
      const n = p.filter((i) => selected.value.has(i.id)).length;
      return n === 0 ? 'off' : n === p.length ? 'all' : 'some';
    };
    function toggleTrip(t) {
      const p = pickable(t);
      const s = new Set(selected.value);
      if (tripState(t) === 'all') p.forEach((i) => s.delete(i.id)); else p.forEach((i) => s.add(i.id));
      selected.value = s;
    }

    const chosen = computed(() => (props.items || []).filter((i) => selected.value.has(i.id) && !isOnList(i)));
    const mixedStores = computed(() => !!props.currentStoreId && chosen.value.some((i) => (i.storeId || '') !== props.currentStoreId));

    function add() {
      const specs = chosen.value.map((i) => copyForList(i, { storeId: destFor(i), keepPrice: keepPrice.value && props.trackPrices }));
      if (!specs.length) return;
      emit('add', specs);
    }

    const priceText = (i) => {
      if (!props.trackPrices) return '';
      return formatCurrency(typeof i.price === 'number' ? i.price : 0, props.baseCurrency);
    };
    const fmt = (n) => formatCurrency(n, props.baseCurrency);

    return {
      search, scope, scopes, trips, allTrips, shown, PAGE, isOpen, expanded, selected, toggleItem, tripState, toggleTrip,
      chosen, add, keepPrice, everythingHere, mixedStores, currentName, storeName, priceText, fmt, isOnList,
      formatDayHeading,
    };
  },

  template: `
    <div class="modal-overlay" :class="{ open }" @click.self="$emit('close')">
      <div class="modal">
        <div class="sheet-handle"></div>
        <div class="modal-header">
          <h2>Add from a previous trip</h2>
          <button class="btn-icon" @click="$emit('close')"><span class="material-icons">close</span></button>
        </div>

        <div class="gl-trip-filters">
          <div class="gl-trip-search">
            <span class="material-icons">search</span>
            <input v-model="search" placeholder="Search what you bought..." autocomplete="off" />
            <button v-if="search" class="gl-trip-search-clear" @click="search = ''" aria-label="Clear"><span class="material-icons">close</span></button>
          </div>
          <div v-if="scopes.length > 1" class="gl-trip-chips">
            <button class="gl-filter-chip" :class="{ active: scope === '*' }" @click="scope = '*'">All stores</button>
            <button v-for="s in scopes" :key="s.id || '__none'" class="gl-filter-chip" :class="{ active: scope === s.id }" @click="scope = s.id">{{ s.name }}</button>
          </div>
        </div>

        <div class="modal-body" style="padding:0 16px 8px;">
          <div v-if="allTrips.length === 0" class="empty-state" style="padding:28px 8px;">
            <span class="material-icons">history</span>
            <h3>{{ search ? 'No match' : 'No trips yet' }}</h3>
            <p>{{ search ? 'Try another word or store.' : 'Items you mark as bought will show up here, so you can reuse them.' }}</p>
          </div>

          <div v-for="(t, idx) in trips" :key="t.key" class="gl-trip">
            <div class="gl-trip-head">
              <button type="button" class="gl-check gl-check--square" :class="{ checked: tripState(t) === 'all', partial: tripState(t) === 'some' }"
                      :disabled="tripState(t) === 'none'" :aria-label="'Select all from ' + formatDayHeading(t.date)" @click="toggleTrip(t)">
                <span class="gl-check-circle"><span class="material-icons">{{ tripState(t) === 'some' ? 'remove' : 'check' }}</span></span>
              </button>
              <button type="button" class="gl-trip-title" @click="expanded[t.key] = !isOpen(t, idx)">
                <span class="gl-trip-date">{{ formatDayHeading(t.date) }}</span>
                <span class="gl-trip-meta">{{ storeName(t.storeId) || 'Anywhere' }} · {{ t.items.length }} {{ t.items.length === 1 ? 'item' : 'items' }}<template v-if="trackPrices && t.total !== 0"> · {{ fmt(t.total) }}</template></span>
              </button>
              <button type="button" class="gl-trip-chevron" :class="{ open: isOpen(t, idx) }" @click="expanded[t.key] = !isOpen(t, idx)" aria-label="Show items">
                <span class="material-icons">expand_more</span>
              </button>
            </div>
            <div v-if="isOpen(t, idx)" class="gl-trip-items">
              <div v-for="i in t.items" :key="i.id" class="gl-trip-row" :class="{ 'gl-trip-row--on': isOnList(i) }" @click="toggleItem(i)">
                <button type="button" class="gl-check gl-check--square" :class="{ checked: selected.has(i.id) }" :disabled="isOnList(i)" :aria-label="'Select ' + i.title">
                  <span class="gl-check-circle"><span class="material-icons">check</span></span>
                </button>
                <span class="gl-trip-name">{{ i.title }}</span>
                <span v-if="i.quantity" class="gl-item-qty">{{ i.quantity }}</span>
                <span v-if="isOnList(i)" class="gl-pill gl-pill--muted">on list</span>
                <span v-else-if="priceText(i)" class="gl-trip-price">{{ priceText(i) }}</span>
              </div>
            </div>
          </div>

          <button v-if="allTrips.length > shown" class="btn-link" style="display:block;margin:10px auto;" @click="shown += PAGE">Show older trips</button>
        </div>

        <div class="modal-footer">
          <div v-if="mixedStores" class="gl-trip-opt">
            <button type="button" class="gl-check gl-check--square" :class="{ checked: everythingHere }" @click="everythingHere = !everythingHere" aria-label="Put everything on this store">
              <span class="gl-check-circle"><span class="material-icons">check</span></span>
            </button>
            <span @click="everythingHere = !everythingHere">Put everything on {{ currentName }}</span>
          </div>
          <div v-if="trackPrices" class="gl-trip-opt">
            <button type="button" class="gl-check gl-check--square" :class="{ checked: keepPrice }" @click="keepPrice = !keepPrice" aria-label="Keep the old prices as estimates">
              <span class="gl-check-circle"><span class="material-icons">check</span></span>
            </button>
            <span @click="keepPrice = !keepPrice">Keep old prices as estimates <small>(same store only)</small></span>
          </div>
          <button class="btn-sheet-cta" :disabled="chosen.length === 0" @click="add">
            {{ chosen.length === 0 ? 'Select items to add' : 'Add ' + chosen.length + (chosen.length === 1 ? ' item' : ' items') + ' to the list' }}
          </button>
        </div>
      </div>
    </div>
  `,
};
