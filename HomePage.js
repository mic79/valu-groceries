/**
 * Home (dashboard): a glance at the shopping list, spending (months with stores nested under each one),
 * a projection for the current month, and the items you buy most often. Works from the Items tab only.
 * The shopping list itself lives on the Groceries page (first tab in the bottom bar).
 */

import SheetsApi, { TABS } from './sheetsApi.js';
import {
  formatCurrency, rowToItem, spendingByMonth, storeBreakdown, topItems, estimateCurrentMonth, monthKey,
  localDateISO, roundMoney, firstStoreWithPending, periodRange,
} from './groceryLogic.js';
import { formatMonthLabel, formatMonthShort } from './dateLabels.js';
import { loadLayout } from './homeLayout.js';
import { nutritionVisible } from './nutritionFlags.js';
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

  setup(props, { emit }) {
    const items = ref([]);
    const nutriEntries = ref([]);
    // The layout is chosen in Settings (kept on this device) and read each time Home opens.
    const showNutri = computed(() => nutritionVisible(props.settings));
    const widgetOrder = computed(() => loadLayout().filter((w) => w.enabled && (w.id !== 'nutrition' || showNutri.value)));
    const loading = ref(true);
    const loadError = ref('');
    const selectedMonth = ref(monthKey(localDateISO()));
    const expandedMonth = ref(null); // YYYY-MM whose store split is open under its bar (Nutri-style)
    const spendView = ref('12m'); // '12m' or a year 'YYYY'
    const topPeriod = ref('12m'); // 'month' | '12m' | 'all'

    const baseCurrency = computed(() => props.settings?.baseCurrency || 'USD');
    const trackPrices = computed(() => (props.settings?.trackPrices ?? 'true') !== 'false');
    const fmt = (n) => formatCurrency(n, baseCurrency.value);

    const monthly = computed(() => spendingByMonth(items.value));
    const spendYears = computed(() => [...new Set(items.value.map((i) => (i.checkedDate || '').slice(0, 4)).filter((y) => /^\d{4}$/.test(y)))].sort().reverse());
    const barKeys = computed(() => {
      if (/^\d{4}$/.test(spendView.value)) {
        const y = Number(spendView.value);
        const now = new Date();
        const last = y < now.getFullYear() ? 12 : y > now.getFullYear() ? 0 : now.getMonth() + 1;
        const keys = [];
        for (let i = 1; i <= last; i++) keys.push(y + '-' + String(i).padStart(2, '0'));
        return keys;
      }
      return lastMonths(12);
    });
    const bars = computed(() => {
      const byKey = new Map(monthly.value.map((m) => [m.month, m]));
      const keys = barKeys.value;
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
          width: Math.max(2, Math.round((top / max) * 100)),
          spentPct: est !== null && top > 0 ? Math.max(2, Math.round((total / top) * 100)) : 100,
        };
      });
    });
    const hasEstimateBar = computed(() => bars.value.some((b) => b.estimate !== null));

    function byMonthTotal(k) {
      return monthly.value.find((m) => m.month === k)?.total || 0;
    }

    function setSpendView(id) {
      spendView.value = id;
      if (!barKeys.value.includes(selectedMonth.value)) {
        const withSpend = [...barKeys.value].reverse().find((k) => (byMonthTotal(k) > 0));
        selectedMonth.value = withSpend || barKeys.value[barKeys.value.length - 1] || selectedMonth.value;
      }
      if (expandedMonth.value && !barKeys.value.includes(expandedMonth.value)) expandedMonth.value = null;
    }

    /** Select the month for the hero / other widgets, and open or close its store split underneath. */
    function toggleMonth(key) {
      selectedMonth.value = key;
      expandedMonth.value = expandedMonth.value === key ? null : key;
    }

    const monthTotal = computed(() => monthly.value.find((m) => m.month === selectedMonth.value)?.total || 0);
    const isCurrentMonth = computed(() => selectedMonth.value === monthKey(localDateISO()));
    /** Full-month projection for “this month” (shown in the legend under the bars, not tied to which month is selected). */
    const monthEstimate = computed(() => estimateCurrentMonth(monthly.value));
    const spendEyebrow = computed(() => {
      const [y, m] = selectedMonth.value.split('-').map(Number);
      const monthName = new Intl.DateTimeFormat(undefined, { month: 'long' }).format(new Date(y, m - 1, 1));
      return isCurrentMonth.value ? monthName + ' so far' : formatMonthLabel(selectedMonth.value);
    });
    const spendCaption = computed(() => isCurrentMonth.value ? 'Spent this month' : 'Spent in ' + formatMonthLabel(selectedMonth.value));

    const monthPurchases = computed(() => items.value.filter((i) => i.checkedDate && monthKey(i.checkedDate) === selectedMonth.value));
    const trips = computed(() => new Set(monthPurchases.value.map((i) => i.checkedDate)).size);
    const perTrip = computed(() => (trips.value ? roundMoney(monthTotal.value / trips.value) : 0));

    /** Store split for the open month only (same idea as Nutri's getLocationTotals). */
    const expandedStores = computed(() => {
      const key = expandedMonth.value;
      if (!key) return [];
      const tot = byMonthTotal(key);
      return storeBreakdown(items.value, props.stores || [], key).map((r) => {
        const share = tot > 0 ? Math.round((r.total / tot) * 100) : 0;
        return {
          ...r,
          barPct: tot > 0 ? Math.max(3, Math.round((r.total / tot) * 100)) : 0,
          shareLabel: share < 1 && r.total > 0 ? '<1%' : share + '%',
        };
      });
    });

    const months12 = computed(() => lastMonths(12));
    const topRange = computed(() => {
      if (topPeriod.value === 'month') return periodRange('month', selectedMonth.value);
      if (topPeriod.value === '12m') {
        const keys = months12.value;
        return { from: periodRange('month', keys[0]).from, to: periodRange('month', keys[keys.length - 1]).to };
      }
      return null;
    });
    const top = computed(() => {
      const rows = topItems(items.value, 8, topRange.value);
      const max = Math.max(1, ...rows.map((r) => r.count));
      return rows.map((r) => ({ ...r, pct: Math.max(3, Math.round((r.count / max) * 100)) }));
    });
    const topMonthChip = computed(() => isCurrentMonth.value ? 'This month' : formatMonthShort(selectedMonth.value));
    const topPeriodLabel = computed(() => {
      if (topPeriod.value === 'month') return formatMonthLabel(selectedMonth.value);
      if (topPeriod.value === '12m') return 'Last 12 months';
      return 'All time';
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
          showNutri.value ? SheetsApi.getTabData(sid, TABS.NUTRITION).catch(() => []) : Promise.resolve([]),
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

    function openList() {
      const storeId = firstStoreWithPending(toBuy.value, props.stores);
      emit('navigate', 'groceries', storeId === null ? undefined : { storeId });
    }

    return {
      loading, loadError, load, openList, trackPrices, fmt, bars, selectedMonth, expandedMonth, toggleMonth,
      monthTotal, monthEstimate, isCurrentMonth, spendEyebrow, spendCaption, spendView, spendYears, setSpendView,
      hasEstimateBar, expandedStores, trips, perTrip, top, topPeriod, topMonthChip, topPeriodLabel, hasPurchases,
      nutri, widgetOrder, formatMonthLabel, toBuy, toBuyTotal, toBuyStores,
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
            <button class="btn btn-primary btn-sm" @click="openList">Open list</button>
          </div>
        </div>

        <template v-else-if="w.id === 'spending' && hasPurchases">
          <div v-if="!trackPrices" class="banner banner-info mb-16">
            <span class="material-icons">info</span>
            <div class="banner-content">Price tracking is off for this group, so spending is not shown. Turn it on in Groups to see totals per month and store.</div>
          </div>
          <div v-else class="card mb-16 gl-spend">
            <div class="gl-spend-chips" role="tablist" aria-label="Spending period">
              <button type="button" class="gl-store-tab" :class="{ active: spendView === '12m' }" role="tab" :aria-selected="spendView === '12m'" @click="setSpendView('12m')">12 months</button>
              <button v-for="y in spendYears" :key="y" type="button" class="gl-store-tab" :class="{ active: spendView === y }" role="tab" :aria-selected="spendView === y" @click="setSpendView(y)">{{ y }}</button>
            </div>
            <div class="gl-spend-hero">
              <div class="gl-spend-eyebrow">{{ spendEyebrow }}</div>
              <div class="gl-spend-amount">{{ fmt(monthTotal) }}</div>
              <div class="gl-spend-caption">{{ spendCaption }}</div>
            </div>
            <div class="gl-spend-trend">
              <div class="gl-spend-trend-head">
                <h3>Monthly trend</h3>
                <span>Tap a month for stores</span>
              </div>
              <div v-for="b in bars" :key="b.key" class="gl-trend-block" :class="{ open: expandedMonth === b.key, active: b.key === selectedMonth }">
                <button type="button" class="gl-trend-row"
                        :aria-expanded="expandedMonth === b.key ? 'true' : 'false'"
                        :aria-label="formatMonthLabel(b.key) + ': ' + fmt(b.total) + (b.estimate !== null ? ', estimated ' + fmt(b.estimate) : '') + (expandedMonth === b.key ? ', hide stores' : ', show stores')"
                        @click="toggleMonth(b.key)">
                  <span class="gl-trend-meta">
                    <span class="gl-trend-label"><span class="material-icons gl-trend-chevron">{{ expandedMonth === b.key ? 'expand_less' : 'expand_more' }}</span>{{ b.label }}</span>
                    <span>{{ fmt(b.total) }}</span>
                  </span>
                  <span class="gl-trend-track">
                    <span class="gl-trend-fill" :class="{ 'gl-trend-fill--est': b.estimate !== null }" :style="{ width: b.width + '%' }">
                      <span v-if="b.estimate !== null" class="gl-trend-spent" :style="{ width: b.spentPct + '%' }"></span>
                    </span>
                  </span>
                </button>
                <div v-if="expandedMonth === b.key" class="gl-spend-stores gl-spend-stores--nested">
                  <div v-if="expandedStores.length === 0" class="gl-spend-stores-empty">No priced purchases this month</div>
                  <div v-for="r in expandedStores" :key="r.name" class="gl-spend-store">
                    <div class="gl-spend-store-top">
                      <span class="truncate">{{ r.name }}</span>
                      <span>{{ fmt(r.total) }}</span>
                    </div>
                    <div class="gl-spend-store-sub">
                      <span>{{ r.city }}</span>
                      <span>{{ r.shareLabel }} of month</span>
                    </div>
                    <div class="gl-hbar-track"><div class="gl-hbar-fill" :style="{ width: r.barPct + '%' }"></div></div>
                  </div>
                </div>
              </div>
              <div v-if="hasEstimateBar && monthEstimate !== null" class="gl-spend-legend">
                <span><i class="gl-spend-swatch"></i>Spent</span>
                <span><i class="gl-spend-swatch gl-spend-swatch--est"></i>Projected portion · {{ fmt(monthEstimate) }}</span>
              </div>
            </div>
          </div>
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

        <div v-else-if="w.id === 'topItems' && hasPurchases" class="card mb-16">
          <div class="card-header"><h3>Bought most often</h3></div>
          <div class="card-body">
            <div class="gl-spend-chips gl-spend-chips--inline" role="tablist" aria-label="Bought most often period">
              <button type="button" class="gl-store-tab" :class="{ active: topPeriod === 'month' }" role="tab" :aria-selected="topPeriod === 'month'" @click="topPeriod = 'month'">{{ topMonthChip }}</button>
              <button type="button" class="gl-store-tab" :class="{ active: topPeriod === '12m' }" role="tab" :aria-selected="topPeriod === '12m'" @click="topPeriod = '12m'">12 months</button>
              <button type="button" class="gl-store-tab" :class="{ active: topPeriod === 'all' }" role="tab" :aria-selected="topPeriod === 'all'" @click="topPeriod = 'all'">All time</button>
            </div>
            <p class="gl-spend-period-hint">{{ topPeriodLabel }}</p>
            <div v-if="top.length === 0" class="gl-sheet-hint" style="margin:8px 0 0;">Nothing bought in this period.</div>
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
