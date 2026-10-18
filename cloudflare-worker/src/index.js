/**
 * Valu auth worker (hardened candidate).
 *
 * Same endpoints and response shapes as the deployed worker (/auth/token, /auth/refresh), so the
 * current frontend works unchanged. Differences:
 *  - Requests must come from an allowed Origin (checked server-side, not just via CORS headers).
 *  - JSON content-type, body-size and field validation; redirect_uri must belong to an allowed origin.
 *  - No internal error text or debug fields in responses (the old worker echoed err.message and
 *    redirect_uri_sent).
 *  - CORS: no Access-Control-Allow-Origin at all for unknown origins, `Vary: Origin`, no-store.
 *  - Optional PKCE: forwards `code_verifier` to Google when the frontend sends one.
 *  - New refresh tokens are sealed with a proper key derivation (HKDF) and carry an issue time
 *    ("v2." prefix). Tokens issued by the old worker ("legacy" format) are still accepted, so
 *    nobody is signed out when this replaces the old worker, as long as ENCRYPTION_SECRET is the same.
 *  - Optional REFRESH_TOKEN_MAX_AGE_DAYS: force a fresh sign-in after N days (unset = never).
 */

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const MAX_BODY_BYTES = 8 * 1024;
const V2_PREFIX = 'v2.';
const V2_AAD = 'valu-refresh-v2';

class HttpError extends Error {
  constructor(status, code, description) {
    super(code);
    this.status = status;
    this.code = code;
    this.description = description;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/auth/token' && url.pathname !== '/auth/refresh') {
      return plain('Not found', 404);
    }

    const origin = request.headers.get('Origin') || '';
    const allowed = allowedOrigins(env);
    const originOk = origin !== '' && allowed.includes(origin);

    if (request.method === 'OPTIONS') {
      return originOk ? respond(origin, null, 204) : plain('Forbidden', 403);
    }
    if (!originOk) return respond(null, { error: 'origin_not_allowed' }, 403);
    if (request.method !== 'POST') return respond(origin, { error: 'method_not_allowed' }, 405);

    try {
      const body = await readJson(request);
      const result = url.pathname === '/auth/token'
        ? await handleTokenExchange(body, env, allowed)
        : await handleTokenRefresh(body, env);
      return respond(origin, result.body, result.status || 200);
    } catch (err) {
      if (err instanceof HttpError) {
        const payload = { error: err.code };
        if (err.description) payload.error_description = err.description;
        return respond(origin, payload, err.status);
      }
      console.error('auth worker error:', err && err.message);
      return respond(origin, { error: 'internal_error' }, 500);
    }
  },
};

// ── helpers ────────────────────────────────────────────────────────────────────

function allowedOrigins(env) {
  return (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
}

function plain(text, status) {
  return new Response(text, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}

function respond(origin, body, status = 200) {
  const headers = {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    Vary: 'Origin',
  };
  if (origin) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Content-Type';
    headers['Access-Control-Max-Age'] = '86400';
  }
  if (body === null) return new Response(null, { status, headers });
  headers['Content-Type'] = 'application/json';
  return new Response(JSON.stringify(body), { status, headers });
}

async function readJson(request) {
  const type = (request.headers.get('Content-Type') || '').toLowerCase();
  if (!type.includes('application/json')) throw new HttpError(415, 'unsupported_media_type');
  const declared = Number(request.headers.get('Content-Length') || 0);
  if (declared > MAX_BODY_BYTES) throw new HttpError(413, 'payload_too_large');
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, 'payload_too_large');
  let data;
  try { data = JSON.parse(text); } catch { throw new HttpError(400, 'invalid_json'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new HttpError(400, 'invalid_json');
  return data;
}

function isString(v, max) {
  return typeof v === 'string' && v.length > 0 && v.length <= max;
}

// ── base64 (chunk-safe) ────────────────────────────────────────────────────────

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(str) {
  return Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
}

// ── refresh-token sealing ──────────────────────────────────────────────────────

const enc = new TextEncoder();

async function legacyKey(secret) {
  const raw = enc.encode(secret.padEnd(32, '\0').slice(0, 32));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
}

async function v2Key(secret, usages) {
  const base = await crypto.subtle.importKey('raw', enc.encode(secret), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('valu-auth/v2'), info: enc.encode('refresh-token') },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    usages,
  );
}

export async function sealRefreshToken(refreshToken, secret) {
  const key = await v2Key(secret, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = enc.encode(JSON.stringify({ rt: refreshToken, iat: Math.floor(Date.now() / 1000) }));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode(V2_AAD) }, key, plaintext));
  const buf = new Uint8Array(iv.length + ciphertext.length);
  buf.set(iv);
  buf.set(ciphertext, iv.length);
  return V2_PREFIX + toBase64(buf);
}

/** @returns {Promise<{ refreshToken: string, issuedAt: number|null }>} */
export async function openRefreshToken(sealed, secret) {
  if (sealed.startsWith(V2_PREFIX)) {
    const raw = fromBase64(sealed.slice(V2_PREFIX.length));
    const key = await v2Key(secret, ['decrypt']);
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: raw.slice(0, 12), additionalData: enc.encode(V2_AAD) }, key, raw.slice(12));
    const obj = JSON.parse(new TextDecoder().decode(plain));
    if (!obj || typeof obj.rt !== 'string') throw new Error('bad payload');
    return { refreshToken: obj.rt, issuedAt: typeof obj.iat === 'number' ? obj.iat : null };
  }
  // Legacy format from the original worker: base64(iv || ciphertext) of the bare token.
  const raw = fromBase64(sealed);
  const key = await legacyKey(secret);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, key, raw.slice(12));
  return { refreshToken: new TextDecoder().decode(plain), issuedAt: null };
}

// ── endpoints ──────────────────────────────────────────────────────────────────

async function handleTokenExchange(body, env, allowed) {
  const { code, redirect_uri: redirectUri, code_verifier: codeVerifier } = body;
  if (!isString(code, 2048) || !isString(redirectUri, 512)) {
    throw new HttpError(400, 'invalid_request', 'Missing or invalid code or redirect_uri');
  }
  let redirectOrigin;
  try { redirectOrigin = new URL(redirectUri).origin; } catch { throw new HttpError(400, 'invalid_request', 'Invalid redirect_uri'); }
  if (!allowed.includes(redirectOrigin)) throw new HttpError(400, 'invalid_request', 'redirect_uri not allowed');
  if (codeVerifier !== undefined && !(typeof codeVerifier === 'string' && /^[A-Za-z0-9\-._~]{43,128}$/.test(codeVerifier))) {
    throw new HttpError(400, 'invalid_request', 'Invalid code_verifier');
  }

  const params = {
    code,
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  };
  if (codeVerifier) params.code_verifier = codeVerifier;

  const resp = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const data = await resp.json();
  if (data.error) {
    console.error('Google token error:', data.error);
    return { status: 400, body: { error: data.error, error_description: data.error_description || '' } };
  }

  const result = { access_token: data.access_token, expires_in: data.expires_in };
  if (data.refresh_token) {
    result.encrypted_refresh_token = await sealRefreshToken(data.refresh_token, env.ENCRYPTION_SECRET);
  }
  return { body: result };
}

async function handleTokenRefresh(body, env) {
  const sealed = body.encrypted_refresh_token;
  if (!isString(sealed, 4096)) throw new HttpError(400, 'invalid_request', 'Missing encrypted_refresh_token');

  let opened;
  try {
    opened = await openRefreshToken(sealed, env.ENCRYPTION_SECRET);
  } catch {
    throw new HttpError(401, 'invalid_token', 'Invalid or corrupted refresh token');
  }

  const maxDays = Number(env.REFRESH_TOKEN_MAX_AGE_DAYS || 0);
  if (maxDays > 0 && opened.issuedAt !== null) {
    const ageDays = (Date.now() / 1000 - opened.issuedAt) / 86400;
    if (ageDays > maxDays) throw new HttpError(401, 'refresh_token_expired', 'Please sign in again');
  }

  const resp = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: opened.refreshToken,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      grant_type: 'refresh_token',
    }),
  });
  const data = await resp.json();
  if (data.error) return { status: 401, body: { error: data.error } };
  return { body: { access_token: data.access_token, expires_in: data.expires_in } };
}
