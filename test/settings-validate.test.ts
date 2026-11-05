import test from 'node:test';
import assert from 'node:assert/strict';
import { fixEnums, fixFeatures } from '../src/main/settings-validate.ts';

const defaults = () => ({
  theme: 'system',
  hotkeys: { talk: ['Control', 'Alt'], type: ['Control', 'Alt', 'Space'], mode: 'hold' },
  speech: { stt: { provider: 'on-device' }, tts: { provider: 'system' } },
  companion: { offsetX: 18, offsetY: 20, actions: 'ask', maxSteps: 8, show: 'always' },
}) as any;

test('bad enums fall back to defaults', () => {
  const s = defaults();
  s.theme = 'auto'; s.hotkeys.mode = 'Hold'; s.speech.stt.provider = 'whisper'; s.speech.tts.provider = 'say'; s.companion.offsetX = null;
  fixEnums(s, defaults(), 'linux');
  assert.equal(s.theme, 'system');
  assert.equal(s.hotkeys.mode, 'hold');
  assert.equal(s.speech.stt.provider, 'on-device');
  assert.equal(s.speech.tts.provider, 'system');
  assert.equal(s.companion.offsetX, 18);
});

test('a mac fn chord is replaced on linux / windows but kept on mac', () => {
  const s = defaults(); s.hotkeys.talk = ['Control', 'Fn'];
  fixEnums(s, defaults(), 'win32');
  assert.deepEqual(s.hotkeys.talk, ['Control', 'Alt']);
  const m = defaults(); m.hotkeys.talk = ['Control', 'Fn'];
  fixEnums(m, defaults(), 'darwin');
  assert.deepEqual(m.hotkeys.talk, ['Control', 'Fn']);
});

test('agent mode: unknown actions → ask first, max steps clamped to 1–20', () => {
  const s = defaults();
  s.companion.actions = 'yolo'; s.companion.maxSteps = 99;
  fixEnums(s, defaults(), 'linux');
  assert.equal(s.companion.actions, 'ask');
  assert.equal(s.companion.maxSteps, 20);
  const t = defaults();
  t.companion.actions = 'auto'; t.companion.maxSteps = 0.2;
  fixEnums(t, defaults(), 'linux');
  assert.equal(t.companion.actions, 'auto');
  assert.equal(t.companion.maxSteps, 1);
  const u = defaults(); u.companion.maxSteps = 'x';
  fixEnums(u, defaults(), 'linux');
  assert.equal(u.companion.maxSteps, 8);
});

test('show companion: missing / unknown → always, valid values kept', () => {
  const s = defaults(); delete s.companion.show;
  fixEnums(s, defaults(), 'linux');
  assert.equal(s.companion.show, 'always');
  const t = defaults(); t.companion.show = 'never';
  fixEnums(t, defaults(), 'linux');
  assert.equal(t.companion.show, 'never');
});

test('userName: trimmed, single line, at most 40 characters, junk becomes empty', () => {
  const run = (v: unknown) => {
    const s = defaults();
    s.userName = v;
    fixFeatures(s, defaults());
    return s.userName;
  };
  assert.equal(run('  Maya \n'), 'Maya');
  assert.equal(run('x'.repeat(80)).length, 40);
  assert.equal(run(42), '');
  assert.equal(run(undefined), '');
});
