import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SpeechStream } from '../src/main/speech/speak-stream.ts';
import { DEFAULT_SETTINGS, type Settings, type SpeakCommand } from '../src/shared/types.ts';

function settings(provider: Settings['speech']['tts']['provider']): Settings {
  const s = structuredClone(DEFAULT_SETTINGS);
  s.speech.tts.provider = provider;
  s.speech.tts.apiKey = 'k';
  return s;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('kokoro: each sentence goes out as soon as it is complete, then end', async () => {
  const sent: SpeakCommand[] = [];
  let firstAt = -1;
  const ctrl = new AbortController();
  const sp = new SpeechStream({ settings: settings('kokoro'), utt: 'u1', signal: ctrl.signal, send: (c) => sent.push(c), onFirstSent: () => (firstAt = sent.length) });
  const reply = "It's the gear icon in the top right. Click it to open **settings**, then pick voice.";
  for (let i = 1; i <= reply.length; i++) {
    sp.update(reply.slice(0, i));
    if (i === 40) assert.equal(sent.length, 1, 'first sentence is out while the reply streams');
  }
  await sp.finish(reply);
  assert.equal(firstAt, 0);
  assert.deepEqual(sent.map((c) => c.mode), ['kokoro', 'kokoro', 'end']);
  assert.equal((sent[1] as { text: string }).text, 'Click it to open settings, then pick voice.');
  assert.ok(sent.every((c) => c.utt === 'u1'));
});

test('finish speaks what the final text adds (a choice question\'s options)', async () => {
  const sent: SpeakCommand[] = [];
  const sp = new SpeechStream({ settings: settings('system'), utt: 'u', signal: new AbortController().signal, send: (c) => sent.push(c) });
  sp.update('there are a few files.');
  await sp.finish('there are a few files.\nwhich one? budget or notes?');
  assert.deepEqual(sent.filter((c) => c.mode === 'system').map((c) => (c as { text: string }).text), ['there are a few files.', 'which one? budget or notes?']);
});

test('cloud pcm: requests run ahead but audio is forwarded strictly in sentence order', async () => {
  const sent: SpeakCommand[] = [];
  const delays: Record<string, number> = { 'One sentence goes first here.': 60, 'Two comes second, but it is quicker.': 5 };
  const pcm = async (text: string, _s: Settings, _sig: AbortSignal, onChunk: (b: Buffer) => void) => {
    await sleep(delays[text] ?? 1);
    for (let i = 0; i < 3; i++) {
      onChunk(Buffer.alloc(4800, text.length % 250));
      await sleep(2);
    }
  };
  const sp = new SpeechStream({ settings: settings('openai'), utt: 'p', signal: new AbortController().signal, send: (c) => sent.push(c), pcm });
  sp.update('One sentence goes first here. Two comes second, but it is quicker. ');
  await sp.finish('One sentence goes first here. Two comes second, but it is quicker.');
  const pcms = sent.filter((c) => c.mode === 'pcm') as Array<Extract<SpeakCommand, { mode: 'pcm' }>>;
  assert.equal(sent.at(-1)!.mode, 'end');
  assert.equal(pcms[0]!.text, 'One sentence goes first here.');
  const firstOfTwo = pcms.findIndex((c) => c.text?.startsWith('Two'));
  assert.ok(firstOfTwo > 0);
  assert.ok(pcms.slice(0, firstOfTwo).every((c) => new Uint8Array(c.data)[0] === 'One sentence goes first here.'.length % 250));
  assert.equal(pcms.reduce((n, c) => n + c.data.byteLength, 0), 6 * 4800);
});

test('a sentence whose cloud request fails is said with the system voice', async () => {
  const sent: SpeakCommand[] = [];
  const pcm = async () => {
    throw new Error('401');
  };
  const sp = new SpeechStream({ settings: settings('elevenlabs'), utt: 'f', signal: new AbortController().signal, send: (c) => sent.push(c), pcm });
  await sp.finish('hello there, friend.');
  assert.deepEqual(sent.map((c) => c.mode), ['system', 'end']);
});

test('cancel / abort: nothing more is sent; voice off sends nothing', async () => {
  const sent: SpeakCommand[] = [];
  const ctrl = new AbortController();
  const sp = new SpeechStream({ settings: settings('kokoro'), utt: 'c', signal: ctrl.signal, send: (c) => sent.push(c) });
  sp.update('First one is here. Second');
  ctrl.abort();
  sp.update('First one is here. Second one is here too. Third');
  await sp.finish();
  assert.equal(sent.length, 1);
  const off: SpeakCommand[] = [];
  const so = new SpeechStream({ settings: settings('off'), utt: 'o', signal: new AbortController().signal, send: (c) => off.push(c) });
  so.update('Hi there. You');
  await so.finish('Hi there. You.');
  assert.equal(off.length, 0);
});
