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
