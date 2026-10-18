// Run with:  node --test test/     (Node 20+, no installs needed)
import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { sealRefreshToken, openRefreshToken } from '../src/index.js';

const ENV = {
  GOOGLE_CLIENT_ID: 'client-id',
  GOOGLE_CLIENT_SECRET: 'client-secret',
  ENCRYPTION_SECRET: 'a-test-secret-that-is-longer-than-32-characters!!',
  ALLOWED_ORIGINS: 'https://pwa.valu-app.com, http://localhost:8080',
};
const ORIGIN = 'https://pwa.valu-app.com';

/** The ORIGINAL worker's encrypt(), copied verbatim, to prove old tokens still open. */
async function legacyEncrypt(text, secret) {
  const raw = new TextEncoder().encode(secret.padEnd(32, '\0').slice(0, 32));
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text));
  const buf = new Uint8Array(iv.length + ct.byteLength);
  buf.set(iv);
  buf.set(new Uint8Array(ct), iv.length);
  return btoa(String.fromCharCode(...buf));
}

function call(path, { method = 'POST', origin = ORIGIN, body, headers = {}, env = ENV } = {}) {
  const h = { 'Content-Type': 'application/json', ...headers };
  if (origin !== null) h.Origin = origin;
  const init = { method, headers: h };
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
  return worker.fetch(new Request('https://valu-auth.test' + path, init), env);
}

function mockGoogle(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const params = Object.fromEntries(new URLSearchParams(String(init.body)));
    calls.push({ url: String(url), params });
    const { status = 200, json } = handler(params);
    return new Response(JSON.stringify(json), { status });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test('sealed tokens round-trip and are not the plain token', async () => {
  const sealed = await sealRefreshToken('1//refresh-abc', ENV.ENCRYPTION_SECRET);
  assert.ok(sealed.startsWith('v2.'));
  assert.ok(!sealed.includes('refresh-abc'));
  const opened = await openRefreshToken(sealed, ENV.ENCRYPTION_SECRET);
  assert.equal(opened.refreshToken, '1//refresh-abc');
  assert.ok(opened.issuedAt > 1_700_000_000);
});

test('tokens issued by the OLD worker still open (nobody gets signed out)', async () => {
  const legacy = await legacyEncrypt('1//old-token', ENV.ENCRYPTION_SECRET);
  const opened = await openRefreshToken(legacy, ENV.ENCRYPTION_SECRET);
  assert.equal(opened.refreshToken, '1//old-token');
  assert.equal(opened.issuedAt, null);
});

test('wrong secret or tampered v2 token is rejected', async () => {
  const sealed = await sealRefreshToken('1//x', ENV.ENCRYPTION_SECRET);
  await assert.rejects(openRefreshToken(sealed, 'another-secret-another-secret-12345'));
  const tampered = sealed.slice(0, -4) + (sealed.endsWith('AAAA') ? 'BBBB' : 'AAAA');
  await assert.rejects(openRefreshToken(tampered, ENV.ENCRYPTION_SECRET));
});

test('refresh works with a legacy token and returns only access_token + expires_in', async () => {
  const legacy = await legacyEncrypt('1//old-token', ENV.ENCRYPTION_SECRET);
  const g = mockGoogle((p) => {
    assert.equal(p.refresh_token, '1//old-token');
    return { json: { access_token: 'ya29.new', expires_in: 3599, scope: 'x', id_token: 'secret' } };
  });
  try {
    const res = await call('/auth/refresh', { body: { encrypted_refresh_token: legacy } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { access_token: 'ya29.new', expires_in: 3599 });
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
  } finally { g.restore(); }
});

test('token exchange returns a v2 sealed refresh token and forwards code_verifier', async () => {
  const verifier = 'a'.repeat(64);
  const g = mockGoogle((p) => {
    assert.equal(p.code_verifier, verifier);
    assert.equal(p.redirect_uri, 'https://pwa.valu-app.com');
    return { json: { access_token: 'ya29.a', expires_in: 3599, refresh_token: '1//rt' } };
  });
  try {
    const res = await call('/auth/token', { body: { code: 'abc', redirect_uri: 'https://pwa.valu-app.com', code_verifier: verifier } });
    assert.equal(res.status, 200);
    const out = await res.json();
    assert.ok(out.encrypted_refresh_token.startsWith('v2.'));
    assert.equal(out.refresh_token, undefined);
    const opened = await openRefreshToken(out.encrypted_refresh_token, ENV.ENCRYPTION_SECRET);
    assert.equal(opened.refreshToken, '1//rt');
  } finally { g.restore(); }
});

test('token exchange without code_verifier still works (current frontend)', async () => {
  const g = mockGoogle((p) => {
    assert.equal('code_verifier' in p, false);
    return { json: { access_token: 'ya29.a', expires_in: 3599 } };
  });
  try {
    const res = await call('/auth/token', { body: { code: 'abc', redirect_uri: 'http://localhost:8080/dev/' } });
    assert.equal(res.status, 200);
  } finally { g.restore(); }
});

test('Google errors do not leak debug fields', async () => {
  const g = mockGoogle(() => ({ status: 400, json: { error: 'invalid_grant', error_description: 'Bad Request' } }));
  try {
    const res = await call('/auth/token', { body: { code: 'abc', redirect_uri: 'https://pwa.valu-app.com' } });
    assert.equal(res.status, 400);
    const out = await res.json();
    assert.deepEqual(out, { error: 'invalid_grant', error_description: 'Bad Request' });
    assert.equal(out.redirect_uri_sent, undefined);
  } finally { g.restore(); }
});

test('disallowed or missing Origin is refused with no CORS header', async () => {
  for (const origin of ['https://evil.example', null]) {
    const res = await call('/auth/refresh', { origin, body: { encrypted_refresh_token: 'x' } });
    assert.equal(res.status, 403);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), null);
  }
  const pre = await call('/auth/refresh', { method: 'OPTIONS', origin: 'https://evil.example' });
  assert.equal(pre.status, 403);
  const okPre = await call('/auth/refresh', { method: 'OPTIONS' });
  assert.equal(okPre.status, 204);
  assert.equal(okPre.headers.get('Access-Control-Allow-Origin'), ORIGIN);
});

test('input validation', async () => {
  const cases = [
    [{ body: 'not json' }, 400],
    [{ body: '[]' }, 400],
    [{ body: { code: 'abc' } }, 400],
    [{ body: { code: 'abc', redirect_uri: 'https://evil.example/' } }, 400],
    [{ body: { code: 'abc', redirect_uri: 'https://pwa.valu-app.com', code_verifier: 'short' } }, 400],
    [{ body: { code: 'x'.repeat(5000), redirect_uri: 'https://pwa.valu-app.com' } }, 400], // field too long
    [{ body: { code: 'x'.repeat(9000), redirect_uri: 'https://pwa.valu-app.com' } }, 413], // body too large
    [{ body: { code: 'abc', redirect_uri: 'https://pwa.valu-app.com' }, headers: { 'Content-Type': 'text/plain' } }, 415],
  ];
  for (const [opts, status] of cases) {
    const res = await call('/auth/token', opts);
    assert.equal(res.status, status, JSON.stringify(opts).slice(0, 80));
  }
  assert.equal((await call('/auth/refresh', { method: 'GET' })).status, 405);
  assert.equal((await call('/nope')).status, 404);
});

test('corrupted refresh token gets a generic 401', async () => {
  const res = await call('/auth/refresh', { body: { encrypted_refresh_token: 'v2.AAAA' } });
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: 'invalid_token', error_description: 'Invalid or corrupted refresh token' });
});

test('REFRESH_TOKEN_MAX_AGE_DAYS expires old v2 tokens only when configured', async () => {
  const sealed = await sealRefreshToken('1//x', ENV.ENCRYPTION_SECRET);
  const realNow = Date.now;
  const g = mockGoogle(() => ({ json: { access_token: 'ya29.n', expires_in: 3599 } }));
  try {
    Date.now = () => realNow() + 400 * 86400 * 1000;
    const expired = await call('/auth/refresh', { body: { encrypted_refresh_token: sealed }, env: { ...ENV, REFRESH_TOKEN_MAX_AGE_DAYS: '365' } });
    assert.equal(expired.status, 401);
    assert.equal((await expired.json()).error, 'refresh_token_expired');
    const unlimited = await call('/auth/refresh', { body: { encrypted_refresh_token: sealed } });
    assert.equal(unlimited.status, 200);
  } finally { Date.now = realNow; g.restore(); }
});

test('internal failures return a generic 500', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('secret internal detail'); };
  const origErr = console.error; console.error = () => {};
  try {
    const res = await call('/auth/token', { body: { code: 'abc', redirect_uri: 'https://pwa.valu-app.com' } });
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: 'internal_error' });
  } finally { globalThis.fetch = original; console.error = origErr; }
});
