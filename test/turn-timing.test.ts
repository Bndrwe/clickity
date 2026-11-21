import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TurnTimer, formatTiming, timingLine } from '../src/main/turn-timing.ts';

test('stages are measured from key up, first mark wins, earlier events count as 0', () => {
  const t = new TurnTimer(7, 10_000, 3200, { stt: 'deepgram (streaming)' });
  t.mark('screenshot', 9_000); // captured at talk down
  t.mark('audioReady', 10_040);
  t.mark('transcript', 10_210);
  t.mark('transcript', 10_900);
  t.mark('firstToken', 11_400);
  t.mark('firstAudio', 11_650);
  t.mark('done', 15_200);
  const s = t.snapshot();
  assert.equal(s.screenshot, 0);
  assert.equal(s.transcript, 210);
  assert.equal(s.request, null);
  assert.equal(formatTiming(s), 'audio 40ms · transcript 210ms · screenshot 0ms · first token 1.40s · first audio 1.65s · done 5.20s');
});

test('the log line names the pipeline and notes', () => {
  const t = new TurnTimer(2, 0, 900, { stt: 'groq', model: 'claude-subscription / haiku (fast)', tts: 'kokoro' });
  t.mark('transcript', 300);
  t.note('warm claude session');
  t.note('warm claude session');
  assert.equal(timingLine(t.snapshot()), 'turn 2 (held 900ms): transcript 300ms | stt groq, model claude-subscription / haiku (fast), voice kokoro | warm claude session');
});
