import test from 'node:test';
import assert from 'node:assert/strict';
import { fixEnums } from '../src/main/settings-validate.ts';

const defaults = () => ({
  theme: 'system',
  hotkeys: { talk: ['Control', 'Alt'], type: ['Control', 'Alt', 'Space'], mode: 'hold' },
  speech: { stt: { provider: 'on-device' }, tts: { provider: 'system' } },
  companion: { offsetX: 18, offsetY: 20 },
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
