import test from 'node:test';
import assert from 'node:assert/strict';
import { WakeGate, matchWake, similarity, soundKey, wakeTargets } from '../src/shared/wake.ts';

const T = wakeTargets([
  { id: 'clickity', name: 'clickity' },
  { id: 'study-buddy', name: 'study buddy' },
  { id: 'max', name: 'max' },
]);

test('the plain wake word and its punctuation', () => {
  for (const t of ['hey clickity', 'Hey Clickity.', 'clickity,', 'Clickity!', 'hey, clickity?', 'ok clickity']) {
    const m = matchWake(t, T);
    assert.ok(m, t);
    assert.equal(m!.rest, '', t);
    assert.equal(m!.target.id, undefined, t); // the generic name: whoever is active
  }
});

test('whisper spellings: clicky, clickety, click it e, klikiti', () => {
  for (const t of ['hey clicky', 'hey clickety', 'Hey Clickety, what is this?', 'hey click it e', 'Klikiti what time is it', 'hey clikkety', 'hey Clickedy']) {
    assert.ok(matchWake(t, T), t);
  }
  assert.ok(soundKey('clickety') === soundKey('clickity'));
  assert.ok(similarity('clicky', 'clickity') >= 0.7);
});

test('the question after it is kept, as heard', () => {
  assert.equal(matchWake('Hey Clickity, what does this button do?', T)!.rest, 'what does this button do?');
  assert.equal(matchWake('clickety what time is it', T)!.rest, 'what time is it');
  assert.equal(matchWake('um hey clickity... open my mail', T)!.rest, 'open my mail');
  assert.equal(matchWake('hey clickity, um.', T)!.rest, ''); // only filler: wait for the question
});

test('ordinary speech does not wake it', () => {
  for (const t of [
    'click it and then save',
    'click here please',
    'I clicked it twice',
    'so the quickest way is this',
    'hey can you pass the salt',
    'tricky situation',
    'what is clickity anyway', // the name, but not at the start
    '',
    'clicky',
  ]) {
    assert.equal(matchWake(t, T), null, t);
  }
});

test('a clicky by name: multi-word, and short names need a greeting and an exact match', () => {
  const m = matchWake('hey study buddy, quiz me on cells', T);
  assert.equal(m?.target.id, 'study-buddy');
  assert.equal(m?.rest, 'quiz me on cells');
  assert.equal(matchWake('study buddy what is mitosis', T)?.target.id, 'study-buddy');
  assert.equal(matchWake('hey max, hello', T)?.target.id, 'max');
  assert.equal(matchWake('max out the volume', T), null);
  assert.equal(matchWake('hey mix the paint', T), null);
});

test('sensitivity: low needs a clearer word than high', () => {
  assert.ok(matchWake('hey kitty', T, 'high'));
  assert.equal(matchWake('hey kitty', T, 'medium'), null);
  assert.equal(matchWake('hey kitty', T, 'low'), null);
  assert.ok(matchWake('hey clicky', T, 'low')); // greeted, close enough even on low
});

test('gate: duration bounds, one at a time, a gap, and a per-minute cap', () => {
  const g = new WakeGate({ perMinute: 3, minGapMs: 1000 });
  assert.deepEqual(g.admit(200, 0), { ok: false, reason: 'too-short' });
  assert.deepEqual(g.admit(60_000, 0), { ok: false, reason: 'too-long' });
  assert.equal(g.admit(800, 0).ok, true);
  assert.deepEqual(g.admit(800, 100), { ok: false, reason: 'busy' });
  g.done(300);
  assert.deepEqual(g.admit(800, 900), { ok: false, reason: 'gap' });
  assert.equal(g.admit(800, 1400).ok, true);
  g.done(1500);
  assert.equal(g.admit(800, 3000).ok, true);
  g.done(3100);
  assert.deepEqual(g.admit(800, 5000), { ok: false, reason: 'rate' });
  assert.equal(g.load(5000), 3);
  // a minute later the window has rolled
  assert.equal(g.admit(800, 61_000).ok, true);
  assert.ok(g.skipped >= 3);
});
