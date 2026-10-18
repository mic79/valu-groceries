/**
 * Google OAuth2 — Authorization Code Flow with Cloudflare Worker.
 *
 * Uses the standard OAuth2 authorization code flow with a Cloudflare Worker
 * for the server-side token exchange, enabling long-lived refresh tokens
 * for seamless, persistent authentication.
 *
 * Sign-in flow (one-time):
 *  1. User clicks "Sign in" → redirect to Google consent screen
 *  2. Google redirects back with ?code=...
 *  3. Code sent to Worker → returns access token + encrypted refresh token
 *  4. Encrypted refresh token stored in localStorage
 *
 * Subsequent visits (seamless):
 *  1. Page loads → finds encrypted refresh token in localStorage
 *  2. Calls Worker /auth/refresh → gets fresh access token
 *  3. User is signed in with zero interaction
 */

// ── Configuration (edit config.js, not this file) ─────────────────────────────

import { CLIENT_ID, API_KEY, WORKER_URL, USE_PKCE, SHEET_PREFIX, STORAGE_PREFIX } from './config.js';

const SCOPES = 'https://www.googleapis.com/auth/drive.file openid email profile';

/** Every localStorage key starts with this, so the app never collides with Valu Finance on the same origin. */
const P = STORAGE_PREFIX;

/** Where the encrypted refresh token is kept. */
const REFRESH_KEY = P + 'encrypted_refresh';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

/** localStorage keys that hold cached copies of the user's data (safe to drop: re-fetched from the Sheet). */
const CACHED_DATA_KEY_PREFIXES = [
  P + 'chats_',
];
const CACHED_DATA_KEYS = [
  P + 'groups_cache', P + 'settings_cache', P + 'last_group', P + 'last_group_name',
  P + 'oauth_state', P + 'oauth_verifier',
];

let accessToken    = null;
let userProfile    = null;
let _onAuthChange  = null;
let _pendingRefresh = null;
let _refreshTimer  = null;
let _signedOut     = false;

// ── Storage helpers ───────────────────────────────────────────────────────────

function persistSession(profile) {
  if (profile) {
    localStorage.setItem(P + 'user_email', profile.email);
    localStorage.setItem(P + 'user_name', profile.name);
    localStorage.setItem(P + 'user_picture', profile.picture || '');
    localStorage.setItem(P + 'credential', JSON.stringify(profile));
  } else {
    localStorage.removeItem(P + 'user_email');
    localStorage.removeItem(P + 'user_name');
    localStorage.removeItem(P + 'user_picture');
    localStorage.removeItem(P + 'credential');
    localStorage.removeItem(P + 'last_group');
    localStorage.removeItem(P + 'last_group_name');
  }
}

function getStoredProfile() {
  try {
    return JSON.parse(localStorage.getItem(P + 'credential'));
  } catch {
    return null;
  }
}

function cacheToken(token, expiresIn) {
  localStorage.setItem(P + 'access_token', token);
  localStorage.setItem(P + 'token_expiry', String(Date.now() + ((expiresIn || 3600) * 1000)));
}

function getCachedToken() {
  const token = localStorage.getItem(P + 'access_token');
  const expiry = parseInt(localStorage.getItem(P + 'token_expiry') || '0', 10);
  if (token && Date.now() < expiry - 60000) {
    return token;
  }
  return null;
}

function clearAllTokens(revokeRefresh = false) {
  localStorage.removeItem(P + 'access_token');
  localStorage.removeItem(P + 'token_expiry');
  if (revokeRefresh) {
    localStorage.removeItem(REFRESH_KEY);
  }
  sessionStorage.removeItem(P + 'access_token');
  sessionStorage.removeItem(P + 'token_expiry');
}

/** Remove cached copies of the user's data (chats, groups, settings) from this browser. */
function clearCachedUserData() {
  for (const k of CACHED_DATA_KEYS) localStorage.removeItem(k);
  for (const k of Object.keys(localStorage)) {
    if (CACHED_DATA_KEY_PREFIXES.some(p => k.startsWith(p))) localStorage.removeItem(k);
  }
}

// ── PKCE helpers ──────────────────────────────────────────────────────────────

function base64Url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomVerifier() {
  return base64Url(crypto.getRandomValues(new Uint8Array(48)));
}

async function challengeFor(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

function getRedirectUri() {
  let path = window.location.pathname;
  path = path.replace(/\/index\.html$/, '/');
  if (path === '/') return window.location.origin;
  return window.location.origin + path;
}

async function fetchUserInfo(token) {
  const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error('Failed to fetch user info');
  const data = await res.json();
  return {
    email: data.email,
    name: data.name,
    picture: data.picture || '',
    sub: data.sub,
  };
}

// ── Worker communication ──────────────────────────────────────────────────────

async function exchangeCodeForTokens(code) {
  const redirectUri = getRedirectUri();
  const payload = { code, redirect_uri: redirectUri };
  const verifier = localStorage.getItem(P + 'oauth_verifier');
  localStorage.removeItem(P + 'oauth_verifier');
  if (USE_PKCE && verifier) payload.code_verifier = verifier;
  const res = await fetch(`${WORKER_URL}/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    let msg = `Token exchange failed (${res.status})`;
    try { const d = await res.json(); msg = d.error_description || d.error || msg; } catch {}
    throw new Error(msg);
  }
  const data = await res.json();
  if (data.error) {
    throw new Error(data.error_description || data.error);
  }
  return data;
}

async function refreshViaWorker(encryptedRefreshToken) {
  const res = await fetch(`${WORKER_URL}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ encrypted_refresh_token: encryptedRefreshToken }),
  });
  if (!res.ok) {
    let msg = `Token refresh failed (${res.status})`;
    try { const d = await res.json(); msg = d.error || msg; } catch {}
    throw new Error(msg);
  }
  const data = await res.json();
  if (data.error) {
    throw new Error(data.error);
  }
  return data;
}

// ── Proactive refresh ─────────────────────────────────────────────────────────

function scheduleRefresh(expiresIn) {
  if (_refreshTimer) clearTimeout(_refreshTimer);
  const refreshMs = Math.max((expiresIn - 300) * 1000, 60000);
  _refreshTimer = setTimeout(() => silentRefresh(), refreshMs);
}

async function silentRefresh() {
  const encryptedRefresh = localStorage.getItem(REFRESH_KEY);
  if (!encryptedRefresh) return;

  try {
    const result = await refreshViaWorker(encryptedRefresh);
    if (_signedOut) return;
    accessToken = result.access_token;
    cacheToken(result.access_token, result.expires_in);
    scheduleRefresh(result.expires_in);
  } catch (err) {
    console.warn('Silent token refresh failed:', err.message);
    if (!_signedOut) accessToken = null;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

const GoogleAuth = {

  get accessToken() { return accessToken; },
  get userProfile() { return userProfile; },
  get isSignedIn() { return !!userProfile; },

  /**
   * Initialize auth. Called once on app startup.
   * Handles OAuth callback if ?code= is in the URL.
   * Otherwise restores session from localStorage and refreshes token silently.
   */
  async init(onAuthChange) {
    _onAuthChange = onAuthChange;

    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const state = params.get('state');

    if (code) {
      window.history.replaceState({}, '', window.location.pathname);

      const savedState = localStorage.getItem(P + 'oauth_state');
      localStorage.removeItem(P + 'oauth_state');

      if (!state || !savedState || state !== savedState) {
        console.error('OAuth state mismatch — possible CSRF');
        onAuthChange(false, null);
        return;
      }

      try {
        const result = await exchangeCodeForTokens(code);
        accessToken = result.access_token;
        cacheToken(result.access_token, result.expires_in);
        if (result.encrypted_refresh_token) {
          localStorage.setItem(REFRESH_KEY, result.encrypted_refresh_token);
        }

        const profile = await fetchUserInfo(accessToken);
        userProfile = profile;
        persistSession(profile);

        scheduleRefresh(result.expires_in);
        onAuthChange(true, userProfile);
      } catch (err) {
        console.error('OAuth callback failed:', err);
        onAuthChange(false, null);
      }
      return;
    }

    // Normal page load — restore session
    const storedProfile = getStoredProfile();
    const encryptedRefresh = localStorage.getItem(REFRESH_KEY);

    if (storedProfile && encryptedRefresh) {
      userProfile = storedProfile;

      const cached = getCachedToken();
      if (cached) {
        accessToken = cached;
        const expiry = parseInt(localStorage.getItem(P + 'token_expiry') || '0', 10);
        const remaining = Math.max(0, Math.floor((expiry - Date.now()) / 1000));
        scheduleRefresh(remaining);
        onAuthChange(true, userProfile);
        return;
      }

      onAuthChange(true, userProfile);

      try {
        const result = await refreshViaWorker(encryptedRefresh);
        accessToken = result.access_token;
        cacheToken(result.access_token, result.expires_in);
        scheduleRefresh(result.expires_in);
      } catch (err) {
        console.warn('Background token refresh failed:', err.message);
        accessToken = null;
      }
      return;
    }

    onAuthChange(false, null);
  },

  /**
   * Start the sign-in flow. Redirects the browser to Google's consent screen.
   * Must be called from a user gesture (button click).
   */
  async connect() {
    _signedOut = false;
    const state = crypto.randomUUID
      ? crypto.randomUUID()
      : Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem(P + 'oauth_state', state);

    const hasRefreshToken = !!localStorage.getItem(REFRESH_KEY);
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: getRedirectUri(),
      response_type: 'code',
      scope: SCOPES,
      access_type: 'offline',
      prompt: hasRefreshToken ? 'select_account' : 'consent',
      state,
    });

    if (USE_PKCE) {
      const verifier = randomVerifier();
      localStorage.setItem(P + 'oauth_verifier', verifier);
      params.set('code_challenge', await challengeFor(verifier));
      params.set('code_challenge_method', 'S256');
    }

    window.location.href = `${GOOGLE_AUTH_URL}?${params}`;
  },

  /**
   * Get a valid access token. Refreshes via Worker if expired.
   * Throws 'refresh_failed' if unable to get a token (triggers reconnect UI).
   */
  async getAccessToken() {
    if (accessToken) {
      const expiry = parseInt(localStorage.getItem(P + 'token_expiry') || '0', 10);
      if (Date.now() < expiry - 60000) {
        return accessToken;
      }
      accessToken = null;
    }

    const cached = getCachedToken();
    if (cached) {
      accessToken = cached;
      return cached;
    }

    const encryptedRefresh = localStorage.getItem(REFRESH_KEY);
    if (!encryptedRefresh) {
      throw new Error('Not signed in');
    }

    if (_pendingRefresh) return _pendingRefresh;

    _pendingRefresh = refreshViaWorker(encryptedRefresh)
      .then(result => {
        _pendingRefresh = null;
        if (_signedOut) return null;
        accessToken = result.access_token;
        cacheToken(result.access_token, result.expires_in);
        scheduleRefresh(result.expires_in);
        return accessToken;
      })
      .catch(err => {
        _pendingRefresh = null;
        if (!_signedOut) accessToken = null;
        throw new Error('refresh_failed');
      });

    return _pendingRefresh;
  },

  /**
   * Called by sheetsApi on 401 responses. Clears current token and retries.
   */
  handleAuthFailure() {
    accessToken = null;
    localStorage.removeItem(P + 'access_token');
    localStorage.removeItem(P + 'token_expiry');
    return this.getAccessToken();
  },

  /**
   * Sign out locally. Keeps the refresh token and Google grant intact
   * so re-signing in doesn't require full consent again.
   */
  signOut() {
    _signedOut = true;
    accessToken = null;
    userProfile = null;
    _pendingRefresh = null;
    if (_refreshTimer) clearTimeout(_refreshTimer);
    _refreshTimer = null;
    persistSession(null);
    clearAllTokens();
    clearCachedUserData();
    if (_onAuthChange) _onAuthChange(false, null);
  },

  /**
   * Full "forget this device": revokes Valu's access at Google (which also invalidates the refresh
   * token), then erases everything Valu stored in this browser. The user will have to go through
   * Google's consent screen again next time. Intended for shared or borrowed devices.
   */
  async signOutAndForget() {
    const tokenToRevoke = accessToken || getCachedToken();
    if (tokenToRevoke) {
      try {
        await fetch(GOOGLE_REVOKE_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: tokenToRevoke }),
        });
      } catch { /* offline: local data is still erased below */ }
    }
    this.signOut();
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith(P)) localStorage.removeItem(k);
    }
    sessionStorage.clear();
  },

  /**
   * Show the Google Picker to select a spreadsheet. By default it is pre-filtered to Valu Groceries
   * groups; pass another query (e.g. 'GroceriesApp' for an old Nutri sheet) and title to reuse it.
   * With the drive.file scope, picking a file is what grants this app access to it.
   */
  async showPicker(query = SHEET_PREFIX.trim(), title = 'Select a Valu Groceries group') {
    const token = await this.getAccessToken();

    if (typeof google === 'undefined' || !google.picker || !google.picker.PickerBuilder) {
      await new Promise((res, rej) => {
        if (typeof gapi !== 'undefined') {
          gapi.load('picker', { callback: res, onerror: rej });
        } else {
          rej(new Error('Google API loader not available'));
        }
      });
    }

    return new Promise((resolve) => {
      const view = new google.picker.DocsView(google.picker.ViewId.SPREADSHEETS)
        .setIncludeFolders(true)
        .setMimeTypes('application/vnd.google-apps.spreadsheet')
        .setQuery(query);

      const appId = CLIENT_ID.split('-')[0];
      new google.picker.PickerBuilder()
        .addView(view)
        .setOAuthToken(token)
        .setDeveloperKey(API_KEY)
        .setAppId(appId)
        .setTitle(title)
        .setCallback((data) => {
          if (data.action === google.picker.Action.PICKED) {
            const doc = data.docs && data.docs[0];
            if (doc) {
              resolve({ id: doc.id, name: doc.name });
            } else {
              resolve(null);
            }
          } else if (data.action === google.picker.Action.CANCEL) {
            resolve(null);
          } else if (data.action === 'error') {
            resolve(null);
          }
        })
        .build()
        .setVisible(true);
    });
  },

  API_KEY,
};

export default GoogleAuth;
