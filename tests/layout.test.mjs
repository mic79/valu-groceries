import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_WIDGETS, mergeLayout, moveWidget } from '../homeLayout.js';

const ids = (list) => list.map((w) => w.id);

test('no saved layout: every widget, default order, all on', () => {
  for (const stored of [null, undefined, [], 'x', {}]) {
    const l = mergeLayout(stored);
    assert.deepEqual(ids(l), ids(DEFAULT_WIDGETS));
    assert.ok(l.every((w) => w.enabled));
  }
});

test('saved order and on/off state win', () => {
  const l = mergeLayout([{ id: 'topItems', enabled: true }, { id: 'list', enabled: false }]);
  assert.deepEqual(ids(l).slice(0, 2), ['topItems', 'list']);
  assert.equal(l[1].enabled, false);
  assert.equal(l.length, DEFAULT_WIDGETS.length);
});

test('unknown and duplicate ids are dropped, new widgets are added enabled at the end', () => {
  const l = mergeLayout([{ id: 'gone', enabled: true }, { id: 'stats', enabled: true }, { id: 'stats', enabled: false }, null]);
  assert.equal(ids(l)[0], 'stats');
  assert.equal(l[0].enabled, true);
  assert.equal(new Set(ids(l)).size, DEFAULT_WIDGETS.length);
  assert.ok(l.slice(1).every((w) => w.enabled));
});

test('moving a widget swaps it with its neighbour and stops at the ends', () => {
  const l = mergeLayout(null);
  assert.deepEqual(ids(moveWidget(l, 'stats', -1)).slice(0, 3), ['list', 'stats', 'spending']);
  assert.deepEqual(ids(moveWidget(l, 'list', -1)), ids(l));
  assert.deepEqual(ids(moveWidget(l, l[l.length - 1].id, 1)), ids(l));
  assert.deepEqual(ids(moveWidget(l, 'nope', 1)), ids(l));
});

test('the old per-store widget is folded into Spending', () => {
  const bothOff = mergeLayout([{ id: 'spending', enabled: false }, { id: 'byStore', enabled: false }, { id: 'list', enabled: true }]);
  assert.ok(!ids(bothOff).includes('byStore'));
  assert.equal(bothOff.find((w) => w.id === 'spending').enabled, false);
  const storeOn = mergeLayout([{ id: 'spending', enabled: false }, { id: 'byStore', enabled: true }]);
  assert.equal(storeOn.find((w) => w.id === 'spending').enabled, true);
  assert.ok(!ids(storeOn).includes('byStore'));
});
