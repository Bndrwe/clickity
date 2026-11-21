import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeSpeed } from '../src/shared/speed.ts';
import { DEFAULT_SETTINGS, type Settings } from '../src/shared/types.ts';

const base = (): Settings => structuredClone(DEFAULT_SETTINGS);

test('the free path is described and "make it fast" stays on-device', () => {
  const s = base();
  s.speech.stt.model = 'Xenova/whisper-small.en';
  const d = describeSpeed(s);
  assert.match(d.pipeline, /^on-device whisper small\.en · claude haiku for quick questions · natural voice \(on-device\)$/);
  assert.deepEqual(d.fastest, { speech: { stt: { model: 'Xenova/whisper-base.en' } } });
  s.speech.stt.model = 'Xenova/whisper-base.en';
  assert.equal(describeSpeed(s).fastest, null);
  assert.ok(d.hints.some((h) => /deepgram or groq/.test(h)));
  assert.ok(d.estimateMs > 1500 && d.estimateMs < 5000);
});

test('with an openai and anthropic key it streams and uses the api', () => {
  const s = base();
  s.providers['openai-api'] = { apiKey: 'sk' };
  s.providers['anthropic-api'] = { apiKey: 'ak' };
  s.speech.tts.provider = 'system';
  const d = describeSpeed(s);
  assert.deepEqual(d.fastest, {
    speech: { stt: { provider: 'openai', streaming: true, model: 'gpt-live-transcribe' }, tts: { provider: 'kokoro', voice: 'af_heart' } },
    provider: 'anthropic-api',
  });
  const after = structuredClone(s);
  after.provider = 'anthropic-api';
  after.speech.stt = { ...after.speech.stt, provider: 'openai', streaming: true };
  after.speech.tts.provider = 'kokoro';
  const d2 = describeSpeed(after);
  assert.equal(d2.fastest, null);
  assert.equal(d2.fastestNote, 'already as fast as your keys allow');
  assert.ok(d2.estimateMs <= 2000, `estimate ${d2.estimateMs}`);
  assert.match(d2.pipeline, /^streaming transcription \(openai\) · claude haiku for quick questions · natural voice/);
});

test('deepgram is kept', () => {
  const s = base();
  s.speech.stt = { ...s.speech.stt, provider: 'deepgram', apiKey: 'dg' };
  s.providers['openai-api'] = { apiKey: 'sk' };
  assert.equal(describeSpeed(s).fastest, null);
});
