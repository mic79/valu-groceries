// The preferred start page: stored per device, Dashboard by default, and never anything unknown.
import test from 'node:test';
import assert from 'node:assert/strict';
import { START_KEY, START_PAGES, DEFAULT_START, validStart, loadStartPage, saveStartPage } from '../startPage.js';

function fakeStorage(initial = {}) {
  const m = new Map(Object.entries(initial));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m };
}

test('Dashboard is the default', () => {
  assert.equal(DEFAULT_START, 'home');
  assert.equal(START_PAGES[0].id, 'home');
  assert.equal(loadStartPage(fakeStorage()), 'home');
});

test('a chosen page is remembered, and choosing Dashboard clears the setting', () => {
  const s = fakeStorage();
  assert.equal(saveStartPage('history', s), 'history');
  assert.equal(s.getItem(START_KEY), 'history');
  assert.equal(loadStartPage(s), 'history');
  assert.equal(saveStartPage('home', s), 'home');
  assert.equal(s.getItem(START_KEY), null);
  assert.equal(loadStartPage(s), 'home');
});

test('unknown or stale values fall back to Dashboard', () => {
  assert.equal(validStart('settings'), 'home');
  assert.equal(validStart('<script>'), 'home');
  assert.equal(validStart(undefined), 'home');
  assert.equal(loadStartPage(fakeStorage({ [START_KEY]: 'faq' })), 'home');
  assert.equal(saveStartPage('nope', fakeStorage()), 'home');
});

test('every offered page is a real route in app.js', async () => {
  const fs = await import('node:fs');
  const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  const map = app.slice(app.indexOf('const PAGE_MAP'), app.indexOf('};', app.indexOf('const PAGE_MAP')));
  for (const p of START_PAGES) assert.ok(new RegExp('\\b' + p.id + ':').test(map), p.id + ' is missing from PAGE_MAP');
});

test('storage that throws never breaks the app', () => {
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  assert.equal(loadStartPage(broken), 'home');
  assert.equal(saveStartPage('stores', broken), 'stores');
});