import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSttStream, pcmToWav, upsample16to24 } from '../src/main/speech/stt-stream.ts';
import { fakeWsServer } from './helpers/fake-ws.ts';
import { DEFAULT_SETTINGS, type Settings } from '../src/shared/types.ts';

function settings(stt: Partial<Settings['speech']['stt']>, openaiKey = ''): Settings {
  const s = structuredClone(DEFAULT_SETTINGS);
  s.speech.stt = { ...s.speech.stt, ...stt };
  if (openaiKey) s.providers['openai-api'] = { apiKey: openaiKey };
  return s;
}
const tone = (n: number) => Int16Array.from({ length: n }, (_, i) => Math.round(Math.sin(i / 8) * 8000));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('pcm helpers: wav header and 16→24 kHz', () => {
  const wav = pcmToWav(tone(160));
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.length, 44 + 320);
  assert.equal(upsample16to24(tone(1600)).length, 2400);
});

test('openai realtime: session.update, streamed appends, commit at key up → completed transcript', async () => {
  const seen: any[] = [];
  let auth = '';
  let path = '';
  const srv = await fakeWsServer((ws) => {
    auth = String(ws.headers.authorization ?? '');
    path = ws.path;
    ws.onText((t) => {
      const j = JSON.parse(t);
      seen.push(j);
      if (j.type === 'input_audio_buffer.append' && seen.filter((x) => x.type === 'input_audio_buffer.append').length === 2) {
        ws.sendJson({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'it1', delta: 'what is ' });
      }
      if (j.type === 'input_audio_buffer.commit') {
        ws.sendJson({ type: 'input_audio_buffer.committed', item_id: 'it1' });
        setTimeout(() => ws.sendJson({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'it1', transcript: 'what is this button?' }), 20);
      }
    });
  });
  try {
    const s = createSttStream(settings({ provider: 'openai', model: '' }, 'sk-test'), { openaiBase: srv.url + '/v1' })!;
    assert.match(s.label, /gpt-live-transcribe \(streaming\)/);
    for (let i = 0; i < 4; i++) {
      s.push(tone(1600));
      await sleep(10);
    }
    const t0 = Date.now();
    const text = await s.finish();
    assert.equal(text, 'what is this button?');
    assert.ok(Date.now() - t0 < 500);
    assert.equal(auth, 'Bearer sk-test');
    assert.equal(path, '/v1/realtime?intent=transcription');
    const upd = seen[0];
    assert.equal(upd.type, 'session.update');
    assert.equal(upd.session.type, 'transcription');
    assert.deepEqual(upd.session.audio.input.format, { type: 'audio/pcm', rate: 24000 });
    assert.equal(upd.session.audio.input.transcription.model, 'gpt-live-transcribe');
    assert.equal(upd.session.audio.input.turn_detection, null);
    const appended = seen.filter((x) => x.type === 'input_audio_buffer.append').reduce((n, x) => n + Buffer.from(x.audio, 'base64').length / 2, 0);
    assert.equal(appended, 4 * 2400); // every sample, at 24 kHz
    assert.equal(s.partial, 'what is ');
  } finally {
    await srv.close();
  }
});

test('openai realtime: a failing stream falls back to the https upload of the same audio', async () => {
  let uploads = 0;
  const srv = await fakeWsServer(
    (ws) => ws.onText((t) => {
      if (JSON.parse(t).type === 'session.update') ws.sendJson({ type: 'error', error: { code: 'invalid_api_key', message: 'bad key' } });
    }),
    (req, res, body) => {
      uploads++;
      assert.equal(req.url, '/v1/audio/transcriptions');
      assert.ok(body.includes(Buffer.from('gpt-transcribe')));
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ text: 'hello there' }));
    },
  );
  process.env.CLICKITY_OPENAI_BASE = srv.url + '/v1';
  try {
    const s = createSttStream(settings({ provider: 'openai' }, 'sk-x'), { openaiBase: srv.url + '/v1' })!;
    s.push(tone(8000));
    await sleep(50);
    assert.equal(await s.finish(), 'hello there');
    assert.equal(uploads, 1);
    assert.match(s.notes.join(), /uploaded instead/);
  } finally {
    delete process.env.CLICKITY_OPENAI_BASE;
    await srv.close();
  }
});

test('deepgram: subprotocol auth, binary frames, Finalize → finals joined', async () => {
  let bytes = 0;
  let proto = '';
  let path = '';
  const srv = await fakeWsServer((ws) => {
    proto = String(ws.headers['sec-websocket-protocol']);
    path = ws.path;
    ws.onBinary((b) => {
      bytes += b.length;
      if (bytes === 3200 * 2) ws.sendJson({ type: 'Results', is_final: true, channel: { alternatives: [{ transcript: 'open the' }] } });
      else ws.sendJson({ type: 'Results', is_final: false, channel: { alternatives: [{ transcript: 'open' }] } });
    });
    ws.onText((t) => {
      if (JSON.parse(t).type === 'Finalize') {
        ws.sendJson({ type: 'Results', is_final: true, from_finalize: true, channel: { alternatives: [{ transcript: 'settings menu' }] } });
      }
    });
  });
  try {
    const s = createSttStream(settings({ provider: 'deepgram', model: '', apiKey: 'dg-key', language: 'en' }), { deepgramBase: srv.url + '/v1', prompt: 'clickity, kokoro' })!;
    s.push(tone(3200));
    s.push(tone(3200));
    await sleep(60);
    assert.equal(await s.finish(), 'open the settings menu');
    assert.equal(proto, 'token, dg-key');
    assert.match(path, /^\/v1\/listen\?model=nova-3&encoding=linear16&sample_rate=16000/);
    assert.match(path, /language=en/);
    assert.match(path, /keyterm=clickity&keyterm=kokoro/);
    assert.equal(bytes, 12800);
  } finally {
    await srv.close();
  }
});

test('deepgram: final words that never come → the words heard so far', async () => {
  const srv = await fakeWsServer((ws) => ws.onBinary(() => ws.sendJson({ type: 'Results', is_final: false, channel: { alternatives: [{ transcript: 'almost there' }] } })));
  try {
    const s = createSttStream(settings({ provider: 'deepgram', apiKey: 'k' }), { deepgramBase: srv.url + '/v1', finalTimeoutMs: 150 })!;
    s.push(tone(3200));
    await sleep(40);
    assert.equal(await s.finish(), 'almost there');
  } finally {
    await srv.close();
  }
});

test('groq: the audio is already in main at key up and uploaded right away', async () => {
  let got = 0;
  const srv = await fakeWsServer(() => undefined, (req, res, body) => {
    got = body.length;
    assert.equal(req.headers.authorization, 'Bearer gq');
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ text: ' turbo fast ' }));
  });
  process.env.CLICKITY_GROQ_BASE = srv.url + '/openai/v1';
  try {
    const s = createSttStream(settings({ provider: 'groq', apiKey: 'gq', model: 'whisper-large-v3-turbo' }))!;
    s.push(tone(16000));
    assert.equal(await s.finish(), 'turbo fast');
    assert.ok(got > 32000);
  } finally {
    delete process.env.CLICKITY_GROQ_BASE;
    await srv.close();
  }
});

test('on-device has no main-side stream', () => {
  assert.equal(createSttStream(settings({ provider: 'on-device' })), null);
});
