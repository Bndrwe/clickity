import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanClicky, clickyFromSuggestion, clickyIdentity, companionForClicky, parseSuggestions, settingsForClicky } from '../src/shared/clickys.ts';
import { fixWakeAndTips } from '../src/main/settings-validate.ts';

const base = () =>
  ({
    provider: 'claude-subscription',
    models: { 'claude-subscription': 'sonnet' },
    speech: { stt: {}, tts: { provider: 'system', voice: '', rate: 1 } },
    companion: { color: '', notch: 'off', scale: 1 },
    clickys: [],
    activeClicky: 'clickity',
  }) as any;

test('a clicky keeps its cursor size (clamped) and speaking style; junk is dropped', () => {
  assert.deepEqual(cleanClicky({ id: 'a', name: 'a', color: '', persona: '', scale: 9, style: 'formal' }), { id: 'a', name: 'a', color: '', persona: '', scale: 2.5, style: 'formal' });
  assert.deepEqual(cleanClicky({ id: 'a', name: 'a', color: '', persona: '', scale: 'big', style: 'shouty' }), { id: 'a', name: 'a', color: '', persona: '' });
});

test('switching clicky changes voice, cursor size and style together', () => {
  const s = base();
  s.clickys = [
    { id: 'clickity', name: 'clickity', color: '', persona: '' },
    { id: 'tutor', name: 'tutor', color: '#ff4f9a', persona: 'You teach maths.', voice: { provider: 'kokoro', voice: 'bm_george' }, scale: 1.4, style: 'playful' },
  ];
  s.activeClicky = 'tutor';
  const t = settingsForClicky(s, 'tutor');
  assert.deepEqual(t.speech.tts, { provider: 'kokoro', voice: 'bm_george', rate: 1 });
  assert.equal(t.companion.scale, 1.4);
  assert.equal(companionForClicky(s).scale, 1.4);
  assert.match(clickyIdentity(s.clickys[1]).persona, /^You teach maths\.\nSpeaking style: playful/);
  s.activeClicky = 'clickity';
  assert.equal(companionForClicky(s).scale, 1);
  assert.equal(settingsForClicky(s).speech.tts.provider, 'system');
  assert.equal(clickyIdentity(s.clickys[0]).persona, '');
  // a style alone still reaches the prompt
  assert.match(clickyIdentity({ id: 'x', name: 'x', color: '', persona: '', style: 'short' }).persona, /^Speaking style: short/);
});

test('"make a clicky" suggestions carry a kokoro voice and style when the model gives a real one', () => {
  const out = parseSuggestions('[{"name":"Coach","persona":"You coach me.","voice":"am_fenrir","style":"Chatty","color":"#1fbf5b"},{"name":"b","persona":"You b.","voice":"darth_vader","style":"loud"}]');
  assert.equal(out[0].voice, 'am_fenrir');
  assert.equal(out[0].style, 'chatty');
  assert.equal(out[0].color, '#1fbf5b');
  assert.equal(out[1].voice, undefined);
  assert.equal(out[1].style, undefined);
  const c = clickyFromSuggestion(out[0], ['clickity'], 5);
  assert.deepEqual(c, { id: 'coach', name: 'coach', color: '#1fbf5b', persona: 'You coach me.', createdAt: 5, voice: { provider: 'kokoro', voice: 'am_fenrir' }, style: 'chatty' });
});

test('wake word and tips settings: opt-in, sane values', () => {
  const d = { wakeWord: { enabled: false, sensitivity: 'medium' }, tips: { enabled: false, key: ['Control', 'Alt', 'KeyH'], perHour: 3, screenshot: false } } as any;
  const s = fixWakeAndTips({ wakeWord: { enabled: 'yes', sensitivity: 'max' }, tips: { enabled: 1, key: ['KeyH'], perHour: 50, screenshot: 'true' } } as any, d, 'linux');
  assert.deepEqual(s.wakeWord, { enabled: false, sensitivity: 'medium' });
  assert.deepEqual(s.tips, { enabled: false, key: ['Control', 'Alt', 'KeyH'], perHour: 6, screenshot: false });
  const old = fixWakeAndTips({} as any, d, 'darwin');
  assert.equal(old.wakeWord.enabled, false);
  assert.equal(old.tips.enabled, false);
  const ok = fixWakeAndTips({ wakeWord: { enabled: true, sensitivity: 'high' }, tips: { enabled: true, key: ['Meta', 'Period'], perHour: 1, screenshot: true } } as any, d, 'darwin');
  assert.deepEqual(ok.tips.key, ['Meta', 'Period']);
  assert.equal(ok.wakeWord.sensitivity, 'high');
});
