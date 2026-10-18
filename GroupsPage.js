/**
 * Groups page: your lists (one Google Sheet each), creating and opening shared ones, per-group
 * settings (name, base currency, price tracking, Nutrition, fallback exchange rates), and the one-time
 * import from the old Nutri app.
 */

import SheetsApi, { isDemoSheet, CURRENCIES, groupNameFromTitle } from './sheetsApi.js';
import GoogleAuth from './googleAuth.js';
import { importFromNutri } from './importNutri.js';
import { guessBaseCurrency, parseCurrencyRates } from './groceryLogic.js';
import { SHEET_PREFIX } from './config.js';

const { ref, computed, inject } = Vue;

export default {
  props: ['groups', 'activeGroup', 'userProfile', 'settings'],
  emits: ['switch-group', 'create-group', 'refresh-groups', 'open-shared', 'settings-updated', 'refresh', 'go-home', 'navigate'],

  setup(props, { emit }) {
    const showAlert = inject('showAlert', (m) => window.alert(m));
    const showConfirm = inject('showConfirm', (m) => Promise.resolve(window.confirm(m)));
    const creating = ref(false);
    const loading = ref(false);
    const importing = ref(false);
    const sortMode = ref('modified');

    // Group config sheet state
    const showConfigSheet = ref(false);
    const configIsNewGroup = ref(false);
    const configGroupId = ref(null);
    const configSaving = ref(false);
    const configGroupName = ref('');
    const configBaseCurrency = ref('USD');
    const configTrackPrices = ref(true);
    const configTrackNutrition = ref(true);
    const configCurrencyRates = ref([]);
    const newRateCurrency = ref('');
    const newRateValue = ref('');
    const currencyDropdownOpen = ref(false);
    const currencySearch = ref('');

    const isActiveGroupConfig = computed(() => !!props.activeGroup && configGroupId.value === props.activeGroup.id);

    const filteredCurrencies = computed(() => {
      const q = currencySearch.value.toLowerCase();
      if (!q) return CURRENCIES;
      return CURRENCIES.filter((c) => c.name.toLowerCase().includes(q) || c.code.toLowerCase().includes(q));
    });
    function currencyName(code) {
      const found = CURRENCIES.find((c) => c.code === code);
      return found ? found.code + ' · ' + found.name : code;
    }

    const displayGroups = computed(() => {
      const list = [...(props.groups || [])];
      if (sortMode.value === 'name') {
        list.sort((a, b) => groupNameFromTitle(a.name).localeCompare(groupNameFromTitle(b.name), undefined, { sensitivity: 'base' }));
      } else {
        list.sort((a, b) => new Date(b.modifiedTime) - new Date(a.modifiedTime));
      }
      return list;
    });
    function toggleSortMode() { sortMode.value = sortMode.value === 'modified' ? 'name' : 'modified'; }

    function formatDate(isoString) {
      if (!isoString) return '';
      return new Date(isoString).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    }

    function refreshGroups() {
      loading.value = true;
      emit('refresh-groups');
      setTimeout(() => { loading.value = false; }, 1500);
    }

    // ── New group ─────────────────────────────────────────────────────────────
    function openNewGroupFlow() {
      configIsNewGroup.value = true;
      configGroupId.value = null;
      configGroupName.value = '';
      configBaseCurrency.value = guessBaseCurrency();
      configTrackPrices.value = true;
      configTrackNutrition.value = true;
      configCurrencyRates.value = [];
      newRateCurrency.value = ''; newRateValue.value = '';
      currencyDropdownOpen.value = false; currencySearch.value = '';
      showConfigSheet.value = true;
    }

    async function submitNewGroup() {
      const name = configGroupName.value.trim();
      if (!name || creating.value) return;
      creating.value = true;
      try {
        const result = await SheetsApi.createSpreadsheet(name, props.userProfile?.email || '', {
          baseCurrency: configBaseCurrency.value,
          trackPrices: configTrackPrices.value ? 'true' : 'false',
          trackNutrition: configTrackNutrition.value ? 'true' : 'false',
          currencyRates: configCurrencyRates.value.map((r) => `${r.currency}:${r.rate}`).join(','),
        });
        configIsNewGroup.value = false;
        showConfigSheet.value = false;
        emit('create-group', { id: result.id, name: result.name, keepOnGroupsPage: true });
      } catch (err) {
        showAlert('Failed to create group: ' + err.message);
      } finally {
        creating.value = false;
      }
    }

    async function openSharedSheet() {
      try {
        const picked = await GoogleAuth.showPicker();
        if (picked) emit('open-shared', picked);
      } catch (err) {
        showAlert('Failed to open picker: ' + err.message);
      }
    }

    // ── Existing group ────────────────────────────────────────────────────────
    async function openGroupConfig(group) {
      configIsNewGroup.value = false;
      configGroupId.value = group.id;
      showConfigSheet.value = true;

      if (isDemoSheet(group.id) && (!props.activeGroup || props.activeGroup.id !== group.id)) {
        emit('switch-group', group, { keepOnGroupsPage: true });
      }

      try {
        const s = await SheetsApi.getSettings(group.id);
        configGroupName.value = s.groupName || groupNameFromTitle(group.name);
        configBaseCurrency.value = s.baseCurrency || 'USD';
        configTrackPrices.value = (s.trackPrices ?? 'true') !== 'false';
        configTrackNutrition.value = (s.trackNutrition ?? 'true') !== 'false';
        configCurrencyRates.value = parseCurrencyRates(s.currencyRates).filter((r) => r.currency);
      } catch (err) {
        showAlert('Failed to load group configuration: ' + err.message);
        showConfigSheet.value = false;
      }
    }

    async function saveConfigField(key, value) {
      if (!configGroupId.value || configIsNewGroup.value) return;
      configSaving.value = true;
      try {
        await SheetsApi.updateSetting(configGroupId.value, key, value);
        if (isActiveGroupConfig.value) emit('settings-updated', { [key]: value });
      } catch (err) {
        showAlert('Failed to save: ' + err.message);
      } finally {
        configSaving.value = false;
      }
    }

    async function saveConfigGroupName() {
      const name = configGroupName.value.trim();
      if (!name || configIsNewGroup.value) return;
      await saveConfigField('groupName', name);
      try {
        await SheetsApi.renameSpreadsheet(configGroupId.value, SHEET_PREFIX + name);
        if (!isActiveGroupConfig.value) emit('refresh-groups');
      } catch { /* the settings name is saved; the file name catches up on the next rename */ }
    }

    function selectConfigBaseCurrency(code) {
      configBaseCurrency.value = code;
      currencyDropdownOpen.value = false;
      saveConfigField('baseCurrency', code);
    }

    function toggleTrackPrices() {
      configTrackPrices.value = !configTrackPrices.value;
      saveConfigField('trackPrices', configTrackPrices.value ? 'true' : 'false');
    }
    function toggleTrackNutrition() {
      configTrackNutrition.value = !configTrackNutrition.value;
      saveConfigField('trackNutrition', configTrackNutrition.value ? 'true' : 'false');
    }

    function ratesToString() { return configCurrencyRates.value.map((r) => `${r.currency}:${r.rate}`).join(','); }

    function addConfigCurrencyRate() {
      const cur = newRateCurrency.value.trim().toUpperCase();
      const val = newRateValue.value.trim().replace(',', '.');
      if (!/^[A-Z]{3}$/.test(cur) || !(parseFloat(val) > 0)) { showAlert('Enter a 3-letter currency code and a rate above zero.'); return; }
      const existing = configCurrencyRates.value.findIndex((r) => r.currency === cur);
      if (existing >= 0) configCurrencyRates.value[existing].rate = val;
      else configCurrencyRates.value.push({ currency: cur, rate: val });
      newRateCurrency.value = ''; newRateValue.value = '';
      saveConfigField('currencyRates', ratesToString());
    }

    function removeConfigCurrencyRate(index) {
      configCurrencyRates.value.splice(index, 1);
      saveConfigField('currencyRates', ratesToString());
    }

    // ── Import from the old Nutri app ─────────────────────────────────────────
    async function importFromOldNutri() {
      const targetId = configGroupId.value;
      if (!targetId || isDemoSheet(targetId)) { showAlert('Import works with your own groups, not the demo.'); return; }
      let picked = null;
      try {
        picked = await GoogleAuth.showPicker('GroceriesApp', 'Select your old Nutri sheet');
      } catch (err) {
        showAlert('Failed to open picker: ' + err.message);
        return;
      }
      if (!picked) return;
      if (!(await showConfirm('Copy the lists, history and nutrition data from "' + picked.name + '" into this group? The old sheet is not changed, and importing twice never creates duplicates.'))) return;
      importing.value = true;
      try {
        const r = await importFromNutri(targetId, picked.id);
        if (isActiveGroupConfig.value) emit('refresh');
        const parts = [`${r.items} item${r.items === 1 ? '' : 's'}`, `${r.stores} store${r.stores === 1 ? '' : 's'}`];
        if (r.nutrition) parts.push(`${r.nutrition} nutrition entr${r.nutrition === 1 ? 'y' : 'ies'}`);
        const last = parts.pop();
        let msg = `Imported ${parts.join(', ')} and ${last}.`;
        if (r.nutritionReview) {
          const why = Object.entries(r.nutritionReasons || {}).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${k}`).join(', ');
          msg += ` ${r.nutritionReview} of the nutrition entries need a look` + (why ? ` (${why})` : '') + `. On the Nutrition page, tap Show list, then "Needs a look".`;
        }
        if (r.nutritionSkipped) msg += ` ${r.nutritionSkipped} nutrition ${r.nutritionSkipped === 1 ? 'row' : 'rows'} had impossible values and ${r.nutritionSkipped === 1 ? 'was' : 'were'} left out.`;
        if (r.skipped) msg += ` ${r.skipped} were already here and were skipped.`;
        showAlert(msg);
      } catch (err) {
        showAlert('Import failed: ' + err.message);
      } finally {
        importing.value = false;
      }
    }

    return {
      creating, loading, importing, sortMode, toggleSortMode, displayGroups, formatDate, refreshGroups,
      groupNameFromTitle,
      showConfigSheet, configIsNewGroup, configGroupId, configSaving, configGroupName, configBaseCurrency,
      configTrackPrices, configTrackNutrition, configCurrencyRates, newRateCurrency, newRateValue, currencyDropdownOpen, currencySearch,
      filteredCurrencies, currencyName,
      openNewGroupFlow, submitNewGroup, openSharedSheet, openGroupConfig, saveConfigGroupName,
      selectConfigBaseCurrency, toggleTrackPrices, toggleTrackNutrition, addConfigCurrencyRate, removeConfigCurrencyRate,
      importFromOldNutri,
      switchGroup: (g) => emit('switch-group', g),
    };
  },

  template: `
    <div class="subpage">
      <div class="subpage-scroll">
      <div class="subpage-nav">
        <button class="subpage-back subpage-back--colored" @click="$emit('go-home')">
          <span class="material-icons">arrow_back</span>
        </button>
        <h1 class="subpage-nav-title">Groups</h1>
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

      <div class="subpage-header">
        <button type="button" class="btn-icon subpage-header-refresh" @click="refreshGroups" :disabled="loading" aria-label="Refresh groups from Drive">
          <span class="material-icons" :class="{ 'groups-refresh-spin': loading }" style="font-size:18px;">refresh</span>
        </button>
      </div>

      <div v-if="displayGroups.length > 1" class="groups-sort-bar">
        <button type="button" class="groups-sort-btn" @click="toggleSortMode">
          <span class="material-icons">filter_list</span>
          <span>Sort</span>
          <span class="groups-sort-mode">{{ sortMode === 'name' ? 'A–Z' : 'Recent' }}</span>
        </button>
      </div>

      <div class="groups-page-body">
        <div v-if="loading && displayGroups.length === 0" class="loading" style="padding-top:24px;"><div class="spinner"></div>Loading groups...</div>

        <div v-else-if="displayGroups.length === 0 && !loading" class="empty-state groups-empty-state">
          <span class="material-icons">group</span>
          <h3>No groups yet</h3>
          <p>Create a group for your shopping lists, or open a shared one.</p>
        </div>

        <div v-else class="valu-list groups-valu-list">
          <div v-for="group in displayGroups" :key="group.id" role="button" tabindex="0" class="valu-list-card groups-list-card"
               @click="openGroupConfig(group)" @keydown.enter="openGroupConfig(group)">
            <div class="valu-list-row">
              <span class="valu-list-name">{{ groupNameFromTitle(group.name) }}</span>
            </div>
            <div class="valu-list-row-sub groups-card-sub">
              <span class="valu-list-sub">Last modified {{ formatDate(group.modifiedTime) }}</span>
              <span v-if="activeGroup && activeGroup.id === group.id" class="groups-active-pill">Active</span>
              <button v-else type="button" class="btn-text-sm" style="padding:2px 8px;" @click.stop="switchGroup(group)">Open</button>
            </div>
          </div>
        </div>
      </div>

      <div class="subpage-bottom-fixed subpage-bottom-fixed--stack">
        <button type="button" class="btn-add-outline" @click="openNewGroupFlow">ADD GROUP</button>
        <button type="button" class="btn-add-outline btn-add-outline--muted" @click="openSharedSheet">OPEN SHARED GROUP</button>

        <div class="groups-share-hint">
          <span class="material-icons groups-share-hint-icon">people</span>
          <p><strong>Shop together?</strong> Open Google Drive, find the spreadsheet named <strong>Valu Groceries: [Group]</strong>, and share it with someone. They can then open it here via "Open shared group". Changes show up on both phones.</p>
        </div>
      </div>
      </div>

      <!-- Group config sheet (existing groups + single-step new group) -->
      <div class="modal-overlay" :class="{ open: showConfigSheet }" @click.self="!creating && (showConfigSheet = false)">
        <div class="modal">
          <div class="sheet-handle"></div>
          <div class="modal-header">
            <h2>{{ configIsNewGroup ? 'New group' : 'Group Configuration' }}</h2>
            <button class="btn-icon" @click="!creating && (showConfigSheet = false)" :disabled="creating">
              <span class="material-icons">close</span>
            </button>
          </div>

          <div class="modal-body">
            <div class="card mb-16">
              <div class="card-header"><h3>Group Name</h3></div>
              <div class="card-body">
                <div class="flex gap-8">
                  <input class="form-input flex-1" v-model="configGroupName" @blur="saveConfigGroupName" @keyup.enter="configIsNewGroup ? submitNewGroup() : saveConfigGroupName()" />
                </div>
                <p v-if="configIsNewGroup" style="font-size:13px;color:var(--color-text-secondary);margin-top:8px;">
                  A Google Sheet is created in your Drive when you tap Create group below.
                </p>
              </div>
            </div>

            <div class="card mb-16">
              <div class="card-header"><h3>Base Currency</h3></div>
              <div class="card-body">
                <valu-currency-picker v-model:open="currencyDropdownOpen" v-model:search="currencySearch">
                  <template #label>{{ currencyName(configBaseCurrency) }}</template>
                  <div v-for="c in filteredCurrencies" :key="c.code"
                       class="currency-picker-option" :class="{ selected: c.code === configBaseCurrency }"
                       @click="selectConfigBaseCurrency(c.code)">{{ c.code }} · {{ c.name }}</div>
                  <div v-if="filteredCurrencies.length === 0" class="currency-picker-empty">No match</div>
                </valu-currency-picker>
                <p style="font-size:13px;color:var(--color-text-secondary);margin-top:8px;">
                  All prices are stored and shown in this currency. A price typed in another currency is converted with that day's exchange rate.
                </p>
              </div>
            </div>

            <div class="card mb-16">
              <div class="card-header"><h3>Prices</h3></div>
              <div class="card-body" style="padding:0;">
                <div class="list-item">
                  <div class="list-item-content">
                    <div class="list-item-title">Keep track of prices</div>
                    <div class="list-item-subtitle">Add prices to items and see what you spend in History and on the Home page</div>
                  </div>
                  <label class="toggle">
                    <input type="checkbox" :checked="configTrackPrices" @change="toggleTrackPrices" />
                    <div class="toggle-track"></div>
                    <div class="toggle-thumb"></div>
                  </label>
                </div>
              </div>
            </div>


            <div class="card mb-16">
              <div class="card-header"><h3>Nutrition</h3></div>
              <div class="card-body" style="padding:0;">
                <div class="list-item">
                  <div class="list-item-content">
                    <div class="list-item-title">Keep track of nutrition</div>
                    <div class="list-item-subtitle">Calories, protein, carbs and fat of what this group buys. Off for everyone sharing this group.</div>
                  </div>
                  <label class="toggle">
                    <input type="checkbox" :checked="configTrackNutrition" @change="toggleTrackNutrition" />
                    <div class="toggle-track"></div>
                    <div class="toggle-thumb"></div>
                  </label>
                </div>
              </div>
            </div>
            <div class="card mb-16" v-if="configTrackPrices">
              <div class="card-header"><h3>Fallback Rates</h3></div>
              <div class="card-body">
                <p style="font-size:13px;color:var(--color-text-secondary);margin-bottom:12px;">
                  Exchange rates are fetched automatically when you enter a price in another currency. These manual rates are used as a fallback if the rate service is unavailable.
                </p>
                <div v-for="(r, i) in configCurrencyRates" :key="i" class="flex items-center gap-8 mb-8">
                  <span style="font-size:14px;font-weight:500;min-width:40px;">{{ r.currency }}</span>
                  <span style="font-size:13px;color:var(--color-text-secondary);flex:1;">= {{ r.rate }} {{ configBaseCurrency }}</span>
                  <button class="btn-icon btn-danger" @click="removeConfigCurrencyRate(i)">
                    <span class="material-icons" style="font-size:18px;">close</span>
                  </button>
                </div>
                <div class="flex gap-8 mt-8">
                  <input class="form-input" v-model="newRateCurrency" placeholder="USD" maxlength="3" style="width:70px;" />
                  <input class="form-input flex-1" v-model="newRateValue" placeholder="Rate" inputmode="decimal" />
                  <button class="btn btn-outline" @click="addConfigCurrencyRate" :disabled="!newRateCurrency || !newRateValue">Add</button>
                </div>
              </div>
            </div>

            <div class="card mb-16" v-if="!configIsNewGroup">
              <div class="card-header"><h3>Import from Nutri</h3></div>
              <div class="card-body">
                <p style="font-size:13px;color:var(--color-text-secondary);margin-bottom:12px;">
                  Coming from the old Nutri app? Pick its Google Sheet and your stores, lists, history and nutrition data are copied into this group. The old sheet is not changed.
                </p>
                <button class="btn btn-outline" :disabled="importing" @click="importFromOldNutri">
                  <span class="material-icons" style="font-size:18px;vertical-align:middle;margin-right:4px;">upload_file</span>{{ importing ? 'Importing…' : 'Choose Nutri sheet' }}
                </button>
              </div>
            </div>

            <div v-if="configSaving && !configIsNewGroup" style="text-align:center;padding:8px;font-size:13px;color:var(--color-text-hint);">
              Saving...
            </div>
          </div>

          <div v-if="configIsNewGroup" class="modal-footer">
            <button type="button" class="btn-sheet-cta" @click="submitNewGroup" :disabled="!configGroupName.trim() || creating">
              {{ creating ? 'Creating...' : 'Create group' }}
            </button>
          </div>
        </div>
      </div>
    </div>
  `,
};
