/**
 * Stores page: the shops you buy at. Each store has its own list on the Groceries page, an optional
 * city (to tell two branches apart) and an optional currency (so prices typed there are converted
 * to the group's base currency). Adding and editing happens in the shared StoreSheet.
 *
 * Modelled on Nutri's Locations page: the list shows what matters per store (items to buy, items
 * bought, last purchase, spending this month), a switch shows or hides a store right in the list,
 * and the list can be searched, filtered (all / visible / hidden), sorted and selected.
 */

import SheetsApi, { TABS } from './sheetsApi.js';
import { storeToRow, rowToItem, itemToRow, formatCurrency, monthKey, localDateISO, roundMoney } from './groceryLogic.js';
import { formatDateLabel } from './dateLabels.js';
import StoreSheet from './StoreSheet.js';

const { ref, computed, watch, inject, onMounted } = Vue;

const SORTS = [
  { id: 'order', label: 'My order' },
  { id: 'name', label: 'Name A-Z' },
  { id: 'city', label: 'City' },
  { id: 'recent', label: 'Last bought' },
  { id: 'bought', label: 'Most bought' },
];

export default {
  components: { StoreSheet },
  props: ['sheetId', 'settings', 'stores', 'changeTick'],
  emits: ['go-home', 'navigate', 'stores-updated'],

  setup(props, { emit }) {
    const showAlert = inject('showAlert', (m) => window.alert(m));
    const showConfirm = inject('showConfirm', (m) => Promise.resolve(window.confirm(m)));

    const list = ref([]);
    watch(() => props.stores, (v) => { list.value = (v || []).map((s) => ({ ...s })); }, { immediate: true });

    const baseCurrency = computed(() => props.settings?.baseCurrency || 'USD');
    const trackPrices = computed(() => (props.settings?.trackPrices ?? 'true') !== 'false');
    const fmt = (n) => formatCurrency(n, baseCurrency.value);

    // ── Per-store figures (from the Items tab) ──────────────────────────
    const items = ref([]);
    async function loadItems() {
      const sid = props.sheetId;
      if (!sid) return;
      try {
        const rows = await SheetsApi.getTabData(sid, TABS.ITEMS);
        if (sid !== props.sheetId) return;
        items.value = rows.map(rowToItem).filter((i) => i.id && i.title.trim());
      } catch { /* the list works without the figures */ }
    }
    onMounted(loadItems);
    watch(() => props.changeTick, loadItems);

    const stats = computed(() => {
      const thisMonth = monthKey(localDateISO());
      const out = new Map();
      for (const i of items.value) {
        if (!i.storeId) continue;
        let s = out.get(i.storeId);
        if (!s) { s = { toBuy: 0, bought: 0, last: '', month: 0 }; out.set(i.storeId, s); }
        if (!i.checkedDate) { s.toBuy++; continue; }
        s.bought++;
        if (i.checkedDate > s.last) s.last = i.checkedDate;
        if (monthKey(i.checkedDate) === thisMonth) s.month += i.price || 0;
      }
      return out;
    });
    const statsOf = (id) => stats.value.get(id) || { toBuy: 0, bought: 0, last: '', month: 0 };

    // ── Search, filter, sort ─────────────────────────────────────────────
    const search = ref('');
    const visibility = ref('all'); // all | visible | hidden
    const sortBy = ref('order');
    const openDropdown = ref(null);

    const counts = computed(() => ({
      all: list.value.length,
      visible: list.value.filter((s) => !s.hidden).length,
      hidden: list.value.filter((s) => s.hidden).length,
    }));

    const filtersActive = computed(() => !!search.value.trim() || visibility.value !== 'all');
    // Order only matters between stores in the same city, so reordering works on those (even while
    // searching or filtering) and is offered as soon as some city has more than one store.
    const cityKey = (s) => String(s.city || '').trim().toLowerCase();
    const canReorder = computed(() => {
      if (sortBy.value !== 'order') return false;
      const seen = new Set();
      return list.value.some((s) => { const k = cityKey(s); if (seen.has(k)) return true; seen.add(k); return false; });
    });

    const shown = computed(() => {
      const q = search.value.trim().toLowerCase();
      let rows = list.value.filter((s) => {
        if (visibility.value === 'visible' && s.hidden) return false;
        if (visibility.value === 'hidden' && !s.hidden) return false;
        if (!q) return true;
        return [s.name, s.city, s.currency].some((v) => String(v || '').toLowerCase().includes(q));
      });
      const byOrder = (a, b) => a.order - b.order || a.name.localeCompare(b.name);
      const cmp = {
        order: byOrder,
        name: (a, b) => a.name.localeCompare(b.name),
        city: (a, b) => (a.city ? 0 : 1) - (b.city ? 0 : 1) || a.city.localeCompare(b.city) || a.name.localeCompare(b.name),
        recent: (a, b) => (statsOf(b.id).last || '').localeCompare(statsOf(a.id).last || '') || byOrder(a, b),
        bought: (a, b) => statsOf(b.id).bought - statsOf(a.id).bought || byOrder(a, b),
      }[sortBy.value] || byOrder;
      rows = [...rows].sort(cmp);
      return rows;
    });

    // ── Selection (always on, like Nutri) ────────────────────────────────
    const selectedIds = ref([]);
    const hasSelection = computed(() => selectedIds.value.length > 0);
    watch(shown, (rows) => {
      const ids = new Set(rows.map((s) => s.id));
      const kept = selectedIds.value.filter((id) => ids.has(id));
      if (kept.length !== selectedIds.value.length) selectedIds.value = kept;
    });
    const allSelected = computed(() => shown.value.length > 0 && shown.value.every((s) => selectedIds.value.includes(s.id)));
    const someSelected = computed(() => selectedIds.value.length > 0 && !allSelected.value);
    function toggleSelect(id) {
      selectedIds.value = selectedIds.value.includes(id) ? selectedIds.value.filter((x) => x !== id) : [...selectedIds.value, id];
    }
    function selectAll() { selectedIds.value = allSelected.value ? [] : shown.value.map((s) => s.id); }
    function clearSelection() { selectedIds.value = []; }
    const selectedStores = computed(() => list.value.filter((s) => selectedIds.value.includes(s.id)));
    const anySelectedHidden = computed(() => selectedStores.value.some((s) => s.hidden));
    const anySelectedVisible = computed(() => selectedStores.value.some((s) => !s.hidden));

    // ── Editing ──────────────────────────────────────────────────────────
    const reorderMode = ref(false);
    watch(canReorder, (ok) => { if (!ok) reorderMode.value = false; });

    const sheetOpen = ref(false);
    const editing = ref(null);
    function openNew() { editing.value = null; sheetOpen.value = true; }
    function openEdit(s) { editing.value = s; sheetOpen.value = true; }
    function onRowClick(s) { if (!reorderMode.value) openEdit(s); }

    function publish() { emit('stores-updated', list.value.map((s) => ({ ...s }))); }

    function onSaved({ store, isNew }) {
      if (isNew) list.value.push(store);
      else {
        const cur = list.value.find((s) => s.id === store.id);
        if (cur) Object.assign(cur, store);
      }
      publish();
      sheetOpen.value = false;
    }
    function onDeleted(id) {
      list.value = list.value.filter((s) => s.id !== id);
      selectedIds.value = selectedIds.value.filter((x) => x !== id);
      publish();
      sheetOpen.value = false;
      loadItems();
    }

    /** Show or hide stores right from the list. Optimistic, rolled back when saving fails. */
    async function setHidden(ids, hidden) {
      const targets = list.value.filter((s) => ids.includes(s.id) && !!s.hidden !== hidden);
      if (targets.length === 0) return;
      targets.forEach((s) => { s.hidden = hidden; });
      publish();
      try {
        await SheetsApi.batchUpdateRows(props.sheetId, TABS.STORES, targets.map((s) => ({ id: s.id, values: storeToRow(s) })));
      } catch {
        targets.forEach((s) => { s.hidden = !hidden; });
        publish();
        showAlert('Could not save the change. Check your connection and try again.');
      }
    }
    const toggleOne = (s) => setHidden([s.id], !s.hidden);
    function setSelectedHidden(hidden) { setHidden(selectedIds.value.slice(), hidden); clearSelection(); }

    async function deleteSelected() {
      const targets = selectedStores.value.slice();
      if (targets.length === 0) return;
      const what = targets.length === 1 ? '"' + targets[0].name + '"' : targets.length + ' stores';
      if (!(await showConfirm('Delete ' + what + '? Their items stay in your history and move to "Anywhere".'))) return;
      const ids = targets.map((s) => s.id);
      try {
        // Re-home the items first, so nothing is left pointing at a store that no longer exists.
        const rows = await SheetsApi.getTabData(props.sheetId, TABS.ITEMS);
        const moved = rows.map(rowToItem).filter((i) => i.id && ids.includes(i.storeId));
        moved.forEach((i) => { i.storeId = ''; });
        if (moved.length) {
          await SheetsApi.batchUpdateRows(props.sheetId, TABS.ITEMS, moved.map((i) => ({ id: i.id, values: itemToRow(i) })));
        }
        await SheetsApi.deleteRows(props.sheetId, TABS.STORES, ids);
        list.value = list.value.filter((s) => !ids.includes(s.id));
        clearSelection();
        publish();
        loadItems();
      } catch {
        showAlert('Could not delete the stores. Check your connection and try again.');
      }
    }

    /** The list as shown. While reordering, stores are grouped by city (a heading above each group). */
    const rows = computed(() => {
      if (!reorderMode.value) return shown.value.map((s) => ({ key: s.id, s }));
      const groups = new Map();
      for (const s of shown.value) {
        const k = cityKey(s);
        if (!groups.has(k)) groups.set(k, { label: s.city.trim() || 'No city', stores: [] });
        groups.get(k).stores.push(s);
      }
      const out = [];
      for (const g of groups.values()) {
        out.push({ key: 'h:' + g.label, head: g.label, count: g.stores.length });
        g.stores.forEach((s, i) => out.push({ key: s.id, s, first: i === 0, last: i === g.stores.length - 1 }));
      }
      return out;
    });

    /** Swap a store with its neighbour in the same city. Every other store keeps its place. */
    async function move(s, dir) {
      const group = shown.value.filter((x) => cityKey(x) === cityKey(s));
      const other = group[group.findIndex((x) => x.id === s.id) + dir];
      if (!other) return;
      const changed = new Map();
      // Number everything 0..n-1 first, so equal or gappy order values cannot make a swap do nothing.
      [...list.value].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name)).forEach((x, i) => {
        if (x.order !== i) { x.order = i; changed.set(x.id, x); }
      });
      const tmp = s.order; s.order = other.order; other.order = tmp;
      changed.set(s.id, s); changed.set(other.id, other);
      publish();
      try {
        await SheetsApi.batchUpdateRows(props.sheetId, TABS.STORES, [...changed.values()].map((x) => ({ id: x.id, values: storeToRow(x) })));
      } catch {
        showAlert('Could not save the new order. Check your connection and try again.');
      }
    }

    function clearFilters() { search.value = ''; visibility.value = 'all'; }

    return {
      list, shown, baseCurrency, trackPrices, fmt, sheetOpen, editing, openNew, openEdit, onRowClick, onSaved, onDeleted,
      search, visibility, sortBy, SORTS, openDropdown, counts, filtersActive, clearFilters,
      statsOf, formatDateLabel, loadItems,
      reorderMode, canReorder, move, rows,
      selectedIds, hasSelection, allSelected, someSelected, toggleSelect, selectAll, clearSelection,
      anySelectedHidden, anySelectedVisible, toggleOne, setSelectedHidden, deleteSelected,
      sortLabel: computed(() => SORTS.find((s) => s.id === sortBy.value)?.label || ''),
    };
  },

  template: `
    <div class="subpage">
      <div class="subpage-scroll">
      <div class="subpage-nav">
        <button class="subpage-back subpage-back--colored" @click="$emit('go-home')">
          <span class="material-icons">arrow_back</span>
        </button>
        <h1 class="subpage-nav-title">Stores</h1>
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

      <div v-if="list.length === 0" class="empty-state" style="padding-top:40px;">
        <span class="material-icons">storefront</span>
        <h3>No stores yet</h3>
        <p>Add the shops you buy at to keep a separate list for each. You can also use one list for everything.</p>
      </div>

      <template v-else>
        <div class="subpage-filter-bar" @click="openDropdown = null">
          <div class="subpage-filter-search" :class="{ expanded: search }">
            <span class="material-icons subpage-filter-search-icon">search</span>
            <input class="subpage-filter-search-input" v-model="search" placeholder="Name or city..." aria-label="Search stores" />
            <button v-if="search" class="subpage-filter-search-clear" aria-label="Clear search" @click="search = ''">
              <span class="material-icons">close</span>
            </button>
          </div>
          <div style="position:relative;" @click.stop>
            <button class="subpage-filter-btn" :class="{ active: sortBy !== 'order' }" @click="openDropdown = openDropdown === 'sort' ? null : 'sort'">
              <span class="material-icons" style="font-size:16px;">sort</span>
              <span>{{ sortLabel }}</span>
            </button>
            <div class="subpage-filter-dropdown" v-if="openDropdown === 'sort'">
              <div v-for="o in SORTS" :key="o.id" class="subpage-filter-option" :class="{ selected: sortBy === o.id }" @click="sortBy = o.id; openDropdown = null">{{ o.label }}</div>
            </div>
          </div>
        </div>

        <div class="gl-store-tabs gl-store-filter" role="tablist">
          <button class="gl-store-tab" :class="{ active: visibility === 'all' }" role="tab" :aria-selected="visibility === 'all'" @click="visibility = 'all'">All<span class="gl-store-tab-count">{{ counts.all }}</span></button>
          <button class="gl-store-tab" :class="{ active: visibility === 'visible' }" role="tab" :aria-selected="visibility === 'visible'" @click="visibility = 'visible'">Visible<span class="gl-store-tab-count">{{ counts.visible }}</span></button>
          <button class="gl-store-tab" :class="{ active: visibility === 'hidden' }" role="tab" :aria-selected="visibility === 'hidden'" @click="visibility = 'hidden'">Hidden<span class="gl-store-tab-count">{{ counts.hidden }}</span></button>
        </div>

        <div class="gl-summary">
          <div class="gl-summary-main">
            <button v-if="shown.length > 0" type="button" class="gl-check gl-check--square gl-summary-check"
                    :class="{ checked: allSelected, partial: someSelected }" :disabled="reorderMode"
                    role="checkbox" :aria-checked="allSelected ? 'true' : (someSelected ? 'mixed' : 'false')"
                    :aria-label="allSelected ? 'Deselect all' : 'Select all'" @click="selectAll">
              <span class="gl-check-circle"><span class="material-icons">{{ someSelected ? 'remove' : 'check' }}</span></span>
            </button>
            <div>{{ shown.length }} {{ shown.length === 1 ? 'store' : 'stores' }}<template v-if="filtersActive && shown.length !== list.length"> of {{ list.length }}</template></div>
          </div>
          <div class="gl-summary-actions">
            <button class="gl-icon-btn" :class="{ active: reorderMode }" :disabled="!canReorder" aria-label="Reorder stores"
                    :title="canReorder ? 'Reorder stores within a city' : (sortBy !== 'order' ? 'Sort by My order to reorder' : 'Reordering needs two stores in the same city')" @click="reorderMode = !reorderMode"><span class="material-icons">swap_vert</span></button>
            <button class="gl-icon-btn" aria-label="Refresh" @click="loadItems"><span class="material-icons">refresh</span></button>
          </div>
        </div>

        <div v-if="shown.length === 0" class="empty-state" style="padding-top:24px;">
          <span class="material-icons">filter_list</span>
          <h3>No stores match</h3>
          <p>Try another name or city, or clear the filters.</p>
          <button class="btn-link" @click="clearFilters">Clear filters</button>
        </div>

        <div v-else class="valu-list gl-store-list">
          <p v-if="reorderMode" class="gl-store-reorder-hint">Move stores up or down within their city. The order is the order of the tabs on the Groceries page.</p>
          <template v-for="r in rows" :key="r.key">
          <div v-if="r.head" class="gl-store-city-head">{{ r.head }}<span>{{ r.count }}</span></div>
          <div v-for="s in (r.s ? [r.s] : [])" :key="s.id" class="valu-list-card gl-store-row" :class="{ 'gl-store-row--hidden': s.hidden, 'gl-store-row--selected': selectedIds.includes(s.id) }"
               @click="onRowClick(s)">
            <div v-if="reorderMode" class="account-reorder-arrows" @click.stop>
              <button class="account-reorder-btn" :disabled="r.first" aria-label="Move up" @click="move(s, -1)"><span class="material-icons">keyboard_arrow_up</span></button>
              <button class="account-reorder-btn" :disabled="r.last" aria-label="Move down" @click="move(s, 1)"><span class="material-icons">keyboard_arrow_down</span></button>
            </div>
            <button v-else type="button" class="gl-check gl-check--square" :class="{ checked: selectedIds.includes(s.id) }"
                    role="checkbox" :aria-checked="selectedIds.includes(s.id)" :aria-label="'Select ' + s.name"
                    @click.stop="toggleSelect(s.id)">
              <span class="gl-check-circle"><span class="material-icons">check</span></span>
            </button>
            <div class="gl-store-row-body">
              <div class="gl-store-row-top">
                <span class="valu-list-name truncate">{{ s.name }}</span>
                <span v-if="s.currency" class="gl-pill">{{ s.currency }}</span>
              </div>
              <div v-if="s.city" class="valu-list-sub">{{ s.city }}</div>
              <div class="gl-store-stats">
                <template v-if="statsOf(s.id).toBuy || statsOf(s.id).bought">
                  <span :class="{ 'gl-store-stat--hot': statsOf(s.id).toBuy > 0 }"><span class="material-icons">shopping_cart</span>{{ statsOf(s.id).toBuy }} to buy</span>
                  <span><span class="material-icons">done_all</span>{{ statsOf(s.id).bought }} bought</span>
                  <span v-if="statsOf(s.id).last"><span class="material-icons">event</span>{{ formatDateLabel(statsOf(s.id).last) }}</span>
                  <span v-if="trackPrices && statsOf(s.id).month !== 0"><span class="material-icons">payments</span>{{ fmt(statsOf(s.id).month) }} this month</span>
                </template>
                <span v-else>No items yet</span>
              </div>
              <div v-if="s.hidden && statsOf(s.id).toBuy > 0" class="gl-store-warn">Hidden: its items are not shown on the Groceries page.</div>
            </div>
            <label v-if="!reorderMode" class="toggle gl-store-toggle" @click.stop :title="s.hidden ? 'Hidden. Tap to show' : 'Shown. Tap to hide'">
              <input type="checkbox" :checked="!s.hidden" :aria-label="(s.hidden ? 'Show ' : 'Hide ') + s.name" @change="toggleOne(s)" />
              <div class="toggle-track"></div>
              <div class="toggle-thumb"></div>
            </label>
          </div>
          </template>
        </div>
        <div style="height:96px;flex-shrink:0;"></div>
      </template>

      <div v-if="hasSelection" class="gl-select-bar gl-select-bar--stack gl-store-select-bar">
        <div class="gl-select-top">
          <span class="gl-select-count">{{ selectedIds.length }} selected</span>
          <button class="gl-icon-btn" aria-label="Clear selection" @click="clearSelection"><span class="material-icons">close</span></button>
        </div>
        <div class="gl-select-actions">
          <button v-if="anySelectedHidden" class="gl-act" @click="setSelectedHidden(false)"><span class="material-icons">visibility</span>Show</button>
          <button v-if="anySelectedVisible" class="gl-act" @click="setSelectedHidden(true)"><span class="material-icons">visibility_off</span>Hide</button>
          <button class="gl-act gl-act--danger" @click="deleteSelected"><span class="material-icons">delete</span>Delete</button>
        </div>
      </div>
      <div v-else class="subpage-bottom-fixed">
        <button class="btn-add-outline" @click="openNew">ADD STORE</button>
      </div>
      </div>

      <store-sheet :open="sheetOpen" :store="editing" :stores="list" :sheet-id="sheetId" :base-currency="baseCurrency"
                   @close="sheetOpen = false" @saved="onSaved" @deleted="onDeleted"></store-sheet>
    </div>
  `,
};
