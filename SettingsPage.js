import GoogleAuth from './googleAuth.js';
import { STORAGE_PREFIX } from './config.js';
import { groupNameFromTitle } from './sheetsApi.js';
import { loadLayout, saveLayout, moveWidget as moveInLayout } from './homeLayout.js';

const { ref, computed, onMounted, inject } = Vue;
const P = STORAGE_PREFIX;

export default {
  props: ['groups', 'activeGroup'],
  emits: ['go-home', 'navigate'],

  setup() {
    const THEME_OPTIONS = [
      { value: 'auto', label: 'System default' },
      { value: 'light', label: 'Light' },
      { value: 'dark', label: 'Dark' },
    ];

    const NUMBER_FORMAT_OPTIONS = [
      { value: 'auto', label: 'System default' },
      { value: 'en-US', label: '1,234.56' },
      { value: 'de-DE', label: '1.234,56' },
    ];

    const theme = ref(localStorage.getItem(P + 'theme') || 'auto');
    const numberFormat = ref(localStorage.getItem(P + 'number_format') || 'auto');
    const defaultGroupId = ref(localStorage.getItem(P + 'default_group') || '');

    function applyTheme(mode) {
      const root = document.documentElement;
      const meta = document.querySelector('meta[name="theme-color"]');
      if (mode === 'dark') {
        root.setAttribute('data-theme', 'dark');
        if (meta) meta.setAttribute('content', '#211f1d');
      } else if (mode === 'light') {
        root.setAttribute('data-theme', 'light');
        if (meta) meta.setAttribute('content', '#729c9c');
      } else {
        root.removeAttribute('data-theme');
        const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        if (meta) meta.setAttribute('content', isDark ? '#211f1d' : '#729c9c');
      }
    }
    function saveTheme() {
      localStorage.setItem(P + 'theme', theme.value);
      applyTheme(theme.value);
    }
    function saveNumberFormat() {
      localStorage.setItem(P + 'number_format', numberFormat.value);
    }
    function saveDefaultGroup() {
      if (defaultGroupId.value) localStorage.setItem(P + 'default_group', defaultGroupId.value);
      else localStorage.removeItem(P + 'default_group');
    }

    onMounted(() => applyTheme(theme.value));

    // Home layout: which widgets show and in what order (kept on this device).
    const homeWidgets = ref(loadLayout());
    function toggleWidget(id) {
      const w = homeWidgets.value.find((x) => x.id === id);
      if (w) { w.enabled = !w.enabled; saveLayout(homeWidgets.value); }
    }
    function moveWidget(id, dir) {
      homeWidgets.value = moveInLayout(homeWidgets.value, id, dir);
      saveLayout(homeWidgets.value);
    }

    const openDropdown = ref(null);
    function toggleDropdown(name) {
      openDropdown.value = openDropdown.value === name ? null : name;
    }

    // ── Privacy: forget this device ─────────────────────────────────────
    const showConfirm = inject('showConfirm', null);
    const isSignedIn = computed(() => !!GoogleAuth.isSignedIn);
    async function forgetThisDevice() {
      const msg = 'Sign out, revoke Valu Groceries\u2019 access to your Google account, and erase everything it saved on this device? Your spreadsheets in Google Drive are not touched. You will need to approve access again the next time you sign in.';
      const ok = showConfirm ? await showConfirm(msg) : window.confirm(msg);
      if (!ok) return;
      await GoogleAuth.signOutAndForget();
      window.location.replace(window.location.pathname);
    }

    return {
      isSignedIn, forgetThisDevice, groupNameFromTitle, homeWidgets, toggleWidget, moveWidget,
      THEME_OPTIONS, NUMBER_FORMAT_OPTIONS, theme, numberFormat, defaultGroupId,
      openDropdown, toggleDropdown, saveTheme, saveNumberFormat, saveDefaultGroup,
    };
  },

  template: `
    <div class="subpage">
      <div class="subpage-scroll">
      <div class="subpage-nav">
        <button class="subpage-back subpage-back--colored" @click="$emit('go-home')">
          <span class="material-icons">arrow_back</span>
        </button>
        <h1 class="subpage-nav-title">Settings</h1>
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

      <div style="padding:0 16px 32px;">

        <div class="card mb-16" @click="openDropdown = null">
          <div class="card-header"><h3>Appearance</h3></div>
          <div class="card-body">
            <div class="form-dropdown" @click.stop>
              <button type="button" class="form-dropdown-trigger" @click="toggleDropdown('theme')">
                <span>{{ THEME_OPTIONS.find(o => o.value === theme)?.label || 'System default' }}</span>
                <span class="material-icons form-dropdown-arrow">expand_more</span>
              </button>
              <div class="form-dropdown-list" v-if="openDropdown === 'theme'">
                <div v-for="opt in THEME_OPTIONS" :key="opt.value"
                     class="form-dropdown-option" :class="{ selected: theme === opt.value }"
                     @click="theme = opt.value; saveTheme(); openDropdown = null">{{ opt.label }}</div>
              </div>
            </div>
          </div>
        </div>

        <div class="card mb-16" @click="openDropdown = null">
          <div class="card-header"><h3>Number Format</h3></div>
          <div class="card-body">
            <div class="form-dropdown" @click.stop>
              <button type="button" class="form-dropdown-trigger" @click="toggleDropdown('numberFormat')">
                <span>{{ NUMBER_FORMAT_OPTIONS.find(o => o.value === numberFormat)?.label || 'System default' }}</span>
                <span class="material-icons form-dropdown-arrow">expand_more</span>
              </button>
              <div class="form-dropdown-list" v-if="openDropdown === 'numberFormat'">
                <div v-for="opt in NUMBER_FORMAT_OPTIONS" :key="opt.value"
                     class="form-dropdown-option" :class="{ selected: numberFormat === opt.value }"
                     @click="numberFormat = opt.value; saveNumberFormat(); openDropdown = null">{{ opt.label }}</div>
              </div>
            </div>
            <p style="font-size:13px;color:var(--color-text-secondary);margin-top:8px;">
              Controls how prices are shown and typed (decimal and thousands separators). Currency symbol position is not affected.
            </p>
          </div>
        </div>

        <div class="card mb-16" v-if="groups && groups.length > 0" @click="openDropdown = null">
          <div class="card-header"><h3>Default Group</h3></div>
          <div class="card-body">
            <div class="form-dropdown" @click.stop>
              <button type="button" class="form-dropdown-trigger" @click="toggleDropdown('defaultGroup')">
                <span>{{ defaultGroupId ? (groupNameFromTitle(groups.find(g => g.id === defaultGroupId)?.name) || 'Last used group') : 'Last used group' }}</span>
                <span class="material-icons form-dropdown-arrow">expand_more</span>
              </button>
              <div class="form-dropdown-list" v-if="openDropdown === 'defaultGroup'">
                <div class="form-dropdown-option" :class="{ selected: !defaultGroupId }"
                     @click="defaultGroupId = ''; saveDefaultGroup(); openDropdown = null">Last used group</div>
                <div v-for="g in groups" :key="g.id"
                     class="form-dropdown-option" :class="{ selected: defaultGroupId === g.id }"
                     @click="defaultGroupId = g.id; saveDefaultGroup(); openDropdown = null">{{ groupNameFromTitle(g.name) }}</div>
              </div>
            </div>
            <p style="font-size:13px;color:var(--color-text-secondary);margin-top:8px;">
              The group to open when you start the app.
            </p>
          </div>
        </div>

        <div class="card mb-16">
          <div class="card-header"><h3><span class="material-icons" style="font-size:18px;vertical-align:text-bottom;margin-right:4px;">dashboard_customize</span>Home layout</h3></div>
          <div class="card-body" style="padding:0;">
            <div v-for="(w, idx) in homeWidgets" :key="w.id" class="home-layout-item">
              <span class="material-icons home-layout-icon">{{ w.icon }}</span>
              <div class="home-layout-label">
                <span>{{ w.label }}</span>
                <span v-if="w.hint" class="home-layout-hint">{{ w.hint }}</span>
              </div>
              <label class="toggle toggle-sm" @click.stop>
                <input type="checkbox" :checked="w.enabled" :aria-label="'Show ' + w.label" @change="toggleWidget(w.id)" />
                <div class="toggle-track"></div>
                <div class="toggle-thumb"></div>
              </label>
              <div class="home-layout-arrows">
                <button type="button" class="home-layout-arrow" :disabled="idx === 0" :aria-label="'Move ' + w.label + ' up'" @click="moveWidget(w.id, -1)">
                  <span class="material-icons">keyboard_arrow_up</span>
                </button>
                <button type="button" class="home-layout-arrow" :disabled="idx === homeWidgets.length - 1" :aria-label="'Move ' + w.label + ' down'" @click="moveWidget(w.id, 1)">
                  <span class="material-icons">keyboard_arrow_down</span>
                </button>
              </div>
            </div>
            <p style="font-size:12px;color:var(--color-text-hint);padding:8px 16px 12px;">
              Choose which widgets appear on the Home page and in what order. This is remembered on this device.
            </p>
          </div>
        </div>

        <div class="card mb-16">
          <div class="card-header"><h3>This group</h3></div>
          <div class="card-body">
            <button type="button" class="btn btn-outline" @click="$emit('navigate', 'groups')">
              <span class="material-icons" style="font-size:18px;vertical-align:middle;margin-right:4px;">tune</span>Currency, price tracking and sharing
            </button>
            <p style="font-size:13px;color:var(--color-text-secondary);margin-top:8px;">
              Base currency, fallback exchange rates and price tracking are set per group in Groups.
            </p>
          </div>
        </div>

        <div class="card mb-16" v-if="isSignedIn">
          <div class="card-header"><h3>Privacy</h3></div>
          <div class="card-body">
            <button type="button" class="btn btn-outline" @click="forgetThisDevice">
              <span class="material-icons" style="font-size:18px;vertical-align:middle;margin-right:4px;">delete_forever</span>Sign out &amp; forget this device
            </button>
            <p style="font-size:13px;color:var(--color-text-secondary);margin-top:8px;">
              Best for shared or borrowed devices. Revokes Valu Groceries&rsquo; access to your Google account and erases everything it saved in this browser. Your spreadsheets are not touched.
            </p>
          </div>
        </div>

      </div>
      </div>
    </div>
  `,
};
