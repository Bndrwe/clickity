import test from 'node:test';
import assert from 'node:assert/strict';
import { EnergyVad, looksLikeHeadphones, rmsOf } from '../src/shared/vad.ts';

function feed(vad: EnergyVad, pattern: Array<[number, number]>, frameMs = 20) {
  const events: any[] = [];
  let t = 0;
  for (const [level, ms] of pattern) {
    for (let i = 0; i < ms; i += frameMs) {
      t += frameMs;
      const e = vad.push(level, t);
      if (e) events.push(e);
    }
  }
  return events;
}

test('vad: speech ≥ 400ms then 900ms silence → one utterance', () => {
  const ev = feed(new EnergyVad(), [[0.001, 500], [0.1, 1000], [0.001, 1200]]);
  assert.deepEqual(ev.map((e) => e.type), ['start', 'end']);
  const end = ev[1];
  assert.ok(end.end - end.start >= 900 && end.end - end.start <= 1100, `${end.end - end.start}`);
});

test('vad: a short click is discarded, pauses under 900ms keep one utterance', () => {
  assert.deepEqual(feed(new EnergyVad(), [[0.001, 300], [0.2, 200], [0.001, 1200]]).map((e) => e.type), ['start', 'discard']);
  const ev = feed(new EnergyVad(), [[0.001, 300], [0.1, 600], [0.001, 600], [0.1, 600], [0.001, 1200]]);
  assert.deepEqual(ev.map((e) => e.type), ['start', 'end']);
});

test('vad: no trigger below threshold or for a blip shorter than the start debounce', () => {
  assert.deepEqual(feed(new EnergyVad(), [[0.01, 3000]]), []);
  assert.deepEqual(feed(new EnergyVad(), [[0.1, 60], [0.001, 2000]]), []);
});

test('vad: utterances are cut at maxMs', () => {
  const ev = feed(new EnergyVad({ maxMs: 2000 }), [[0.1, 3000]]);
  assert.equal(ev[1].type, 'end');
});

test('rms + headphones', () => {
  assert.equal(rmsOf([1, -1, 1, -1]), 1);
  assert.ok(looksLikeHeadphones('AirPods Pro'));
  assert.ok(looksLikeHeadphones('USB Headset'));
  assert.ok(!looksLikeHeadphones('MacBook Pro Speakers'));
});
