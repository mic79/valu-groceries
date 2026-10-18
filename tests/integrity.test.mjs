// Static checks: nothing the app loads is missing, and everything is available offline.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));
const appScripts = () => fs.readdirSync(ROOT).filter((f) => f.endsWith('.js'));

const sw = read('service-worker.js');
const precache = [...sw.slice(sw.indexOf('PRECACHE_URLS'), sw.indexOf('];', sw.indexOf('PRECACHE_URLS'))).matchAll(/'([^']+)'/g)].map((m) => m[1]);

test('every precached file exists', () => {
  assert.deepEqual(precache.filter((f) => !exists(f)), []);
});

test('every app script, stylesheet and font is in the offline precache list', () => {
  const rootFiles = fs.readdirSync(ROOT).filter((f) => (f.endsWith('.js') && f !== 'service-worker.js') || f.endsWith('.css'));
  const vendor = fs.readdirSync(path.join(ROOT, 'vendor')).filter((f) => f.endsWith('.js') || f.endsWith('.css')).map((f) => 'vendor/' + f);
  const fonts = fs.readdirSync(path.join(ROOT, 'vendor/fonts')).map((f) => 'vendor/fonts/' + f);
  assert.deepEqual([...rootFiles, ...vendor, ...fonts].filter((f) => !precache.includes(f)), []);
});

test('every relative import resolves to a real file', () => {
  const bad = [];
  for (const f of appScripts()) {
    for (const m of read(f).matchAll(/(?:from|import)\s*\(?\s*['"](\.\/[^'"]+)['"]/g)) {
      if (!exists(m[1].slice(2))) bad.push(`${f} -> ${m[1]}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('index.html loads only local files, plus the Google Picker loader', () => {
  const html = read('index.html');
  const external = [...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(external.sort(), ['https://apis.google.com/js/api.js', 'https://apis.google.com/js/picker.js']);
  const local = [...html.matchAll(/(?:src|href)="((?!https?:|#)[^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(local.filter((f) => !exists(f)), []);
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/.test(html), 'no inline <script> blocks (needed for a strict CSP)');
});

test('fonts.css only references local font files', () => {
  const css = read('vendor/fonts.css');
  assert.ok(!/https?:\/\//.test(css.replace(/\/\*[\s\S]*?\*\//g, '')));
  const files = [...css.matchAll(/url\(([^)]+)\)/g)].map((m) => 'vendor/' + m[1]);
  assert.deepEqual(files.filter((f) => !exists(f)), []);
});

test('no debug console.log calls ship in app code', () => {
  assert.deepEqual(appScripts().filter((f) => /console\.log\(/.test(read(f))), []);
});

test('version.js is the only place the version is defined', () => {
  assert.match(read('version.js'), /VALU_VERSION = 'v\d+'/);
  assert.ok(!/valu-groceries-v\d+/.test(sw), 'service worker must not hardcode a cache name');
});

test('manifest is valid and its icons exist', () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert.equal(manifest.name, 'Valu Groceries');
  assert.deepEqual(manifest.icons.map((i) => i.src).filter((f) => !exists(f)), []);
  assert.ok(exists(manifest.start_url));
});

test('PKCE is only enabled together with a worker that supports it (never the original stable worker)', () => {
  const cfg = read('config.js');
  const worker = /const WORKER_URL\s*=\s*'([^']+)'/.exec(cfg)[1];
  const pkce = /const USE_PKCE\s*=\s*(true|false)/.exec(cfg)[1] === 'true';
  if (pkce) assert.notEqual(worker, 'https://valu-auth.valu.workers.dev', 'stable worker ignores code_verifier');
});

test('Valu Groceries storage never collides with Valu Finance on the same origin', () => {
  const cfg = read('config.js');
  assert.match(cfg, /STORAGE_PREFIX = 'vg_'/);
  assert.match(cfg, /SHEET_PREFIX = 'Valu Groceries: '/);
  const offenders = appScripts().filter((f) => /['"`]valu_[a-z_]+['"`]/.test(read(f)) && !/^valu(-landing-intro)?\.js$/.test(f));
  assert.deepEqual(offenders, [], 'storage keys must use the vg_ prefix');
  assert.ok(!/valu_theme/.test(read('boot.js')));
});

test('item and store text cells are never written without going through the guards', () => {
  const logic = read('groceryLogic.js');
  assert.match(logic, /textCell\(item\.title\)/);
  assert.match(logic, /textCell\(item\.notes\)/);
  assert.match(logic, /textCell\(store\.name\)/);
  assert.match(read('sheetsApi.js'), /neutralizeFormula/);
});

test('index.html binds page props in kebab-case (HTML lowercases attribute names, so :sheetId would never arrive)', () => {
  const html = read('index.html');
  const bindings = [...html.matchAll(/\s:([A-Za-z-]+)=/g)].map((m) => m[1]);
  const camel = bindings.filter((b) => /[A-Z]/.test(b) && !/^(viewBox|preserveAspectRatio)$/.test(b));
  assert.deepEqual(camel, []);
});

test('every app script is syntactically valid (a typo there leaves the app blank)', () => {
  const bad = [];
  for (const f of appScripts()) {
    const r = spawnSync(process.execPath, ['--check', path.join(ROOT, f)], { encoding: 'utf8' });
    if (r.status !== 0) bad.push(f + ': ' + String(r.stderr).split('\n').find((l) => /Error/.test(l)));
  }
  assert.deepEqual(bad, []);
});
