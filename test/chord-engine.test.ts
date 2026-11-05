// node --experimental-strip-types --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { AltGrFilter, ChordEngine, type HotkeyHandlers } from '../src/main/chord-engine.ts';

function mk(mode: 'hold' | 'toggle', opts: { talk?: string[]; type?: string[]; talking?: () => boolean } = {}) {
  const log: string[] = [];
  const h: HotkeyHandlers = {
    onTalkDown: () => log.push('down'),
    onTalkUp: () => log.push('up'),
    onType: () => log.push('type'),
    onEscape: () => log.push('esc'),
    onTalkCancel: () => log.push('cancel'),
  };
  if (opts.talking) h.isTalking = opts.talking;
  const e = new ChordEngine(h, { talk: opts.talk ?? ['Control', 'Alt'], type: opts.type ?? ['Control', 'Alt', 'Space'], mode }, 5);
  return { e, log };
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('hold: ctrl + alt talks, release sends', async () => {
  const { e, log } = mk('hold');
  e.keyDown('Control'); e.keyDown('Alt');
  await wait(15);
  assert.deepEqual(log, ['down']);
  e.keyUp('Alt');
  assert.deepEqual(log, ['down', 'up']);
  e.dispose();
});

test('AltGr-style ctrl + alt + Q cancels quietly instead of sending', async () => {
  const { e, log } = mk('hold');
  e.keyDown('Control'); e.keyDown('Alt');
  await wait(15); // past the type-chord delay: talk started
  e.keyDown('KeyQ');
  assert.deepEqual(log, ['down', 'cancel']);
  e.keyUp('KeyQ'); e.keyDown('KeyQ'); e.keyUp('KeyQ'); // typing more @@
  e.keyUp('Alt'); e.keyUp('Control');
  assert.deepEqual(log, ['down', 'cancel']);
  e.dispose();
});

test('unknown layout key while chord held cancels too', async () => {
  const { e, log } = mk('hold');
  e.keyDown('Control'); e.keyDown('Alt');
  await wait(15);
  e.foreignKeyDown();
  assert.deepEqual(log, ['down', 'cancel']);
  e.dispose();
});

test('extra key during the subset delay never starts talking', async () => {
  const { e, log } = mk('hold');
  e.keyDown('Control'); e.keyDown('Alt'); e.keyDown('KeyE');
  await wait(15);
  assert.deepEqual(log, []);
  e.dispose();
});

test('type chord after talk fired: drop the recording quietly, open type box', async () => {
  const { e, log } = mk('hold');
  e.keyDown('Control'); e.keyDown('Alt');
  await wait(15);
  e.keyDown('Space');
  assert.deepEqual(log, ['down', 'cancel', 'type']);
  e.dispose();
});

test('toggle: keys typed after releasing the chord do not cancel', async () => {
  const { e, log } = mk('toggle', { talk: ['Control', 'KeyK'], type: ['Control', 'Space'] });
  e.keyDown('Control'); e.keyDown('KeyK');
  assert.deepEqual(log, ['down']);
  e.keyUp('KeyK'); e.keyUp('Control');
  e.keyDown('KeyA'); e.keyUp('KeyA');
  e.keyDown('Control'); e.keyDown('KeyK');
  assert.deepEqual(log, ['down', 'up']);
  e.dispose();
});

test('toggle resyncs when the turn was ended elsewhere (escape)', () => {
  let talking = false;
  const { e, log } = mk('toggle', { talk: ['Control', 'KeyK'], type: ['Control', 'Space'], talking: () => talking });
  e.keyDown('Control'); e.keyDown('KeyK'); talking = true;
  e.keyUp('KeyK'); e.keyUp('Control');
  talking = false; // escape cancelled the recording
  e.keyDown('Control'); e.keyDown('KeyK');
  assert.deepEqual(log, ['down', 'down']); // starts again instead of a dead "up"
  e.dispose();
});

test('AltGrFilter: windows synthetic ctrl + AltRight is AltGr; physical ctrl + alt passes', () => {
  const CTRL = 29, ALTR = 3640, ALTL = 56;
  const f = new AltGrFilter(CTRL, ALTR);
  assert.equal(f.keyDown(CTRL, 1000), 'pass');
  assert.equal(f.keyDown(ALTR, 1000), 'altgr');
  assert.equal(f.keyDown(ALTR, 1030), 'drop'); // autorepeat
  assert.equal(f.keyDown(16, 1040), 'pass'); // Q
  assert.equal(f.keyUp(ALTR), 'drop');
  assert.equal(f.keyUp(CTRL), 'drop');
  // physical left ctrl + left alt
  assert.equal(f.keyDown(CTRL, 2000), 'pass');
  assert.equal(f.keyDown(ALTL, 2000), 'pass');
  assert.equal(f.keyUp(CTRL), 'pass');
  // physical ctrl, then right alt a moment later
  assert.equal(f.keyDown(CTRL, 3000), 'pass');
  assert.equal(f.keyDown(ALTR, 3080), 'pass');
});

test('ChordEngine.forgetKey retracts the synthetic control', () => {
  const { e, log } = mk('hold', { talk: ['Control', 'Alt'], type: ['Control', 'Alt', 'Space'] });
  e.keyDown('Control'); e.forgetKey('Control'); e.keyDown('Alt');
  e.keyDown('KeyQ'); e.keyUp('KeyQ'); e.keyUp('Alt');
  assert.deepEqual(log, []);
  e.dispose();
});

/* ── dictation + taps ── */

function mkx(opts: { dictate?: string[]; typeTap?: string[]; alwaysOn?: string[]; talk?: string[]; type?: string[] } = {}) {
  const log: string[] = [];
  let now = 1000;
  const h: HotkeyHandlers = {
    onTalkDown: () => log.push('down'),
    onTalkUp: () => log.push('up'),
    onType: () => log.push('type'),
    onEscape: () => log.push('esc'),
    onTalkCancel: () => log.push('cancel'),
    onDictateDown: (d) => log.push(d ? 'dict-down:draft' : 'dict-down'),
    onDictateDraft: () => log.push('dict-draft'),
    onDictateUp: (d) => log.push(d ? 'dict-up:draft' : 'dict-up'),
    onDictateCancel: () => log.push('dict-cancel'),
    onTypeTap: () => log.push('tap-type'),
    onAlwaysOn: () => log.push('always-on'),
  };
  const e = new ChordEngine(
    h,
    {
      talk: opts.talk ?? ['Control', 'Alt'],
      type: opts.type ?? ['Control', 'Alt', 'Space'],
      mode: 'hold',
      dictate: opts.dictate ?? ['Control', 'Shift', 'Space'],
      typeTap: opts.typeTap ?? ['DoubleTap', 'Control'],
      alwaysOn: opts.alwaysOn ?? ['TripleTap', 'Control'],
    },
    5,
    { tapGapMs: 30, now: () => now },
  );
  const tap = (k: string, holdMs = 50, gapMs = 100) => {
    e.keyDown(k);
    now += holdMs;
    e.keyUp(k);
    now += gapMs;
  };
  return { e, log, tap, advance: (ms: number) => (now += ms) };
}

test('dictation: hold ctrl + shift + space, release types; alt makes it a draft', async () => {
  const { e, log } = mkx();
  e.keyDown('Control'); e.keyDown('Shift'); e.keyDown('Space');
  e.keyDown('Alt');
  e.keyUp('Space');
  e.keyUp('Alt'); e.keyUp('Shift'); e.keyUp('Control');
  await wait(50);
  assert.deepEqual(log, ['dict-down', 'dict-draft', 'dict-up:draft']);
  e.dispose();
});

test('dictation started with alt already held is a draft; another key cancels', async () => {
  const { e, log } = mkx({ dictate: ['Shift', 'Fn'], talk: ['Control', 'Fn'] });
  e.keyDown('Alt'); e.keyDown('Fn'); e.keyDown('Shift');
  e.keyDown('KeyA');
  e.keyUp('KeyA'); e.keyUp('Shift'); e.keyUp('Fn'); e.keyUp('Alt');
  await wait(50);
  assert.deepEqual(log, ['dict-down:draft', 'dict-cancel']);
  e.dispose();
});

test('dictation on linux defaults does not trigger talk or type', async () => {
  const { e, log } = mkx();
  e.keyDown('Control'); e.keyDown('Shift');
  await wait(20);
  e.keyDown('Space');
  e.keyUp('Space'); e.keyUp('Shift'); e.keyUp('Control');
  await wait(50);
  assert.deepEqual(log, ['dict-down', 'dict-up']);
  e.dispose();
});

test('double-tap control opens the type box after the triple-tap window', async () => {
  const { e, log, tap } = mkx();
  tap('Control', 50, 10); tap('Control', 50, 10);
  assert.deepEqual(log, []); // waiting: a third tap could follow
  await wait(60);
  assert.deepEqual(log, ['tap-type']);
  e.dispose();
});

test('triple-tap control toggles hands-free (and not the type box)', async () => {
  const { e, log, tap } = mkx();
  tap('Control', 50, 10); tap('Control', 50, 10); tap('Control', 50, 10);
  await wait(60);
  assert.deepEqual(log, ['always-on']);
  e.dispose();
});

test('taps: too slow, held too long, or part of a chord do not count', async () => {
  const { e, log, tap, advance } = mkx();
  tap('Control', 50, 10); advance(400); tap('Control', 50, 10); // gap > 300ms (fake clock)
  await wait(60);
  tap('Control', 400, 10); tap('Control', 50, 10); // first press held too long
  await wait(60);
  e.keyDown('Control'); e.keyDown('KeyC'); e.keyUp('KeyC'); e.keyUp('Control'); // ctrl+c
  tap('Control', 50, 10);
  await wait(60);
  assert.deepEqual(log, []);
  // ctrl + alt (talk) then a single control tap: talk works, no tap fires
  e.keyDown('Control'); e.keyDown('Alt');
  await wait(15);
  e.keyUp('Alt'); e.keyUp('Control');
  assert.deepEqual(log, ['down', 'up']);
  e.dispose();
});

test('a single control tap never starts talk', async () => {
  const { e, log, tap } = mkx();
  tap('Control', 50, 10);
  await wait(60);
  assert.deepEqual(log, []);
  e.dispose();
});

test('typeTap as a chord works too', () => {
  const { e, log } = mkx({ typeTap: ['Meta', 'KeyJ'], alwaysOn: [] });
  e.keyDown('Meta'); e.keyDown('KeyJ');
  assert.deepEqual(log, ['tap-type']);
  e.dispose();
});
