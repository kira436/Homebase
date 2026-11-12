// Run with: node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const L = require('../logic.js');

const w3 = { every: 3, unit: 'weeks', fromCompletion: true };

test('every 3 weeks, counted from when it was done', () => {
  assert.strictEqual(L.nextAfterDone('2026-11-14', '2026-11-16', w3), '2026-12-07');
});

test('fixed dates stay on the calendar when done late', () => {
  assert.strictEqual(L.nextAfterDone('2026-11-14', '2026-11-16', { ...w3, fromCompletion: false }), '2026-12-05');
});

test('fixed dates: doing it early uses up this cycle', () => {
  const r = { every: 1, unit: 'weeks', fromCompletion: false };
  assert.strictEqual(L.nextAfterDone('2026-11-14', '2026-11-11', r), '2026-11-21');
});

test('fixed dates: very late does not leave a backlog', () => {
  const r = { every: 1, unit: 'weeks', fromCompletion: false };
  assert.strictEqual(L.nextAfterDone('2026-11-01', '2026-11-20', r), '2026-11-22');
});

test('skip moves to the next cycle', () => {
  assert.strictEqual(L.nextAfterSkip('2026-11-14', '2026-11-11', { every: 1, unit: 'weeks' }), '2026-11-21');
});

test('skip of an overdue task lands in the future', () => {
  assert.strictEqual(L.nextAfterSkip('2026-11-01', '2026-11-11', { every: 1, unit: 'weeks' }), '2026-11-15');
});

test('months clamp to the end of short months', () => {
  assert.strictEqual(L.addMonths('2027-01-31', 1), '2027-02-28');
  assert.strictEqual(L.nextAfterDone('2026-11-09', '2026-11-11', { every: 3, unit: 'months', fromCompletion: true }), '2027-02-11');
});

test('days between crosses daylight saving cleanly', () => {
  assert.strictEqual(L.daysBetween('2026-10-31', '2026-11-02'), 2);
  assert.strictEqual(L.daysBetween('2026-11-14', '2026-11-11'), -3);
});

test('summary text', () => {
  assert.strictEqual(L.summary({ every: 1, unit: 'weeks' }), 'Every week');
  assert.strictEqual(L.summary({ every: 3, unit: 'weeks' }), 'Every 3 weeks');
});

test('basket advice', () => {
  assert.deepStrictEqual([0, 1, 2, 3].map(L.basketAdvice), ['skip', 'skip', 'either', 'now']);
});

test('rotation wraps around', () => {
  assert.strictEqual(L.nextInRotation(['a', 'b', 'c'], 'c'), 'a');
  assert.strictEqual(L.nextInRotation(['a', 'b', 'c'], 'a'), 'b');
  assert.strictEqual(L.nextInRotation(['a', 'b'], 'gone'), 'a');
});
