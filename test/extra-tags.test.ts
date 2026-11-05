import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeFacts, parseDays, parseExtraTags, parseTime, stripExtraTags } from '../src/main/extra-tags.ts';

test('remember / highlight / step / routine tags parse and strip', () => {
  const raw = 'here you go. [REMEMBER:prefers metric units] [HIGHLIGHT:100,50,20,300:sidebar:screen2] [STEP:2:10,20:save:click save] [STEP:1:5,6:file menu:open the file menu: it is top left] [ROUTINE:weekdays|9am|summarise my screen]';
  const t = parseExtraTags(raw);
  assert.deepEqual(t.remember, ['prefers metric units']);
  assert.deepEqual(t.highlights, [{ x1: 20, y1: 50, x2: 100, y2: 300, label: 'sidebar', screen: 2 }]);
  assert.deepEqual(t.steps.map((s) => s.n), [1, 2]);
  assert.equal(t.steps[0].instruction, 'open the file menu: it is top left');
  assert.deepEqual(t.routines, [{ days: [1, 2, 3, 4, 5], time: '09:00', prompt: 'summarise my screen' }]);
  assert.equal(stripExtraTags(raw), 'here you go.');
});

test('streaming hides a partial tag', () => {
  assert.equal(stripExtraTags('ok. [REMEMB', true), 'ok. ');
  assert.equal(stripExtraTags('ok. [STEP:1:3', true), 'ok. ');
  assert.equal(stripExtraTags('ok. [S', true), 'ok. ');
});

test('steps are capped at 15; bad tags skipped', () => {
  const raw = Array.from({ length: 20 }, (_, i) => `[STEP:${i + 1}:1,1:x:y]`).join('') + '[STEP:a:b] [HIGHLIGHT:1,1,1,5]';
  const t = parseExtraTags(raw);
  assert.equal(t.steps.length, 15);
  assert.equal(t.highlights.length, 0);
});

test('days and times', () => {
  assert.deepEqual(parseDays('daily'), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(parseDays('mon,wed,fri'), [1, 3, 5]);
  assert.deepEqual(parseDays('fri-mon'), [0, 1, 5, 6]);
  assert.deepEqual(parseDays('someday'), []);
  assert.equal(parseTime('5:30 pm'), '17:30');
  assert.equal(parseTime('12am'), '00:00');
  assert.equal(parseTime('25:00'), null);
});

test('memory facts: dedupe, secrets dropped, cap', () => {
  const f = mergeFacts(['Likes tea'], ['likes tea!', 'password is hunter2', 'card 4111 1111 1111 1111', 'works at acme']);
  assert.deepEqual(f, ['likes tea!', 'works at acme']);
  assert.equal(mergeFacts([], Array.from({ length: 250 }, (_, i) => `fact ${i}`)).length, 200);
});
