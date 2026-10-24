/**
 * Nutrition page: what the group buys, in calories, protein, carbs and fat.
 *
 * The numbers come from the group's own "Nutrition" tab (one row per product name, per 100 g / 100 ml).
 * That tab is kept up to date automatically:
 *   - products the built-in table knows are added the moment they show up (nothing leaves the device);
 *   - for the rest, the user can copy a ready-made request into any AI assistant they like and paste the
 *     answer back. The app never contacts an assistant or any other service itself.
 * Everything is shown with how much of the shopping it is based on, so the numbers stay honest.
 */

import SheetsApi, { TABS } from './sheetsApi.js';
import { rowToItem, localDateISO, periodRange } from './groceryLogic.js';
import {
  NUTRITION_CATEGORIES, UNITS, UNIT_LABELS, NON_FOOD, nutritionKey, matchEntry, rowToNutrition, nutritionToRow, nutritionLookup,
  missingStaples, nutritionStats, monthlyKcal, yearlyKcal, validateEntry, entryProblems, parseNutritionImport, buildNutritionPrompt, toNumber,
} from './nutritionLogic.js';
import { copyText, readClipboardText } from './clipboard.js';
import { amountText } from './ItemSheet.js';
import { formatMonthLabel, formatMonthShort } from './dateLabels.js';

const { ref, reactive, computed, watch, inject, onMounted } = Vue;

const ASSISTANTS = [
  { name: 'ChatGPT', url: 'https://chatgpt.com/' },
  { name: 'Gemini', url: 'https://gemini.google.com/app' },
  { name: 'Claude', url: 'https://claude.ai/new' },
];

function monthKeysBack(n) {
  const now = new Date();
  const keys = [];
  for (let i = n - 1; i >= 0; i--) keys.push(localDateISO(new Date(now.getFullYear(), now.getMonth() - i, 1)).slice(0, 7));
  return keys;
}

const n0 = (n) => Math.round(n).toLocaleString();
const pct = (x) => Math.round(x * 100);

export default {
  props: ['sheetId', 'settings', 'stores', 'changeTick'],
  emits: ['go-home', 'navigate'],

  setup(props) {
    const showAlert = inject('showAlert', (m) => window.alert(m));
    const showConfirm = inject('showConfirm', (m) => Promise.resolve(window.confirm(m)));

    const items = ref([]);
    const entries = ref([]);
    const loading = ref(true);
    const loadError = ref('');
    const period = ref('this');
    const expandedCat = ref('');
    const showAll = ref(false);
    const toast = ref('');
    let toastTimer = 0;
    function say(text) { toast.value = text; clearTimeout(toastTimer); toastTimer = setTimeout(() => { toast.value = ''; }, 3800); }

    // ── Writes: one at a time, rolled back when they fail ─────────────────────
    let writeChain = Promise.resolve();
    function enqueue(fn) {
      const p = writeChain.then(fn);
      writeChain = p.catch(() => {});
      return p;
    }

    const lookup = computed(() => nutritionLookup(entries.value));

    // ── Period ────────────────────────────────────────────────────────────────
    const months12 = computed(() => monthKeysBack(12));
    // Years with purchases, newest first, so older history can be browsed too.
    const years = computed(() => [...new Set(items.value.map((i) => (i.checkedDate || '').slice(0, 4)).filter((y) => /^\d{4}$/.test(y)))].sort().reverse());
    const firstPurchase = computed(() => items.value.reduce((min, i) => (i.checkedDate && (!min || i.checkedDate < min) ? i.checkedDate : min), ''));
    // null: the last 12 months; a year: the months of that year (kept while one of its months is picked)
    const chartYear = ref(null);
    function setPeriod(id) {
      period.value = id;
      if (id.startsWith('y:')) chartYear.value = id.slice(2);
      else if (!id.startsWith('m:') && id !== 'all') chartYear.value = null;
    }
    const range = computed(() => {
      const m = months12.value;
      const p = period.value;
      if (p === 'this') return periodRange('month', m[11]);
      if (p === 'last') return periodRange('month', m[10]);
      if (p === '3m') return { from: periodRange('month', m[9]).from, to: periodRange('month', m[11]).to };
      if (p === '12m') return { from: periodRange('month', m[0]).from, to: periodRange('month', m[11]).to };
      if (p.startsWith('m:')) return periodRange('month', p.slice(2));
      if (p.startsWith('y:')) { // a year that began before the first purchase is only counted from that purchase
        const y = periodRange('year', p.slice(2));
        return { from: firstPurchase.value && firstPurchase.value > y.from && firstPurchase.value <= y.to ? firstPurchase.value : y.from, to: y.to };
      }
      if (p === 'all') return { from: firstPurchase.value, to: localDateISO() };
      return periodRange('month', m[11]);
    });
    const periodLabel = computed(() => {
      const m = months12.value;
      const p = period.value;
      if (p === 'this') return formatMonthLabel(m[11]);
      if (p === 'last') return formatMonthLabel(m[10]);
      if (p === '3m') return 'Last 3 months';
      if (p === '12m') return 'Last 12 months';
      if (p.startsWith('m:')) return formatMonthLabel(p.slice(2));
      if (p.startsWith('y:')) return p.slice(2);
      if (p === 'all') return 'All time';
      return '';
    });
    const PERIODS = [
      { id: 'this', label: 'This month' }, { id: 'last', label: 'Last month' }, { id: '3m', label: '3 months' }, { id: '12m', label: '12 months' },
    ];

    // ── Numbers ───────────────────────────────────────────────────────────────
    const hasPurchases = computed(() => items.value.some((i) => i.checkedDate));
    const stats = computed(() => nutritionStats(items.value, lookup.value, range.value));
    const missingCount = computed(() => stats.value.unmatched.length + stats.value.unquantified.length);
    // The bars: per year for All time, per month of a year when one is picked, otherwise the last 12 months.
    const chart = computed(() => {
      const yearly = period.value === 'all';
      const keys = yearly ? [...years.value].reverse()
        : chartYear.value ? Array.from({ length: 12 }, (_, i) => chartYear.value + '-' + String(i + 1).padStart(2, '0'))
        : months12.value;
      const rows = yearly ? yearlyKcal(items.value, lookup.value, keys) : monthlyKcal(items.value, lookup.value, keys);
      const max = Math.max(...rows.map((r) => r.kcal), 1);
      return {
        title: yearly ? 'Calories bought per year' : chartYear.value ? 'Calories bought per month · ' + chartYear.value : 'Calories bought per month',
        yearly,
        bars: rows.map((r) => ({ ...r, id: yearly ? 'y:' + r.key : 'm:' + r.key, label: yearly ? r.key : formatMonthShort(r.key), height: r.kcal > 0 ? Math.max(4, (r.kcal / max) * 100) : 0 })),
      };
    });
    const macros = computed(() => {
      const s = stats.value;
      const d = s.days;
      return [
        { id: 'p', label: 'Protein', share: s.share.protein, grams: s.totals.protein, perDay: s.totals.protein / d },
        { id: 'c', label: 'Carbs', share: s.share.carbs, grams: s.totals.carbs, perDay: s.totals.carbs / d },
        { id: 'f', label: 'Fat', share: s.share.fat, grams: s.totals.fat, perDay: s.totals.fat / d },
      ];
    });
    const topProducts = computed(() => stats.value.products.slice(0, 8));

    /** Every product name of the group (all time, list and history) that has no nutrition data yet. */
    const needingTitles = computed(() => {
      const seen = new Map();
      for (const i of items.value) {
        const key = nutritionKey(i.title);
        if (!key || seen.has(key) || matchEntry(i.title, lookup.value)) continue;
        seen.set(key, i.title.trim());
      }
      return [...seen.values()].sort((a, b) => a.localeCompare(b));
    });
    const sortedEntries = computed(() => [...entries.value].sort((a, b) => a.name.localeCompare(b.name)));
    // Saved entries that look doubtful (for example after an import), with the reason; fixing one removes it here.
    const doubtful = computed(() => {
      const m = new Map();
      for (const e of entries.value) { const p = entryProblems(e); if (p.length) m.set(e.id, p); }
      return m;
    });
    const onlyDoubtful = ref(false);
    const shownEntries = computed(() => (onlyDoubtful.value ? sortedEntries.value.filter((e) => doubtful.value.has(e.id)) : sortedEntries.value));
    const problemsOf = (e) => doubtful.value.get(e.id) || [];
    const sourceLabel = (s) => ({ 'built-in': 'Built-in', AI: 'AI', manual: 'You' }[s] || 'Sheet');

    // ── Loading ───────────────────────────────────────────────────────────────
    let syncing = false;
    /** Products the built-in table knows get their row right away: automatic, offline, nothing leaves the device. */
    async function syncStaples() {
      if (syncing) return;
      syncing = true;
      try {
        const add = missingStaples(items.value.map((i) => i.title), lookup.value);
        if (!add.length) return;
        entries.value = [...entries.value, ...add];
        try {
          await enqueue(() => SheetsApi.appendRows(props.sheetId, TABS.NUTRITION, add.map(nutritionToRow)));
        } catch {
          entries.value = entries.value.filter((e) => !add.includes(e)); // tried again at the next visit
        }
      } finally {
        syncing = false;
      }
    }

    async function load(silent = false) {
      const sid = props.sheetId;
      if (!sid) return;
      if (!silent) { loading.value = true; loadError.value = ''; }
      try {
        const [itemRows, nutriRows] = await Promise.all([
          SheetsApi.getTabData(sid, TABS.ITEMS),
          SheetsApi.getTabData(sid, TABS.NUTRITION),
        ]);
        if (sid !== props.sheetId) return;
        items.value = itemRows.map(rowToItem).filter((i) => i.id && i.title.trim());
        entries.value = nutriRows.map(rowToNutrition).filter((e) => e.id);
        loadError.value = '';
        await syncStaples();
      } catch {
        if (!silent) loadError.value = 'Could not load your nutrition data. Check your connection and try again.';
      } finally {
        loading.value = false;
      }
    }

    // ── Edit one product ──────────────────────────────────────────────────────
    const form = reactive({
      open: false, isNew: false, name: '', kcal: '', protein: '', carbs: '', fat: '', category: 'Other food', unit: 'g', gramsPerUnit: '',
      source: '', openDropdown: null,
    });
    const text = (n) => (n === null || n === undefined ? '' : amountText(String(n)));
    function openForm(entry, isNew = false) {
      Object.assign(form, {
        open: true, isNew, openDropdown: null,
        name: entry.name, kcal: isNew && !entry.kcal ? '' : text(entry.kcal), protein: isNew && !entry.protein ? '' : text(entry.protein),
        carbs: isNew && !entry.carbs ? '' : text(entry.carbs), fat: isNew && !entry.fat ? '' : text(entry.fat),
        category: entry.category || 'Other food', unit: entry.unit || 'g', gramsPerUnit: entry.gramsPerUnit > 1 ? text(entry.gramsPerUnit) : '',
        source: entry.source || '',
      });
    }
    function editEntry(e) { openForm(e, false); }
    function addProduct(name = '') { openForm({ name, kcal: '', protein: '', carbs: '', fat: '', category: 'Other food', unit: 'g', gramsPerUnit: 1 }, true); }
    function closeForm() { form.open = false; }
    const formCheck = computed(() => validateEntry({
      name: form.name, kcal: toNumber(form.kcal), protein: toNumber(form.protein), carbs: toNumber(form.carbs), fat: toNumber(form.fat),
      category: form.category, unit: form.unit, gramsPerUnit: toNumber(form.gramsPerUnit),
    }));
    const formIsNonFood = computed(() => form.category === NON_FOOD);
    /** Nothing is flagged before the user has typed anything. */
    const formProblems = computed(() => {
      const c = formCheck.value;
      if (form.isNew && !form.kcal && !form.protein && !form.carbs && !form.fat && !formIsNonFood.value) return [];
      return form.name.trim() ? c.problems : c.problems.filter((p) => p !== 'No name');
    });
    const formEnergyLine = computed(() => {
      const c = formCheck.value.entry;
      return c.kcal > 0 ? '100 ' + (form.unit === 'ml' ? 'ml' : 'g') + ' = ' + n0(c.kcal) + ' kcal' : '';
    });

    function saveForm() {
      const { entry, status } = formCheck.value;
      if (status === 'error') return;
      entry.source = 'manual';
      const existing = entries.value.find((e) => e.id === entry.id);
      closeForm();
      if (existing) {
        const before = { ...existing };
        Object.assign(existing, entry);
        enqueue(() => SheetsApi.updateRow(props.sheetId, TABS.NUTRITION, entry.id, nutritionToRow(entry))).catch(() => {
          Object.assign(existing, before);
          showAlert('Could not save that change. Check your connection and try again.');
        });
      } else {
        entries.value = [...entries.value, entry];
        enqueue(() => SheetsApi.appendRow(props.sheetId, TABS.NUTRITION, nutritionToRow(entry))).catch(() => {
          entries.value = entries.value.filter((e) => e !== entry);
          showAlert('Could not save that change. Check your connection and try again.');
        });
      }
    }

    async function deleteForm() {
      const key = nutritionKey(form.name);
      const existing = entries.value.find((e) => e.id === key);
      if (!existing) { closeForm(); return; }
      if (!(await showConfirm('Delete the nutrition data of "' + existing.name + '"?'))) return;
      closeForm();
      entries.value = entries.value.filter((e) => e !== existing);
      enqueue(() => SheetsApi.deleteRows(props.sheetId, TABS.NUTRITION, [existing.id])).catch(() => {
        entries.value = [...entries.value, existing];
        showAlert('Could not delete. Check your connection and try again.');
      });
    }

    // ── Fill in with an AI assistant of the user's choice ─────────────────────
    const assist = reactive({ open: false, selected: [], pasted: '', copied: false });
    function openAssist() {
      assist.selected = needingTitles.value.slice();
      assist.pasted = '';
      assist.copied = false;
      assist.open = true;
    }
    function closeAssist() { assist.open = false; }
    function toggleName(n) {
      assist.selected = assist.selected.includes(n) ? assist.selected.filter((x) => x !== n) : [...assist.selected, n];
      assist.copied = false;
    }
    function toggleAllNames() {
      assist.selected = assist.selected.length === needingTitles.value.length ? [] : needingTitles.value.slice();
      assist.copied = false;
    }
    const prompt = computed(() => buildNutritionPrompt(assist.selected));
    async function copyRequest() {
      if (!assist.selected.length) return;
      const ok = await copyText(prompt.value);
      if (ok) { assist.copied = true; say('Request copied. Paste it into your assistant, then paste its answer back here.'); }
      else showAlert('Could not copy to the clipboard. Your browser may not allow it here.');
    }
    async function pasteAnswer() {
      const t = await readClipboardText();
      if (t) assist.pasted = t;
      else showAlert('Could not read the clipboard. Paste into the box with a long-press or Ctrl+V.');
    }
    const parsed = computed(() => (assist.pasted.trim() ? parseNutritionImport(assist.pasted, assist.selected) : null));
    const importable = computed(() => (parsed.value ? parsed.value.rows.filter((r) => r.status !== 'error') : []));
    const parsedSummary = computed(() => {
      const p = parsed.value;
      if (!p) return null;
      return {
        ok: p.rows.filter((r) => r.status === 'ok').length,
        review: p.rows.filter((r) => r.status === 'review').length,
        error: p.rows.filter((r) => r.status === 'error').length,
        unanswered: p.unanswered.length,
      };
    });

    function importAnswer() {
      const rows = importable.value;
      if (!rows.length) return;
      const current = entries.value;
      const toAdd = [];
      const toUpdate = [];
      for (const r of rows) {
        const existing = current.find((e) => e.id === r.entry.id);
        if (existing) toUpdate.push({ existing, before: { ...existing }, next: r.entry }); else toAdd.push(r.entry);
      }
      toUpdate.forEach((u) => Object.assign(u.existing, u.next));
      entries.value = [...current, ...toAdd];
      const total = rows.length;
      const flagged = rows.filter((r) => r.status === 'review').length;
      closeAssist();
      if (toAdd.length) {
        enqueue(() => SheetsApi.appendRows(props.sheetId, TABS.NUTRITION, toAdd.map(nutritionToRow))).catch(() => {
          entries.value = entries.value.filter((e) => !toAdd.includes(e));
          showAlert('Could not save the new products. Check your connection and try again.');
        });
      }
      if (toUpdate.length) {
        enqueue(() => SheetsApi.batchUpdateRows(props.sheetId, TABS.NUTRITION, toUpdate.map((u) => ({ id: u.existing.id, values: nutritionToRow(u.existing) })))).catch(() => {
          toUpdate.forEach((u) => Object.assign(u.existing, u.before));
          showAlert('Could not save the changes. Check your connection and try again.');
        });
      }
      say('Added ' + total + (total === 1 ? ' product' : ' products') + (flagged ? ' · ' + flagged + ' to double-check in the list below' : ''));
      if (flagged) showAll.value = true;
    }

    watch(() => props.changeTick, () => { if (!form.open && !assist.open) load(true); });
    onMounted(() => load());

    return {
      loading, loadError, load, period, PERIODS, periodLabel, years, setPeriod, chart, hasPurchases, stats, missingCount, macros, topProducts,
      expandedCat, showAll, toast, needingTitles, sortedEntries, shownEntries, doubtful, onlyDoubtful, problemsOf, sourceLabel, n0, pct,
      form, formCheck, formProblems, formIsNonFood, formEnergyLine, editEntry, addProduct, closeForm, saveForm, deleteForm,
      categories: NUTRITION_CATEGORIES, units: UNITS, unitLabels: UNIT_LABELS,
      assist, ASSISTANTS, openAssist, closeAssist, toggleName, toggleAllNames, prompt, copyRequest, pasteAnswer, parsed, importable, parsedSummary, importAnswer,
      toggleCat(name) { expandedCat.value = expandedCat.value === name ? '' : name; },
      unmatchedAdd: (title) => addProduct(title),
      editByKey(key) { const e = entries.value.find((x) => x.id === key); if (e) editEntry(e); },
    };
  },

  template: `
    <div class="subpage">
      <div class="subpage-scroll">
      <div class="subpage-nav">
        <button class="subpage-back subpage-back--colored" @click="$emit('go-home')">
          <span class="material-icons">arrow_back</span>
        </button>
        <h1 class="subpage-nav-title">Nutrition</h1>
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

      <div v-if="loading" class="loading" style="padding-top:40px;"><div class="spinner"></div>Loading nutrition...</div>

      <div v-else-if="loadError" class="empty-state" style="padding-top:40px;">
        <span class="material-icons">cloud_off</span>
        <h3>Something went wrong</h3>
        <p>{{ loadError }}</p>
        <button class="btn-link" @click="load()">Try again</button>
      </div>

      <div v-else class="gl-nutri">
        <div v-if="!hasPurchases" class="empty-state" style="padding-top:32px;">
          <span class="material-icons">restaurant</span>
          <h3>Nothing to show yet</h3>
          <p>Once you mark items as bought, you will see the calories, protein, carbs and fat of what you buy.</p>
        </div>

        <template v-else>
          <div class="gl-hist-views gl-nutri-chips" role="tablist">
            <button v-for="p in PERIODS" :key="p.id" class="gl-store-tab" :class="{ active: period === p.id }" role="tab" :aria-selected="period === p.id" @click="setPeriod(p.id)">{{ p.label }}</button>
          </div>
          <div v-if="years.length > 1" class="gl-hist-views gl-nutri-chips" role="tablist" aria-label="Older history">
            <button class="gl-store-tab" :class="{ active: period === 'all' }" role="tab" :aria-selected="period === 'all'" @click="setPeriod('all')">All time</button>
            <button v-for="y in years" :key="y" class="gl-store-tab" :class="{ active: period === 'y:' + y }" role="tab" :aria-selected="period === 'y:' + y" @click="setPeriod('y:' + y)">{{ y }}</button>
          </div>

          <div class="gl-total-hero">
            <div class="gl-total-hero-amount">{{ n0(stats.perDay) }}<small class="gl-nutri-unit"> kcal / day</small></div>
            <div class="gl-total-hero-label">Bought per day, whole group · {{ periodLabel }}</div>
            <div class="gl-total-hero-label">{{ n0(stats.totals.kcal) }} kcal in total over {{ stats.days }} {{ stats.days === 1 ? 'day' : 'days' }}</div>
          </div>

          <div class="card mb-16">
            <div class="card-body">
              <div class="gl-hbar-top"><span>Based on {{ pct(stats.coverage) }}% of your purchases</span><span>{{ stats.counted }} counted</span></div>
              <div class="gl-hbar-track"><div class="gl-hbar-fill" :style="{ width: pct(stats.coverage) + '%' }"></div></div>
              <p v-if="stats.unmatched.length || stats.unquantified.length" class="gl-sheet-hint" style="margin:8px 0 0;">
                <template v-if="stats.unmatched.length">{{ stats.unmatched.length }} {{ stats.unmatched.length === 1 ? 'product has' : 'products have' }} no nutrition data yet. </template>
                <template v-if="stats.unquantified.length">{{ stats.unquantified.length }} {{ stats.unquantified.length === 1 ? 'product needs' : 'products need' }} a clearer quantity or unit. </template>
              </p>
              <p v-else class="gl-sheet-hint" style="margin:8px 0 0;">Everything you bought in this period is counted. This is what was bought, not what was eaten, and the values are estimates.</p>
              <button v-if="needingTitles.length" class="btn btn-primary btn-sm" style="margin-top:10px;" @click="openAssist">
                <span class="material-icons" style="font-size:18px;vertical-align:middle;margin-right:4px;">auto_awesome</span>Fill in {{ needingTitles.length }} missing {{ needingTitles.length === 1 ? 'product' : 'products' }}
              </button>
            </div>
          </div>

          <div v-if="stats.counted > 0" class="card mb-16">
            <div class="card-header"><h3>Protein, carbs and fat</h3></div>
            <div class="card-body">
              <div class="gl-macro-bar" role="img" :aria-label="'Protein ' + pct(macros[0].share) + '%, carbs ' + pct(macros[1].share) + '%, fat ' + pct(macros[2].share) + '%'">
                <span v-for="m in macros" :key="m.id" class="gl-macro" :class="'gl-macro--' + m.id" :style="{ width: pct(m.share) + '%' }"></span>
              </div>
              <div class="gl-macro-legend">
                <div v-for="m in macros" :key="m.id" class="gl-macro-item">
                  <span class="gl-macro-dot" :class="'gl-macro--' + m.id"></span>
                  <span class="gl-macro-name">{{ m.label }}</span>
                  <span class="gl-macro-val"><strong>{{ pct(m.share) }}%</strong> of calories</span>
                  <span class="gl-macro-sub">{{ n0(m.perDay) }} g per day</span>
                </div>
              </div>
            </div>
          </div>

          <div v-if="stats.categories.length" class="card mb-16">
            <div class="card-header"><h3>Where the calories come from</h3></div>
            <div class="card-body">
              <div v-for="c in stats.categories" :key="c.name" class="gl-hbar-row gl-nutri-cat" @click="toggleCat(c.name)">
                <div class="gl-hbar-top"><span class="truncate">{{ c.name }}</span><span>{{ pct(c.pct) }}% · {{ n0(c.kcal) }} kcal</span></div>
                <div class="gl-hbar-track"><div class="gl-hbar-fill" :style="{ width: pct(c.pct) + '%' }"></div></div>
                <div v-if="expandedCat === c.name" class="gl-nutri-cat-items">
                  <div v-for="p in c.products.slice(0, 6)" :key="p.key" class="gl-nutri-cat-item"><span class="truncate">{{ p.title }}</span><span>{{ n0(p.kcal) }} kcal</span></div>
                </div>
              </div>
            </div>
          </div>

          <div class="card mb-16">
            <div class="card-header"><h3>{{ chart.title }}</h3></div>
            <div class="card-body">
              <div class="gl-bars">
                <button v-for="b in chart.bars" :key="b.key" type="button" class="gl-bar-col" :class="{ active: period === b.id }"
                        :aria-label="b.label + ': ' + n0(b.kcal) + ' kcal'" @click="setPeriod(b.id)">
                  <span class="gl-bar" :style="{ height: b.height + '%' }"></span>
                  <span class="gl-bar-label">{{ b.label }}</span>
                </button>
              </div>
            </div>
          </div>

          <div v-if="topProducts.length" class="card mb-16">
            <div class="card-header"><h3>Most calories bought</h3></div>
            <div class="card-body">
              <div v-for="p in topProducts" :key="p.key" class="gl-hbar-row">
                <div class="gl-hbar-top"><span class="truncate">{{ p.title }}</span><span>{{ n0(p.kcal) }} kcal</span></div>
                <div class="gl-hbar-track"><div class="gl-hbar-fill" :style="{ width: (p.kcal / topProducts[0].kcal * 100) + '%' }"></div></div>
              </div>
            </div>
          </div>

          <div v-if="stats.unmatched.length || stats.unquantified.length" class="card mb-16">
            <div class="card-header"><h3>Not counted yet</h3></div>
            <div class="card-body" style="padding-top:0;">
              <div v-for="u in stats.unmatched" :key="'u' + u.key" class="gl-nutri-row" @click="unmatchedAdd(u.title)">
                <span class="truncate">{{ u.title }}</span><span class="gl-nutri-row-meta">{{ u.count }}× · no data</span><span class="material-icons">chevron_right</span>
              </div>
              <div v-for="u in stats.unquantified" :key="'q' + u.key" class="gl-nutri-row" @click="editByKey(u.key)">
                <span class="truncate">{{ u.title }}</span><span class="gl-nutri-row-meta">{{ u.count }}× · needs a unit or quantity</span><span class="material-icons">chevron_right</span>
              </div>
            </div>
          </div>
        </template>

        <div class="card mb-16">
          <div class="card-header"><h3>Nutrition data</h3></div>
          <div class="card-body">
            <p class="gl-sheet-hint" style="margin-top:0;">
              {{ sortedEntries.length }} {{ sortedEntries.length === 1 ? 'product' : 'products' }} in this group's <strong>Nutrition</strong> sheet, per 100 g or 100 ml. Common groceries are filled in automatically from a built-in table that stays on your device.
            </p>
            <div class="gl-nutri-actions">
              <button v-if="needingTitles.length" class="btn btn-primary btn-sm" @click="openAssist"><span class="material-icons" style="font-size:18px;vertical-align:middle;margin-right:4px;">auto_awesome</span>Fill in missing</button>
              <button class="btn btn-sm" @click="addProduct()"><span class="material-icons" style="font-size:18px;vertical-align:middle;margin-right:4px;">add</span>Add a product</button>
              <button v-if="sortedEntries.length" class="btn btn-text btn-sm" @click="showAll = !showAll">{{ showAll ? 'Hide list' : 'Show list' }}</button>
            </div>
            <div v-if="showAll && doubtful.size" class="gl-nutri-chips" role="tablist" style="margin-bottom:8px;">
              <button class="gl-store-tab" :class="{ active: !onlyDoubtful }" role="tab" :aria-selected="!onlyDoubtful" @click="onlyDoubtful = false">All</button>
              <button class="gl-store-tab" :class="{ active: onlyDoubtful }" role="tab" :aria-selected="onlyDoubtful" @click="onlyDoubtful = true"><span class="material-icons gl-warn" style="font-size:16px;vertical-align:middle;margin-right:3px;">warning</span>Needs a look ({{ doubtful.size }})</button>
            </div>
            <div v-if="showAll" class="gl-nutri-list">
              <div v-for="e in shownEntries" :key="e.id" class="gl-nutri-row" @click="editEntry(e)">
                <span class="truncate">{{ e.name }}<small v-if="problemsOf(e).length" class="gl-nutri-prev-problem" style="display:block;">{{ problemsOf(e)[0] }}</small></span>
                <span class="gl-nutri-row-meta"><template v-if="e.category === 'Non-food'">Non-food</template><template v-else>{{ n0(e.kcal) }} kcal</template> · {{ sourceLabel(e.source) }}</span>
                <span class="material-icons">chevron_right</span>
              </div>
            </div>
            <p class="gl-sheet-hint" style="margin-bottom:0;">Privacy: this app never sends your products anywhere. If you use an AI assistant to fill in the rest, only the names you choose go into the text you copy, and you decide where to paste it.</p>
          </div>
        </div>
      </div>
      </div>

      <div v-if="toast" class="gl-toast gl-toast--floating" role="status">{{ toast }}</div>

      <!-- Fill in with an AI assistant -->
      <div class="modal-overlay" :class="{ open: assist.open }" @click.self="closeAssist">
        <div class="modal">
          <div class="sheet-handle"></div>
          <div class="modal-header">
            <h2>Fill in with an AI assistant</h2>
            <button class="btn-icon" @click="closeAssist"><span class="material-icons">close</span></button>
          </div>
          <div class="modal-body">
            <p class="gl-sheet-hint">This app sends nothing. You copy a request, paste it into the assistant you prefer, then paste its answer back here. Values from an assistant are estimates, and are checked before they are saved.</p>

            <div class="sheet-section-title" style="padding-left:0;">1. Choose the products</div>
            <div class="gl-nutri-pick-head">
              <span>{{ assist.selected.length }} of {{ needingTitles.length }} selected</span>
              <button class="btn btn-text btn-sm" @click="toggleAllNames">{{ assist.selected.length === needingTitles.length ? 'None' : 'All' }}</button>
            </div>
            <div class="gl-nutri-pick">
              <div v-for="n in needingTitles" :key="n" class="gl-copy-field" @click="toggleName(n)">
                <span class="gl-check gl-check--square" :class="{ checked: assist.selected.includes(n) }" aria-hidden="true"><span class="gl-check-circle"><span class="material-icons">check</span></span></span>
                <span class="truncate">{{ n }}</span>
              </div>
            </div>
            <p class="gl-sheet-hint">Only the names that are ticked go into the request. Untick anything personal.</p>

            <div class="sheet-section-title" style="padding-left:0;margin-top:8px;">2. Copy the request</div>
            <button class="btn btn-primary btn-sm" :disabled="!assist.selected.length" @click="copyRequest">
              <span class="material-icons" style="font-size:18px;vertical-align:middle;margin-right:4px;">content_copy</span>{{ assist.copied ? 'Copied' : 'Copy request' }}
            </button>
            <div class="gl-nutri-links">
              <span>Then open:</span>
              <a v-for="a in ASSISTANTS" :key="a.name" :href="a.url" target="_blank" rel="noopener noreferrer">{{ a.name }}</a>
            </div>
            <details class="gl-nutri-details">
              <summary>Show exactly what will be copied</summary>
              <pre class="gl-copy-preview">{{ prompt }}</pre>
            </details>

            <div class="sheet-section-title" style="padding-left:0;margin-top:12px;">3. Paste the answer</div>
            <textarea class="form-input" v-model="assist.pasted" rows="5" placeholder="name,kcal,protein,carbs,fat,category,unit,grams_per_unit ..." style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;"></textarea>
            <button class="btn btn-text btn-sm" style="padding-left:0;" @click="pasteAnswer"><span class="material-icons" style="font-size:18px;vertical-align:middle;margin-right:4px;">content_paste</span>Paste from clipboard</button>

            <template v-if="parsed">
              <div class="gl-nutri-summary">
                <span v-if="parsedSummary.ok"><span class="material-icons gl-ok">check_circle</span>{{ parsedSummary.ok }} ready</span>
                <span v-if="parsedSummary.review"><span class="material-icons gl-warn">warning</span>{{ parsedSummary.review }} to double-check</span>
                <span v-if="parsedSummary.error"><span class="material-icons gl-bad">error</span>{{ parsedSummary.error }} skipped</span>
                <span v-if="parsedSummary.unanswered"><span class="material-icons">help_outline</span>{{ parsedSummary.unanswered }} not answered</span>
              </div>
              <div v-if="!parsed.rows.length" class="gl-sheet-hint">Nothing readable found. Ask the assistant for the CSV table only, then paste it again.</div>
              <div v-for="(r, idx) in parsed.rows" :key="idx" class="gl-nutri-prev" :class="'gl-nutri-prev--' + r.status">
                <div class="gl-nutri-prev-top">
                  <span class="material-icons" :class="r.status === 'ok' ? 'gl-ok' : r.status === 'review' ? 'gl-warn' : 'gl-bad'">{{ r.status === 'ok' ? 'check_circle' : r.status === 'review' ? 'warning' : 'error' }}</span>
                  <strong class="truncate">{{ r.entry.name }}</strong>
                  <span v-if="r.entry.category !== 'Non-food'" class="gl-nutri-prev-kcal">{{ n0(r.entry.kcal) }} kcal</span>
                </div>
                <div v-if="r.entry.category !== 'Non-food'" class="gl-nutri-prev-sub">P {{ r.entry.protein }} · C {{ r.entry.carbs }} · F {{ r.entry.fat }} g · {{ r.entry.category }} · {{ r.entry.unit }}<template v-if="r.entry.unit === 'piece' || r.entry.gramsPerUnit > 1"> · {{ r.entry.gramsPerUnit }} g each</template></div>
                <div v-else class="gl-nutri-prev-sub">Non-food (not counted)</div>
                <div v-for="p in r.problems" :key="p" class="gl-nutri-prev-problem">{{ p }}</div>
              </div>
            </template>
          </div>
          <div class="modal-footer">
            <button class="btn-sheet-cta" :disabled="!importable.length" @click="importAnswer">Import {{ importable.length }} {{ importable.length === 1 ? 'product' : 'products' }}</button>
            <div class="modal-footer-row"><button class="btn btn-text" @click="closeAssist">Cancel</button></div>
          </div>
        </div>
      </div>

      <!-- Edit one product -->
      <div class="modal-overlay" :class="{ open: form.open }" @click.self="closeForm">
        <div class="modal">
          <div class="sheet-handle"></div>
          <div class="modal-header">
            <h2>{{ form.isNew ? 'Add a product' : 'Edit product' }}</h2>
            <button class="btn-icon" @click="closeForm"><span class="material-icons">close</span></button>
          </div>
          <div class="modal-body" @click="form.openDropdown = null">
            <div class="form-group">
              <label class="form-label">Name</label>
              <input class="form-input" v-model="form.name" :readonly="!form.isNew" placeholder="Same name as on your list, e.g. Bananas" autocomplete="off" />
            </div>
            <div class="sheet-list-item">
              <label>Category</label>
              <valu-dropdown :open="form.openDropdown === 'cat'" @update:open="(v) => form.openDropdown = v ? 'cat' : null">
                <template #label>{{ form.category }}</template>
                <div v-for="c in categories" :key="c" class="valu-dropdown-option" :class="{ selected: form.category === c }" @click="form.category = c; form.openDropdown = null">{{ c }}</div>
              </valu-dropdown>
            </div>
            <template v-if="!formIsNonFood">
              <div class="sheet-section-title">Per 100 {{ form.unit === 'ml' ? 'ml' : 'g' }}</div>
              <div class="sheet-list-item"><label>Calories (kcal)</label><input v-model="form.kcal" type="text" inputmode="decimal" placeholder="0" /></div>
              <div class="sheet-list-item"><label>Protein (g)</label><input v-model="form.protein" type="text" inputmode="decimal" placeholder="0" /></div>
              <div class="sheet-list-item"><label>Carbs (g)</label><input v-model="form.carbs" type="text" inputmode="decimal" placeholder="0" /></div>
              <div class="sheet-list-item"><label>Fat (g)</label><input v-model="form.fat" type="text" inputmode="decimal" placeholder="0" /></div>
              <div class="sheet-section-title">Quantity</div>
              <div class="sheet-list-item">
                <label>Quantity is in</label>
                <valu-dropdown :open="form.openDropdown === 'unit'" @update:open="(v) => form.openDropdown = v ? 'unit' : null">
                  <template #label>{{ unitLabels[form.unit] }}</template>
                  <div v-for="u in units" :key="u" class="valu-dropdown-option" :class="{ selected: form.unit === u }" @click="form.unit = u; form.openDropdown = null">{{ unitLabels[u] }}</div>
                </valu-dropdown>
              </div>
              <div class="sheet-list-item">
                <label>{{ form.unit === 'piece' ? 'Grams per piece' : 'Grams per piece (optional)' }}</label>
                <input v-model="form.gramsPerUnit" type="text" inputmode="decimal" :placeholder="form.unit === 'piece' ? 'e.g. 50' : 'e.g. 120'" />
              </div>
              <p class="gl-sheet-hint">{{ form.unit === 'piece' ? 'A quantity of 12 on your list means 12 pieces. A large number (50 or more) is read as grams — e.g. a 750 g tub — so pack weights are not multiplied by the piece weight.' : 'A quantity of 500 means 500 ' + form.unit + '. A small number like 4 is read as pieces when a piece weight is given.' }}</p>
              <p v-if="formEnergyLine" class="gl-sheet-hint"><strong>{{ formEnergyLine }}</strong></p>
            </template>
            <p v-else class="gl-sheet-hint">Non-food products are left out of all the numbers.</p>
            <div v-for="p in formProblems" :key="p" class="gl-nutri-prev-problem" :class="{ 'gl-nutri-prev-problem--bad': formCheck.status === 'error' }">{{ p }}</div>
          </div>
          <div class="modal-footer">
            <button class="btn-sheet-cta" :disabled="formCheck.status === 'error'" @click="saveForm">Save</button>
            <div class="modal-footer-row">
              <button v-if="!form.isNew" class="btn btn-text btn-danger" @click="deleteForm">Delete</button>
              <button class="btn btn-text" @click="closeForm">Cancel</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  `,
};
