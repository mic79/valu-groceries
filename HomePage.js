/**
 * Home (dashboard): a glance at the shopping list, spending per month (last 12 months), a projection
 * for the current month, the split per store, and the items you buy most often. Works from the Items
 * tab only. The shopping list itself lives on the Groceries page (first tab in the bottom bar).
 */

import SheetsApi, { TABS } from './sheetsApi.js';
import {
  formatCurrency, rowToItem, spendingByMonth, storeBreakdown, topItems, estimateCurrentMonth, monthKey,
  localDateISO, roundMoney,
} from './groceryLogic.js';
import { formatMonthLabel, formatMonthShort } from './dateLabels.js';
import { loadLayout } from './homeLayout.js';
import { rowToNutrition, nutritionLookup, nutritionStats, missingStaples } from './nutritionLogic.js';

const { ref, computed, watch, onMounted } = Vue;

function lastMonths(count, now = new Date()) {
  const out = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

export default {
  props: ['sheetId', 'settings', 'stores', 'changeTick'],
  emits: ['navigate'],

  setup(props) {
    const items = ref([]);
    const nutriEntries = ref([]);
    // The layout is chosen in Settings (kept on this device) and read each time Home opens.
    const widgetOrder = computed(() => loadLayout().filter((w) => w.enabled));
    const loading = ref(true);
    const loadError = ref('');
    const selectedMonth = ref(monthKey(localDateISO()));

    const baseCurrency = computed(() => props.settings?.baseCurrency || 'USD');
    const trackPrices = computed(() => (props.settings?.trackPrices ?? 'true') !== 'false');
    const fmt = (n) => formatCurrency(n, baseCurrency.value);

    const monthly = computed(() => spendingByMonth(items.value));
    const bars = computed(() => {
      const byKey = new Map(monthly.value.map((m) => [m.month, m]));
      const keys = lastMonths(12);
      const currentKey = monthKey(localDateISO());
      const currentEstimate = estimateCurrentMonth(monthly.value);
      const topOf = (k) => {
        const total = byKey.get(k)?.total || 0;
        return k === currentKey && currentEstimate !== null ? Math.max(total, currentEstimate) : total;
      };
      const max = Math.max(1, ...keys.map(topOf));
      return keys.map((k) => {
        const total = byKey.get(k)?.total || 0;
        const top = topOf(k);
        const est = k === currentKey && currentEstimate !== null && currentEstimate > total ? currentEstimate : null;
        return {
          key: k, label: formatMonthShort(k), total, estimate: est,
          height: Math.max(2, Math.round((top / max) * 100)),
          // Share of the bar that is already spent (the rest is the estimate for the remaining days).
          spentPct: est !== null && top > 0 ? Math.max(2, Math.round((total / top) * 100)) : 100,
        };
      });
    });

    const monthTotal = computed(() => monthly.value.find((m) => m.month === selectedMonth.value)?.total || 0);
    const isCurrentMonth = computed(() => selectedMonth.value === monthKey(localDateISO()));
    const estimate = computed(() => (isCurrentMonth.value ? estimateCurrentMonth(monthly.value) : null));

    const monthPurchases = computed(() => items.value.filter((i) => i.checkedDate && monthKey(i.checkedDate) === selectedMonth.value));
    const trips = computed(() => new Set(monthPurchases.value.map((i) => i.checkedDate)).size);
    const perTrip = computed(() => (trips.value ? roundMoney(monthTotal.value / trips.value) : 0));

    const breakdown = computed(() => {
      const rows = storeBreakdown(items.value, props.stores || [], selectedMonth.value);
      const max = Math.max(1, ...rows.map((r) => r.total));
      return rows.map((r) => ({ ...r, pct: Math.max(3, Math.round((r.total / max) * 100)) }));
    });

    const top = computed(() => {
      const rows = topItems(items.value, 8);
      const max = Math.max(1, ...rows.map((r) => r.count));
      return rows.map((r) => ({ ...r, pct: Math.max(3, Math.round((r.count / max) * 100)) }));
    });

    const hasPurchases = computed(() => items.value.some((i) => i.checkedDate));

    // Nutrition glance for the selected month. The built-in table is applied in memory only: nothing is written from Home.
    const nutri = computed(() => {
      const own = nutritionLookup(nutriEntries.value);
      const titles = monthPurchases.value.map((i) => i.title);
      const lookup = nutritionLookup([...nutriEntries.value, ...missingStaples(titles, own)]);
      const [y, m] = selectedMonth.value.split('-').map(Number);
      const last = new Date(y, m, 0).getDate();
      const range = { from: selectedMonth.value + '-01', to: selectedMonth.value + '-' + String(last).padStart(2, '0') };
      const s = nutritionStats(items.value, lookup, range);
      return {
        counted: s.counted, kcalPerDay: Math.round(s.perDay).toLocaleString(), coverage: Math.round(s.coverage * 100),
        macros: [
          { id: 'p', label: 'Protein', share: Math.round(s.share.protein * 100) },
          { id: 'c', label: 'Carbs', share: Math.round(s.share.carbs * 100) },
          { id: 'f', label: 'Fat', share: Math.round(s.share.fat * 100) },
        ],
      };
    });

    // Shopping list glance (everything still to buy, across all stores).
    const toBuy = computed(() => items.value.filter((i) => !i.checkedDate));
    const toBuyTotal = computed(() => roundMoney(toBuy.value.reduce((s, i) => s + (i.price || 0), 0)));
    const toBuyStores = computed(() => {
      const names = new Map((props.stores || []).map((s) => [s.id, s.name]));
      const counts = new Map();
      for (const i of toBuy.value) {
        const name = i.storeId && names.has(i.storeId) ? names.get(i.storeId) : 'Anywhere';
        counts.set(name, (counts.get(name) || 0) + 1);
      }
      return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([name, count]) => ({ name, count }));
    });

    async function load(silent = false) {
      const sid = props.sheetId;
      if (!sid) return;
      if (!silent) { loading.value = true; loadError.value = ''; }
      try {
        const [rows, nutriRows] = await Promise.all([
          SheetsApi.getTabData(sid, TABS.ITEMS),
          SheetsApi.getTabData(sid, TABS.NUTRITION).catch(() => []),
        ]);
        if (sid !== props.sheetId) return;
        items.value = rows.map(rowToItem).filter((i) => i.id && i.title.trim());
        nutriEntries.value = nutriRows.map(rowToNutrition).filter((e) => e.id);
      } catch {
        if (!silent) loadError.value = 'Could not load your insights. Check your connection and try again.';
      } finally {
        loading.value = false;
      }
    }

    watch(() => props.changeTick, () => load(true));
    onMounted(() => load());

    return {
      loading, loadError, load, trackPrices, fmt, bars, selectedMonth, monthTotal, estimate, isCurrentMonth,
      trips, perTrip, breakdown, top, hasPurchases, nutri, widgetOrder, formatMonthLabel, toBuy, toBuyTotal, toBuyStores,
      monthItemCount: computed(() => monthPurchases.value.length),
    };
  },

  template: `
    <div class="gl-home">
      <div v-if="loading" class="loading" style="padding-top:40px;"><div class="spinner"></div>Loading...</div>

      <div v-else-if="loadError" class="empty-state" style="padding-top:40px;">
        <span class="material-icons">cloud_off</span>
        <h3>Something went wrong</h3>
        <p>{{ loadError }}</p>
        <button class="btn-link" @click="load()">Try again</button>
      </div>

      <div v-else style="padding:8px 16px 32px;">
        <template v-for="w in widgetOrder" :key="w.id">

        <div v-if="w.id === 'list'" class="card mb-16 gl-home-list">
          <div class="gl-home-list-body">
            <span class="material-icons gl-home-list-icon">shopping_cart</span>
            <div class="gl-home-list-main">
              <div class="gl-home-list-title">
                <template v-if="toBuy.length > 0">{{ toBuy.length }} {{ toBuy.length === 1 ? 'item' : 'items' }} to buy<template v-if="trackPrices && toBuyTotal !== 0"> · {{ fmt(toBuyTotal) }}</template></template>
                <template v-else>Nothing to buy</template>
              </div>
              <div v-if="toBuyStores.length > 0" class="gl-home-list-stores">
                <span v-for="s in toBuyStores" :key="s.name">{{ s.name }} {{ s.count }}</span>
              </div>
              <div v-else class="gl-home-list-stores">Your shopping list is empty.</div>
            </div>
            <button class="btn btn-primary btn-sm" @click="$emit('navigate', 'groceries')">Open list</button>
          </div>
        </div>

        <template v-else-if="w.id === 'spending' && hasPurchases">
          <div v-if="!trackPrices" class="banner banner-info mb-16">
            <span class="material-icons">info</span>
            <div class="banner-content">Price tracking is off for this group, so spending is not shown. Turn it on in Groups to see totals per month and store.</div>
          </div>
          <template v-else>
            <div class="gl-total-hero">
              <div class="gl-total-hero-amount">{{ fmt(monthTotal) }}</div>
              <div class="gl-total-hero-label">Spent in {{ formatMonthLabel(selectedMonth) }}</div>
              <div v-if="estimate !== null" class="gl-total-hero-label">On track for about {{ fmt(estimate) }} this month</div>
            </div>

            <div class="card mb-16">
              <div class="card-header"><h3>Last 12 months</h3></div>
              <div class="card-body">
                <div class="gl-bars">
                  <button v-for="b in bars" :key="b.key" type="button" class="gl-bar-col" :class="{ active: b.key === selectedMonth }"
                          :aria-label="formatMonthLabel(b.key) + ': ' + fmt(b.total) + (b.estimate !== null ? ', estimated ' + fmt(b.estimate) : '')" @click="selectedMonth = b.key">
                    <span class="gl-bar" :class="{ 'gl-bar--est': b.estimate !== null }" :style="{ height: b.height + '%' }">
                      <span v-if="b.estimate !== null" class="gl-bar-spent" :style="{ height: b.spentPct + '%' }"></span>
                    </span>
                    <span class="gl-bar-label">{{ b.label }}</span>
                  </button>
                </div>
              </div>
            </div>
          </template>
        </template>

        <div v-else-if="w.id === 'stats' && hasPurchases" class="card mb-16">
          <div class="stats-row">
            <div class="stat"><div class="stat-value">{{ trips }}</div><div class="stat-label">Shopping days</div></div>
            <div class="stat"><div class="stat-value">{{ monthItemCount }}</div><div class="stat-label">Items bought</div></div>
            <div v-if="trackPrices" class="stat"><div class="stat-value">{{ fmt(perTrip) }}</div><div class="stat-label">Per day</div></div>
          </div>
        </div>

        <template v-else-if="w.id === 'nutrition' && hasPurchases">
          <button v-if="nutri.counted > 0" type="button" class="card mb-16 gl-home-nutri gl-home-nutri--stats" @click="$emit('navigate', 'nutrition')">
            <span class="gl-home-nutri-top">
              <span class="material-icons gl-home-nutri-icon">restaurant</span>
              <span class="gl-home-nutri-text"><strong>Nutrition · {{ formatMonthLabel(selectedMonth) }}</strong><small>{{ nutri.kcalPerDay }} kcal bought per day · based on {{ nutri.coverage }}% of purchases</small></span>
              <span class="material-icons">chevron_right</span>
            </span>
            <span class="gl-macro-bar" role="img" :aria-label="'Protein ' + nutri.macros[0].share + '%, carbs ' + nutri.macros[1].share + '%, fat ' + nutri.macros[2].share + '%'">
              <span v-for="m in nutri.macros" :key="m.id" class="gl-macro" :class="'gl-macro--' + m.id" :style="{ width: m.share + '%' }"></span>
            </span>
            <span class="gl-home-nutri-legend">
              <span v-for="m in nutri.macros" :key="m.id"><span class="gl-macro-dot" :class="'gl-macro--' + m.id"></span>{{ m.label }} {{ m.share }}%</span>
            </span>
          </button>
          <button v-else type="button" class="card mb-16 gl-home-nutri" @click="$emit('navigate', 'nutrition')">
            <span class="material-icons gl-home-nutri-icon">restaurant</span>
            <span class="gl-home-nutri-text"><strong>Nutrition</strong><small>Calories, protein, carbs and fat of what you buy</small></span>
            <span class="material-icons">chevron_right</span>
          </button>
        </template>

        <div v-else-if="w.id === 'byStore' && trackPrices && breakdown.length > 0" class="card mb-16">
          <div class="card-header"><h3>By store · {{ formatMonthLabel(selectedMonth) }}</h3></div>
          <div class="card-body">
            <div v-for="r in breakdown" :key="r.name" class="gl-hbar-row">
              <div class="gl-hbar-top"><span class="truncate">{{ r.name }}</span><span>{{ fmt(r.total) }}</span></div>
              <div class="gl-hbar-track"><div class="gl-hbar-fill" :style="{ width: r.pct + '%' }"></div></div>
            </div>
          </div>
        </div>

        <div v-else-if="w.id === 'topItems' && top.length > 0" class="card mb-16">
          <div class="card-header"><h3>Bought most often</h3></div>
          <div class="card-body">
            <div v-for="r in top" :key="r.title" class="gl-hbar-row">
              <div class="gl-hbar-top"><span class="truncate">{{ r.title }}</span><span>{{ r.count }}×</span></div>
              <div class="gl-hbar-track"><div class="gl-hbar-fill" :style="{ width: r.pct + '%' }"></div></div>
            </div>
          </div>
        </div>

        </template>

        <div v-if="!hasPurchases" class="empty-state" style="padding-top:24px;">
          <span class="material-icons">insights</span>
          <h3>Nothing to show yet</h3>
          <p>Once you mark items as bought, you will see how often you shop and what you buy most.</p>
        </div>

        <div v-if="widgetOrder.length === 0" class="empty-state" style="padding-top:24px;">
          <span class="material-icons">dashboard_customize</span>
          <h3>Everything is hidden</h3>
          <p>Choose what to show under Settings, Home layout.</p>
          <button class="btn-link" @click="$emit('navigate', 'settings')">Open Settings</button>
        </div>
      </div>
    </div>
  `,
};
