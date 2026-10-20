/**
 * Activity: getting started, last month's recap, milestones, what's new and the install card.
 * Same structure as Activity in Valu Finance. Works from the Items and Stores tabs only.
 */

import SheetsApi, { TABS } from './sheetsApi.js';
import {
  formatCurrency, rowToItem, spendingByMonth, storeBreakdown, monthKey, localDateISO, roundMoney,
} from './groceryLogic.js';
import { STORAGE_PREFIX } from './config.js';

const { ref, computed, watch, inject } = Vue;

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const ONBOARDING_KEY = STORAGE_PREFIX + 'onboarding_dismissed';

export default {
  props: ['sheetId', 'settings', 'stores', 'groupName', 'changeTick'],
  emits: ['go-home', 'navigate'],

  setup(props) {
    const installBanner = inject('installBanner', { installed: ref(true), install: () => {} });
    const items = ref([]);
    const loading = ref(false);
    const onboardingCollapsed = ref(localStorage.getItem(ONBOARDING_KEY) === '1');

    const baseCurrency = computed(() => props.settings?.baseCurrency || 'USD');
    const trackPrices = computed(() => (props.settings?.trackPrices ?? 'true') !== 'false');
    const fmt = (n) => formatCurrency(n, baseCurrency.value);
    const version = window.VALU_VERSION || '';

    async function fetchData() {
      const sid = props.sheetId;
      if (!sid) return;
      loading.value = true;
      try {
        const rows = await SheetsApi.getTabData(sid, TABS.ITEMS);
        if (sid !== props.sheetId) return;
        items.value = rows.map(rowToItem).filter((i) => i.id && i.title.trim());
      } catch { /* the recap simply stays empty */ } finally {
        loading.value = false;
      }
    }
    watch(() => props.sheetId, (sid) => { if (sid) fetchData(); }, { immediate: true });
    watch(() => props.changeTick, () => fetchData());

    const purchases = computed(() => items.value.filter((i) => i.checkedDate));

    // Last month recap
    const monthlySummary = computed(() => {
      const now = new Date();
      let month = now.getMonth() - 1;
      let year = now.getFullYear();
      if (month < 0) { month = 11; year -= 1; }
      const key = `${year}-${String(month + 1).padStart(2, '0')}`;
      const bought = purchases.value.filter((i) => monthKey(i.checkedDate) === key);
      if (bought.length === 0) return null;
      const total = roundMoney(spendingByMonth(items.value).find((m) => m.month === key)?.total || 0);
      const days = new Set(bought.map((i) => i.checkedDate)).size;
      const topStores = storeBreakdown(items.value, props.stores || [], key).slice(0, 3);
      return { monthName: MONTH_NAMES[month], year, total, days, count: bought.length, topStores };
    });

    // Milestones
    const milestones = computed(() => {
      const list = [];
      const bought = purchases.value.length;
      const days = new Set(purchases.value.map((i) => i.checkedDate)).size;
      const storeCount = (props.stores || []).length;
      if (items.value.length >= 1) list.push({ icon: 'add_shopping_cart', label: 'First item added', done: true });
      if (bought >= 1) list.push({ icon: 'shopping_bag', label: 'First item bought', done: true });
      if (bought >= 50) list.push({ icon: 'trending_up', label: '50 items bought', done: true });
      if (bought >= 250) list.push({ icon: 'star_half', label: '250 items bought', done: true });
      if (bought >= 1000) list.push({ icon: 'star', label: '1000 items bought', done: true });
      if (days >= 10) list.push({ icon: 'event_available', label: '10 shopping days', done: true });
      if (storeCount >= 1) list.push({ icon: 'storefront', label: 'First store added', done: true });

      if (items.value.length === 0) list.push({ icon: 'add_shopping_cart', label: 'Add your first item', done: false });
      else if (bought === 0) list.push({ icon: 'shopping_bag', label: 'Mark your first item as bought', done: false });
      else if (bought < 50) list.push({ icon: 'trending_up', label: `50 items bought (${bought}/50)`, done: false });
      else if (bought < 250) list.push({ icon: 'star_half', label: `250 items bought (${bought}/250)`, done: false });
      else if (bought < 1000) list.push({ icon: 'star', label: `1000 items bought (${bought}/1000)`, done: false });
      if (days < 10 && bought > 0) list.push({ icon: 'event_available', label: `10 shopping days (${days}/10)`, done: false });
      if (storeCount === 0) list.push({ icon: 'storefront', label: 'Add a store', done: false });
      return list;
    });

    function collapseOnboarding() {
      onboardingCollapsed.value = true;
      try { localStorage.setItem(ONBOARDING_KEY, '1'); } catch { /* storage blocked */ }
    }
    function expandOnboarding() {
      onboardingCollapsed.value = false;
      try { localStorage.removeItem(ONBOARDING_KEY); } catch { /* storage blocked */ }
    }

    return {
      loading, trackPrices, baseCurrency, fmt, version, monthlySummary, milestones, installBanner,
      onboardingCollapsed, collapseOnboarding, expandOnboarding, today: localDateISO(),
    };
  },

  template: `
    <div class="subpage">
      <div class="subpage-scroll">
      <div class="subpage-nav">
        <button class="subpage-back subpage-back--colored" @click="$emit('go-home')">
          <span class="material-icons">arrow_back</span>
        </button>
        <h1 class="subpage-nav-title">Activity</h1>
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

      <div class="page">
        <!-- Getting Started: collapsed -->
        <div v-if="onboardingCollapsed" class="card mb-16 activity-card activity-card--collapsed" @click="expandOnboarding">
          <div class="activity-collapsed-row">
            <span class="material-icons activity-collapsed-icon">auto_awesome</span>
            <span class="activity-collapsed-title">Getting Started</span>
            <span class="material-icons activity-collapsed-chevron">expand_more</span>
          </div>
        </div>

        <!-- Getting Started: expanded -->
        <div v-else class="card mb-16 activity-card">
          <div class="activity-card-badge">Getting Started</div>
          <div class="activity-card-body">
            <h3 class="activity-card-title">Welcome to Valu Groceries</h3>
            <p class="activity-card-text">Your shopping list, private and stored in your own Google Drive.</p>

            <div class="activity-info-block">
              <span class="material-icons activity-info-icon">folder</span>
              <div>
                <strong>Your data, your Drive</strong>
                <p>A spreadsheet named <strong>"Valu Groceries: {{ groupName || 'Groceries' }}"</strong> lives in your Google Drive. Everything you add is saved there. The app only reads and writes to it, and never uploads receipts or photos.</p>
                <p>In Valu, a spreadsheet like this is called a <strong>Group</strong>. You can rename it, create more, or share one with your household.</p>
              </div>
            </div>

            <div class="activity-info-block">
              <span class="material-icons activity-info-icon">storefront</span>
              <div>
                <strong>Stores</strong>
                <p>Add the shops you use in <strong>Stores</strong>. Each store gets its own list on the Groceries page, and items without a store live in <strong>Anywhere</strong>.</p>
              </div>
            </div>

            <div class="activity-info-block">
              <span class="material-icons activity-info-icon">checklist</span>
              <div>
                <strong>Select, then act</strong>
                <p>On the Groceries page, tick items to select them. Then mark them as bought, set a date, move them to another store or delete them. Use the box at the top to select everything.</p>
              </div>
            </div>

            <div class="activity-info-block">
              <span class="material-icons activity-info-icon">language</span>
              <div>
                <strong>Base currency: {{ baseCurrency }}</strong>
                <p>Prices are stored in <strong>{{ baseCurrency }}</strong>. Buying abroad? Give the store its own currency and the price is converted at the rate of the day.</p>
              </div>
            </div>

            <button class="btn btn-primary" style="width:100%;margin-top:16px;" @click="collapseOnboarding">Got it</button>
          </div>
        </div>

        <!-- Last month -->
        <div v-if="monthlySummary" class="card mb-16 activity-feed-card">
          <div class="activity-feed-header">
            <span class="material-icons activity-feed-icon" style="color:#6a8caf;">insights</span>
            <div>
              <div class="activity-feed-title">{{ monthlySummary.monthName }} {{ monthlySummary.year }}</div>
              <div class="activity-feed-date">Previous month summary</div>
            </div>
          </div>
          <div class="activity-feed-body">
            <div class="activity-summary-stats">
              <div v-if="trackPrices" class="activity-summary-stat">
                <span class="activity-summary-label">Spent</span>
                <span class="activity-summary-value">{{ fmt(monthlySummary.total) }}</span>
              </div>
              <div class="activity-summary-stat">
                <span class="activity-summary-label">Items bought</span>
                <span class="activity-summary-value">{{ monthlySummary.count }}</span>
              </div>
              <div class="activity-summary-stat">
                <span class="activity-summary-label">Shopping days</span>
                <span class="activity-summary-value">{{ monthlySummary.days }}</span>
              </div>
            </div>
            <div v-if="trackPrices && monthlySummary.topStores.length > 0" class="activity-summary-cats">
              <div class="activity-summary-cat-label">Top stores</div>
              <div v-for="s in monthlySummary.topStores" :key="s.name" class="activity-summary-cat-row">
                <span class="activity-summary-cat-name">{{ s.name }}</span>
                <span class="activity-summary-cat-amount">{{ fmt(s.total) }}</span>
              </div>
            </div>
          </div>
        </div>
        <div v-else class="card mb-16 activity-feed-card activity-feed-card--muted">
          <div class="activity-feed-header">
            <span class="material-icons activity-feed-icon" style="color:#6a8caf;">insights</span>
            <div>
              <div class="activity-feed-title">Monthly Summary</div>
              <div class="activity-feed-date">{{ loading ? 'Loading...' : 'No purchases last month yet' }}</div>
            </div>
          </div>
          <div class="activity-feed-body">
            <p>Once you mark items as bought, a recap of the previous month appears here: what you spent, how often you shopped and where.</p>
          </div>
        </div>

        <!-- Milestones -->
        <div class="card mb-16 activity-feed-card">
          <div class="activity-feed-header">
            <span class="material-icons activity-feed-icon" style="color:#b07d4f;">emoji_events</span>
            <div>
              <div class="activity-feed-title">Milestones</div>
              <div class="activity-feed-date">{{ milestones.filter(m => m.done).length }} achieved</div>
            </div>
          </div>
          <div class="activity-feed-body">
            <div v-for="(m, i) in milestones" :key="i" class="activity-milestone-row">
              <span class="material-icons activity-milestone-icon" :style="{ color: m.done ? 'var(--color-primary)' : 'var(--color-text-hint)' }">{{ m.icon }}</span>
              <span class="activity-milestone-label" :class="{ 'activity-milestone--pending': !m.done }">{{ m.label }}</span>
              <span v-if="m.done" class="material-icons activity-milestone-check">check_circle</span>
            </div>
          </div>
        </div>

        <!-- What's New -->
        <div id="whats-new" class="card mb-16 activity-feed-card">
          <div class="activity-feed-header">
            <span class="material-icons activity-feed-icon" style="color:#5c8a8a;">new_releases</span>
            <div>
              <div class="activity-feed-title">What's New in {{ version }}</div>
              <div class="activity-feed-date">October 2026</div>
            </div>
          </div>
          <div class="activity-feed-body">
            <ul class="activity-feed-list">
              <li><strong>One spending widget</strong> — Months and stores are together on Home: tap a month, see the projection and where you shopped. <strong>Bought most often</strong> can be this month, 12 months or all time.</li>
              <li><strong>Nutri dates match Finance</strong> — Imported purchases now use the same calendar day Nutri showed. If you already imported, run <strong>Import from Nutri</strong> once more; existing items are not duplicated, only the dates are corrected.</li>
              <li><strong>Same layout as Valu Finance</strong> — The home page is now your dashboard. Open the shopping list from the <strong>Groceries</strong> tab, next to Stores, History and Settings.</li>
              <li><strong>A much better History</strong> — Pick a year, month, day or date range, filter on several stores, sort, and switch to <strong>Products</strong> to see average prices and where each product is cheapest. Tap a purchase to correct it. Select several to change their date, move them, delete them or <strong>copy them to the clipboard</strong> with the fields you choose.</li>
              <li><strong>Nutrition</strong> — See the calories, protein, carbs and fat of what you buy, per day and per month. Common groceries are filled in automatically; for the rest you can copy a request into the AI assistant of your choice and paste its answer back. The app itself sends nothing. Turn it off for a whole group under <strong>Groups</strong>, or hide it on this device under <strong>Settings</strong>.</li>
              <li><strong>Fair price comparison</strong> — In History, Products now compares stores per 100 g (or per piece) instead of per purchase, so a big pack no longer looks dearer than a small one.</li>
              <li><strong>Make Home yours</strong> — Under <strong>Settings, Home layout</strong>, show or hide each Home widget and change their order. Home also shows a Nutrition summary of the selected month. Under <strong>Settings, Start page</strong> you can open the app on Groceries, History, Nutrition or Stores instead of the Dashboard.</li>
              <li><strong>Select, then act</strong> — Items always show a checkbox. Select a few (or all) and mark them as bought, set a date, move them to another store or delete them.</li>
              <li><strong>Smarter suggestions</strong> — Typing a name lists your earlier quantity and price variants for the same store.</li>
              <li><strong>Price in the quick-add bar</strong> — Type a quantity and a price right next to the name, in your base currency or the store's own.</li>
              <li><strong>Store currency</strong> — Moving items to a store with another currency resets their price, so nothing stays in the wrong currency.</li>
              <li><strong>Numeric quantity</strong> — Quantity is a plain number, ready for future nutrition features.</li>
            </ul>
          </div>
        </div>

        <!-- Tip -->
        <div class="card mb-16 activity-feed-card">
          <div class="activity-feed-header">
            <span class="material-icons activity-feed-icon" style="color:#c09a4b;">lightbulb</span>
            <div>
              <div class="activity-feed-title">Tip: Buy again</div>
              <div class="activity-feed-date">Quick tip</div>
            </div>
          </div>
          <div class="activity-feed-body">
            <p>Select items you already bought on the Groceries page and tap <strong>Buy again</strong> to put them back on your list. <strong>Add from a previous trip</strong> brings back a whole day at once.</p>
          </div>
        </div>

        <!-- Install app card -->
        <div v-if="!installBanner.installed.value" class="card mb-16 install-card">
          <div class="install-card-body">
            <span class="material-icons install-card-icon">download</span>
            <div class="install-card-content">
              <strong>Install Valu Groceries</strong>
              <span>Add to your home screen for the best experience: fast access, works offline.</span>
            </div>
          </div>
          <div class="install-card-actions">
            <button class="btn btn-primary btn-sm" @click="installBanner.install()">Install</button>
          </div>
        </div>
      </div>
      </div>
    </div>
  `,
};
