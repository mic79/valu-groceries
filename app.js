/* Valu Groceries app shell (Vue root component, auth wiring, navigation, groups).
 * Kept as an external module (not inline) so a strict Content-Security-Policy is possible. */
import GoogleAuth from './googleAuth.js';
import SheetsApi, { TABS, isDemoSheet, groupNameFromTitle } from './sheetsApi.js';
import { demoGroupMeta, getDemoSettings, DEMO_SHEET_ID } from './demoData.js';
import { rowToStore, guessBaseCurrency } from './groceryLogic.js';
import { SHEET_PREFIX, STORAGE_PREFIX } from './config.js';
import { loadStartPage } from './startPage.js';
import ValuOrb from './valu.js';
import { killValuAppLandingIntro } from './valu-landing-intro.js';
import ShoppingPage from './ShoppingPage.js';
import HistoryPage from './HistoryPage.js';
import HomePage from './HomePage.js';
import ActivityPage from './ActivityPage.js';
import NutritionPage from './NutritionPage.js';
import StoresPage from './StoresPage.js';
import GroupsPage from './GroupsPage.js';
import SettingsPage from './SettingsPage.js';
import FaqPage from './FaqPage.js';
import AboutPage from './AboutPage.js';
import ValuDateField from './ValuDateField.js';
import ValuDropdown from './ValuDropdown.js';
import ValuCurrencyPicker from './ValuCurrencyPicker.js';

const { createApp, ref, computed, watch, onMounted, nextTick, provide } = Vue;
const P = STORAGE_PREFIX;

const app = createApp({
  components: { ShoppingPage, HistoryPage, HomePage, ActivityPage, NutritionPage, StoresPage, GroupsPage, SettingsPage, FaqPage, AboutPage },

  setup() {
    // ── Auth state ──────────────────────────────────────────────────────
    const isAuthenticated = ref(false);
    const authLoading = ref(true);
    const userProfile = ref(null);
    const demoMode = ref(false);
    const landingShowCtas = ref(false);
    const showSignInFromLanding = ref(false);
    let ensureFirstGroupInFlight = false;
    const requestedDemo = new URLSearchParams(window.location.search).has('demo');

    // ── Group state ─────────────────────────────────────────────────────
    const groups = ref([]);
    const activeGroup = ref(null);
    const groupSettings = ref({});
    const storesList = ref([]);
    const groupLoading = ref(false);
    /** Bumps whenever another person changed the active sheet, so pages reload their data. */
    const changeTick = ref(0);

    // ── Navigation ──────────────────────────────────────────────────────
    const currentPage = ref('home');
    const sideNavOpen = ref(false);
    const showGroupSwitcher = ref(false);
    const dataLoaded = ref(false);
    const needsReconnect = ref(false);
    const swUpdateReady = ref(false);
    let waitingSW = null;
    let swRegistration = null;
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches
      || window.navigator.standalone === true;
    const appInstalled = ref(isStandalone || !!localStorage.getItem(P + 'app_installed'));
    const canInstall = computed(() => !appInstalled.value);
    let deferredInstallPrompt = null;

    const PAGE_MAP = {
      home: 'HomePage',
      groceries: 'ShoppingPage',
      history: 'HistoryPage',
      nutrition: 'NutritionPage',
      activity: 'ActivityPage',
      stores: 'StoresPage',
      groups: 'GroupsPage',
      settings: 'SettingsPage',
      faq: 'FaqPage',
      about: 'AboutPage',
    };

    const currentPageComponent = computed(() => PAGE_MAP[currentPage.value] || 'HomePage');
    const activeSheetId = computed(() => (activeGroup.value ? activeGroup.value.id : null));
    const activeGroupName = computed(() => (activeGroup.value ? groupNameFromTitle(activeGroup.value.name) : ''));
    const groupDisplayName = (g) => groupNameFromTitle(g.name);
    const inAppShell = computed(() => isAuthenticated.value || demoMode.value);

    const groupsForSwitcher = computed(() => {
      const real = groups.value.filter((g) => g.id !== DEMO_SHEET_ID);
      const demo = demoGroupMeta();
      if (!isAuthenticated.value && demoMode.value) return [demo];
      if (isAuthenticated.value) return [demo, ...real];
      return [demo];
    });

    const demoHomeCallout = computed(() => {
      if (!activeGroup.value || !isDemoSheet(activeGroup.value.id)) return 'none';
      if (!isAuthenticated.value) return 'signin';
      return 'readonly';
    });
    const demoNoticeDismissed = ref(false);
    watch(demoHomeCallout, () => { demoNoticeDismissed.value = false; });

    provide('activeSheetId', activeSheetId);
    provide('groupSettings', groupSettings);
    provide('activeGroup', activeGroup);
    provide('installBanner', { installed: appInstalled, install: () => installApp() });

    // ── Global dialog system (replaces native alert/confirm) ─────────
    const dialogVisible = ref(false);
    const dialogMessage = ref('');
    const dialogIsConfirm = ref(false);
    let dialogResolve = null;

    function showAlert(message) {
      return new Promise((resolve) => {
        dialogMessage.value = message;
        dialogIsConfirm.value = false;
        dialogResolve = resolve;
        dialogVisible.value = true;
      });
    }
    function showConfirm(message) {
      return new Promise((resolve) => {
        dialogMessage.value = message;
        dialogIsConfirm.value = true;
        dialogResolve = resolve;
        dialogVisible.value = true;
      });
    }
    function dialogOk() {
      dialogVisible.value = false;
      if (dialogResolve) dialogResolve(true);
      dialogResolve = null;
    }
    function dialogCancel() {
      dialogVisible.value = false;
      if (dialogResolve) dialogResolve(false);
      dialogResolve = null;
    }

    provide('showAlert', showAlert);
    provide('showConfirm', showConfirm);

    // ── Local cache (instant paint on the next launch) ───────────────
    function cacheSet(key, value) {
      try { localStorage.setItem(P + key, JSON.stringify(value)); } catch { /* storage full or blocked */ }
    }
    function cacheGet(key) {
      try { return JSON.parse(localStorage.getItem(P + key)); } catch { return null; }
    }
    function clearGroupCaches() {
      for (const k of ['groups_cache', 'settings_cache', 'stores_cache', 'last_group', 'last_group_name']) {
        localStorage.removeItem(P + k);
      }
    }

    // ── Hash-based routing ───────────────────────────────────────────
    let _navFromPopstate = false;
    function readHash() {
      const h = window.location.hash.replace('#', '');
      return PAGE_MAP[h] ? h : 'home';
    }
    watch(currentPage, (page) => {
      if (_navFromPopstate) { _navFromPopstate = false; return; }
      const hash = page === 'home' ? '' : '#' + page;
      if (window.location.hash !== hash) {
        history.pushState({ page }, '', hash || window.location.pathname + window.location.search);
      }
    });
    window.addEventListener('popstate', () => {
      _navFromPopstate = true;
      currentPage.value = readHash();
    });

    // Start page: the first time a group is ready after the app is opened, go to the page chosen in Settings.
    // A page named in the address (a link, a bookmark, a reload on that page) wins. The address is replaced, not
    // added, so Back leaves the app instead of returning to the Dashboard.
    let launchPending = true;
    watch(activeGroup, (g) => {
      if (!launchPending || !g) return;
      launchPending = false;
      if (window.location.hash.replace('#', '')) return;
      const start = loadStartPage();
      if (start === 'home' || !PAGE_MAP[start]) return;
      history.replaceState({ page: start }, '', '#' + start);
      currentPage.value = start;
    });

    async function navigateTo(page, opts) {
      const allowedWithoutGroup = page === 'home' || page === 'groups' || page === 'settings' || page === 'faq' || page === 'about';
      if (!activeGroup.value && !allowedWithoutGroup) {
        currentPage.value = 'home';
        return;
      }
      currentPage.value = page;
      if (opts && opts.scrollTo) {
        const tryScroll = (attempts) => {
          const el = document.getElementById(opts.scrollTo);
          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
          else if (attempts > 0) setTimeout(() => tryScroll(attempts - 1), 300);
        };
        nextTick(() => setTimeout(() => tryScroll(8), 200));
      }
      if (!dataLoaded.value && activeGroup.value) await loadGroupData();
    }

    // ── Group data ──────────────────────────────────────────────────────

    async function fetchGroupContent(id) {
      await SheetsApi.ensureSchema(id);
      const [settings, storeRows] = await Promise.all([
        SheetsApi.getSettings(id),
        SheetsApi.getTabData(id, TABS.STORES),
      ]);
      return { settings, stores: storeRows.map(rowToStore).filter((s) => s.id && s.name.trim()) };
    }

    function applyGroupContent({ settings, stores }) {
      groupSettings.value = settings;
      storesList.value = stores;
      cacheSet('settings_cache', settings);
      cacheSet('stores_cache', stores);
    }

    async function applyDemoShellState() {
      SheetsApi.stopChangeDetection();
      // Stores first, so the shopping page never mounts with an empty store list.
      try {
        const rows = await SheetsApi.getTabData(DEMO_SHEET_ID, TABS.STORES);
        storesList.value = rows.map(rowToStore).filter((s) => s.id);
      } catch { storesList.value = []; }
      groupSettings.value = getDemoSettings();
      activeGroup.value = demoGroupMeta();
      dataLoaded.value = true;
      groupLoading.value = false;
      needsReconnect.value = false;
    }

    function setupChangeDetection(sheetId) {
      SheetsApi.startChangeDetection([sheetId], async (changedId) => {
        if (changedId !== activeGroup.value?.id) return;
        try {
          applyGroupContent(await fetchGroupContent(changedId));
          changeTick.value++;
        } catch { /* the next poll tries again */ }
      });
    }

    async function startDemo() {
      killValuAppLandingIntro();
      demoMode.value = true;
      showSignInFromLanding.value = false;
      currentPage.value = 'home';
      await applyDemoShellState();
      currentPage.value = readHash(); // the group is ready, so any page named in the address can open
    }
    const startQuickLookDemo = startDemo;

    function leaveDemoToSignIn() {
      demoMode.value = false;
      sideNavOpen.value = false;
      activeGroup.value = null;
      groupSettings.value = {};
      storesList.value = [];
      dataLoaded.value = false;
      groupLoading.value = false;
      showSignInFromLanding.value = true;
      landingShowCtas.value = true;
      clearGroupCaches();
    }

    async function loadGroupData(background = false) {
      if (!activeGroup.value || dataLoaded.value) return;
      if (isDemoSheet(activeGroup.value.id)) { await applyDemoShellState(); return; }
      if (!background) groupLoading.value = true;
      needsReconnect.value = false;
      const id = activeGroup.value.id;
      try {
        applyGroupContent(await fetchGroupContent(id));
        dataLoaded.value = true;
        setupChangeDetection(id);
      } catch {
        if (!background) needsReconnect.value = true;
      } finally {
        groupLoading.value = false;
      }
    }

    async function refreshGroupsList() {
      try {
        const files = await SheetsApi.listSpreadsheets();
        groups.value = files;
        cacheSet('groups_cache', files);

        if (activeGroup.value && !isDemoSheet(activeGroup.value.id) && !files.find((f) => f.id === activeGroup.value.id)) {
          activeGroup.value = null;
          groupSettings.value = {};
          storesList.value = [];
          dataLoaded.value = false;
          groupLoading.value = false;
          clearGroupCaches();
          currentPage.value = 'groups';
        }

        if (isAuthenticated.value && !activeGroup.value && files.length > 0) {
          const lastId = localStorage.getItem(P + 'last_group');
          const defaultId = localStorage.getItem(P + 'default_group');
          const match = files.find((f) => f.id === lastId) || (defaultId && files.find((f) => f.id === defaultId));
          await switchGroup(match || files[0]);
        }

        // First sign-in: start with a ready-to-use list instead of an empty screen.
        if (isAuthenticated.value && files.length === 0 && userProfile.value?.email && !ensureFirstGroupInFlight) {
          ensureFirstGroupInFlight = true;
          try {
            const created = await SheetsApi.createSpreadsheet('My groceries', userProfile.value.email, { baseCurrency: guessBaseCurrency() });
            groups.value = [created];
            cacheSet('groups_cache', groups.value);
            await switchGroup(created);
          } catch {
            groupLoading.value = false;
            showAlert('Could not create your first list. Check your connection, then open Groups and tap Add group.');
          } finally {
            ensureFirstGroupInFlight = false;
          }
        }
      } catch { /* background refresh: try again next time */ }
    }

    async function switchGroup(group, navOptions = {}) {
      if (!group || !group.id) {
        currentPage.value = 'groups';
        return;
      }

      if (isDemoSheet(group.id)) {
        localStorage.setItem(P + 'last_group', group.id);
        localStorage.setItem(P + 'last_group_name', group.name || '');
        await applyDemoShellState();
        if (currentPage.value === 'groups' && !navOptions.keepOnGroupsPage) currentPage.value = 'home';
        return;
      }

      activeGroup.value = group;
      localStorage.setItem(P + 'last_group', group.id);
      localStorage.setItem(P + 'last_group_name', group.name || '');
      dataLoaded.value = false;
      groupLoading.value = true;
      storesList.value = [];

      try {
        applyGroupContent(await fetchGroupContent(group.id));
        dataLoaded.value = true;
        setupChangeDetection(group.id);
        if (currentPage.value === 'groups' && !navOptions.keepOnGroupsPage) currentPage.value = 'home';
      } catch (err) {
        if (err.message && (err.message.includes('404') || err.message.includes('403'))) {
          groups.value = groups.value.filter((g) => g.id !== group.id);
          cacheSet('groups_cache', groups.value);
          activeGroup.value = null;
          groupSettings.value = {};
          dataLoaded.value = false;
          clearGroupCaches();
          currentPage.value = 'groups';
        } else {
          needsReconnect.value = true;
        }
      } finally {
        groupLoading.value = false;
      }
    }

    function upsertGroup(entry) {
      const idx = groups.value.findIndex((g) => g.id === entry.id);
      if (idx >= 0) groups.value[idx] = { ...groups.value[idx], ...entry };
      else groups.value.push(entry);
      cacheSet('groups_cache', groups.value);
    }

    async function onGroupCreated(payload) {
      if (!payload || !payload.id) {
        showAlert('Failed to create group: no spreadsheet ID returned.');
        return;
      }
      const result = { id: payload.id, name: payload.name };
      upsertGroup(result);
      await switchGroup(result, { keepOnGroupsPage: payload.keepOnGroupsPage === true });
    }

    async function onSharedOpened(picked) {
      if (!picked || !picked.id) return;
      if (!String(picked.name || '').startsWith(SHEET_PREFIX)) {
        showAlert('That spreadsheet is not a Valu Groceries list. Pick one named "' + SHEET_PREFIX.trim() + ' ...".');
        return;
      }
      const entry = { id: picked.id, name: picked.name };
      const alreadyListed = groups.value.some((g) => g.id === entry.id);
      upsertGroup(entry);
      await switchGroup(entry);

      // A newly added group has no "Last modified" yet; fill it in right away.
      if (!alreadyListed && !isDemoSheet(entry.id)) {
        SheetsApi.getFileModifiedTime(entry.id).then((modifiedTime) => {
          const idx = groups.value.findIndex((g) => g.id === entry.id);
          if (idx >= 0 && modifiedTime && !groups.value[idx].modifiedTime) {
            groups.value[idx] = { ...groups.value[idx], modifiedTime };
            cacheSet('groups_cache', groups.value);
          }
        }).catch(() => {});
      }
    }

    function onStoresUpdated(list) {
      storesList.value = list;
      cacheSet('stores_cache', list);
    }

    function onSettingsUpdated(partial) {
      groupSettings.value = { ...groupSettings.value, ...partial };
      cacheSet('settings_cache', groupSettings.value);
      if (partial.groupName && activeGroup.value) {
        const newName = SHEET_PREFIX + partial.groupName;
        activeGroup.value = { ...activeGroup.value, name: newName };
        const idx = groups.value.findIndex((g) => g.id === activeGroup.value.id);
        if (idx >= 0) {
          groups.value[idx] = { ...groups.value[idx], name: newName };
          cacheSet('groups_cache', groups.value);
        }
      }
    }

    async function reconnect() {
      try {
        needsReconnect.value = false;
        await GoogleAuth.getAccessToken();
        if (activeGroup.value) {
          dataLoaded.value = false;
          await loadGroupData();
        }
      } catch {
        needsReconnect.value = true;
        GoogleAuth.connect();
      }
    }

    async function refreshCurrentPage() {
      if (!dataLoaded.value && activeGroup.value) { await loadGroupData(); return; }
      if (!activeGroup.value || isDemoSheet(activeGroup.value.id)) return;
      try {
        applyGroupContent(await fetchGroupContent(activeGroup.value.id));
        changeTick.value++;
      } catch { /* background refresh */ }
    }

    // ── Auth ────────────────────────────────────────────────────────────

    function onAuthChange(signedIn, profile) {
      isAuthenticated.value = signedIn;
      userProfile.value = profile;
      authLoading.value = false;

      if (signedIn) {
        killValuAppLandingIntro();
        showSignInFromLanding.value = false;

        // A different Google account on this device must not see the previous account's cached lists.
        const prevEmail = localStorage.getItem(P + 'last_user_email') || '';
        const curEmail = profile?.email || '';
        if (curEmail && curEmail !== prevEmail) {
          clearGroupCaches();
          localStorage.removeItem(P + 'default_group');
          groups.value = [];
          activeGroup.value = null;
          groupSettings.value = {};
          storesList.value = [];
          localStorage.setItem(P + 'last_user_email', curEmail);
        }

        if (requestedDemo) {
          demoMode.value = false;
          switchGroup(demoGroupMeta());
          refreshGroupsList();
          return;
        }

        demoMode.value = false;

        const cachedGroups = cacheGet('groups_cache');
        const cachedSettings = cacheGet('settings_cache');
        const cachedStores = cacheGet('stores_cache');
        let lastGroupId = localStorage.getItem(P + 'last_group');

        if (isDemoSheet(lastGroupId)) {
          lastGroupId = null;
          clearGroupCaches();
        }
        if (!lastGroupId) lastGroupId = localStorage.getItem(P + 'default_group');

        if (Array.isArray(cachedGroups)) groups.value = cachedGroups;

        const lastGroup = lastGroupId ? groups.value.find((g) => g.id === lastGroupId) : null;
        if (lastGroup && lastGroup.id && cachedSettings) {
          activeGroup.value = lastGroup;
          groupSettings.value = cachedSettings;
          storesList.value = Array.isArray(cachedStores) ? cachedStores : [];
          currentPage.value = readHash();
          groupLoading.value = false;
          loadGroupData(true);
        } else {
          activeGroup.value = null;
          groupSettings.value = {};
          storesList.value = [];
          dataLoaded.value = false;
          currentPage.value = 'home';
          groupLoading.value = true;
        }

        refreshGroupsList();
      } else if (!demoMode.value) {
        groups.value = [];
        activeGroup.value = null;
        groupSettings.value = {};
        storesList.value = [];
        dataLoaded.value = false;
        groupLoading.value = false;
        needsReconnect.value = false;
        currentPage.value = 'home';
        SheetsApi.stopChangeDetection();
        clearGroupCaches();
      }
    }

    function connect() {
      authLoading.value = true;
      setTimeout(() => { authLoading.value = false; }, 60000);
      GoogleAuth.connect();
    }

    function signOut() {
      sideNavOpen.value = false;
      GoogleAuth.signOut();
    }

    function applySwUpdate() {
      if (waitingSW) waitingSW.postMessage({ type: 'SKIP_WAITING' });
      else window.location.reload();
    }

    // ── PWA Install Prompt ───────────────────────────────────────────────

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredInstallPrompt = e;
    });
    window.addEventListener('appinstalled', () => {
      appInstalled.value = true;
      localStorage.setItem(P + 'app_installed', '1');
      deferredInstallPrompt = null;
    });

    function installApp() {
      if (deferredInstallPrompt) {
        deferredInstallPrompt.prompt();
        deferredInstallPrompt.userChoice.then((result) => {
          if (result.outcome === 'accepted') {
            appInstalled.value = true;
            localStorage.setItem(P + 'app_installed', '1');
          }
          deferredInstallPrompt = null;
        });
      } else {
        const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
        showAlert(isIOS
          ? 'To install Valu Groceries, tap the Share button in Safari, then "Add to Home Screen".'
          : 'To install Valu Groceries, open your browser menu and look for "Install app" or "Add to Home Screen".');
      }
    }

    // ── Init ────────────────────────────────────────────────────────────

    let _orbRafId = 0;
    function reinitOrbs() {
      cancelAnimationFrame(_orbRafId);
      nextTick(() => {
        cancelAnimationFrame(_orbRafId);
        _orbRafId = requestAnimationFrame(() => { ValuOrb.initAll(); });
      });
    }
    watch(isAuthenticated, reinitOrbs);
    watch(inAppShell, reinitOrbs);
    watch(currentPage, reinitOrbs);

    onMounted(() => {
      if (requestedDemo) {
        startDemo();
        window.history.replaceState({}, '', window.location.pathname + window.location.hash);
      } else {
        setTimeout(() => { landingShowCtas.value = true; }, 2000);
      }
      GoogleAuth.init(onAuthChange);
    });

    // ── Service Worker ──────────────────────────────────────────────────

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('service-worker.js', { updateViaCache: 'none' }).then((reg) => {
        swRegistration = reg;
        reg.update().catch(() => {});
        reg.addEventListener('updatefound', () => {
          const newSW = reg.installing;
          if (!newSW) return;
          newSW.addEventListener('statechange', () => {
            if (newSW.state === 'installed' && navigator.serviceWorker.controller) {
              waitingSW = newSW;
              swUpdateReady.value = true;
            }
          });
        });
      }).catch(() => {});

      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && swRegistration) swRegistration.update().catch(() => {});
      });

      // Reload once when an *updated* worker takes over. The very first install also fires
      // controllerchange (nothing controlled the page before), and reloading then would only
      // throw away what the user is already doing (e.g. the Quick look demo).
      const hadController = !!navigator.serviceWorker.controller;
      let reloading = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!hadController || reloading) return;
        reloading = true;
        window.location.reload();
      });
    }

    return {
      isAuthenticated, authLoading, userProfile,
      demoSheetId: DEMO_SHEET_ID, appVersion: window.VALU_VERSION || '',
      inAppShell, demoMode, landingShowCtas, showSignInFromLanding,
      groups, groupsForSwitcher, activeGroup, groupSettings, storesList, groupLoading, dataLoaded,
      currentPage, currentPageComponent, changeTick,
      activeSheetId, activeGroupName, groupDisplayName, sideNavOpen, showGroupSwitcher,
      demoHomeCallout, demoNoticeDismissed,
      needsReconnect, reconnect, connect, swUpdateReady, applySwUpdate, canInstall, installApp,
      navigateTo,
      onAuthChange, signOut,
      startQuickLookDemo, leaveDemoToSignIn,
      switchGroup, onGroupCreated, onSharedOpened,
      onStoresUpdated, onSettingsUpdated, refreshCurrentPage, refreshGroupsList,
      dialogVisible, dialogMessage, dialogIsConfirm, dialogOk, dialogCancel,
    };
  },
});

app.component('ValuDateField', ValuDateField);
app.component('ValuDropdown', ValuDropdown);
app.component('ValuCurrencyPicker', ValuCurrencyPicker);
app.mount('#app');

// ── Init Valu orb animations after first render ──────────────────────
requestAnimationFrame(() => {
  ValuOrb.initAll();
});

// ── Global sheet swipe-to-close ──────────────────────────────────────
(function () {
  const THRESHOLD = 80;

  document.addEventListener('touchstart', function onStart(e) {
    const handle = e.target.closest('.sheet-handle');
    if (!handle) return;
    const modal = handle.closest('.modal');
    if (!modal) return;

    const startY = e.touches[0].clientY;
    let currentY = startY;
    let dragging = false;

    function onMove(ev) {
      currentY = ev.touches[0].clientY;
      const dy = currentY - startY;
      if (dy > 0) {
        dragging = true;
        modal.style.transition = 'none';
        modal.style.transform = 'translateY(' + dy + 'px)';
      }
    }

    function onEnd() {
      const dy = currentY - startY;
      modal.style.transition = '';
      modal.style.transform = '';
      if (dragging && dy > THRESHOLD) {
        const closeBtn = modal.querySelector('.modal-header .btn-icon');
        if (closeBtn) closeBtn.click();
      }
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
    }

    document.addEventListener('touchmove', onMove, { passive: true });
    document.addEventListener('touchend', onEnd);
  }, { passive: true });
})();
