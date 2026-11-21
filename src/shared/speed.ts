// The voice pipeline in plain words + a rough "key up → first words" estimate, and what
// "make it fast" would switch to with the keys the user already saved. Pure (type imports
// only): used by main (IPC.latencyGet) and unit tested in test/speed.test.ts.
import type { DeepPartial, ProviderKind, Settings } from './types';

/** rough ms from key up to the transcript */
const STT_MS: Record<string, number> = {
  deepgram: 250,
  'openai-stream': 350,
  groq: 400,
  openai: 1100,
  local: 800,
  gemini: 1500,
};
/** rough ms to the first token (voice turn, low effort) */
const MODEL_MS: Record<ProviderKind, { fast: number; full: number }> = {
  'claude-subscription': { fast: 1300, full: 2200 },
  'anthropic-api': { fast: 500, full: 900 },
  'chatgpt-subscription': { fast: 2600, full: 3500 },
  'openai-api': { fast: 500, full: 1000 },
  'gemini-subscription': { fast: 3000, full: 4000 },
  'gemini-api': { fast: 450, full: 800 },
  openrouter: { fast: 800, full: 1300 },
  local: { fast: 700, full: 900 },
};
/** rough ms from the first sentence to its first sound */
const TTS_MS: Record<string, number> = { elevenlabs: 250, openai: 400, kokoro: 900, system: 100, off: 0 };
/** ms for the model to write the first sentence once it started */
const FIRST_SENTENCE_MS = 250;

export interface SpeedSummary {
  pipeline: string;
  estimateMs: number;
  fastest: DeepPartial<Settings> | null;
  fastestNote: string;
  hints: string[];
}

function onDeviceMs(model: string): number {
  if (/tiny/i.test(model)) return 1200;
  if (/base/i.test(model)) return 1500;
  if (/small/i.test(model)) return 2500;
  return 4000;
}

function sttKey(s: Settings, provider: string): boolean {
  if (provider === 'openai') return !!(s.speech.stt.provider === 'openai' && s.speech.stt.apiKey) || !!s.providers['openai-api']?.apiKey;
  if (provider === 'gemini') return !!(s.speech.stt.provider === 'gemini' && s.speech.stt.apiKey) || !!s.providers['gemini-api']?.apiKey;
  return s.speech.stt.provider === provider && !!s.speech.stt.apiKey;
}

function sttLabel(s: Settings): { label: string; ms: number } {
  const stt = s.speech.stt;
  switch (stt.provider) {
    case 'on-device': {
      const name = (stt.model.split('/').pop() ?? stt.model).replace(/^whisper-/, 'whisper ');
      return { label: `on-device ${name}`, ms: onDeviceMs(stt.model) };
    }
    case 'openai':
      return stt.streaming !== false ? { label: 'streaming transcription (openai)', ms: STT_MS['openai-stream']! } : { label: 'openai transcription', ms: STT_MS.openai! };
    case 'deepgram':
      return { label: 'streaming transcription (deepgram)', ms: STT_MS.deepgram! };
    case 'groq':
      return { label: 'groq whisper turbo', ms: STT_MS.groq! };
    default:
      return { label: `${stt.provider} transcription`, ms: STT_MS[stt.provider] ?? 1000 };
  }
}

function modelName(s: Settings, kind: ProviderKind): string {
  const m = s.models[kind] ?? '';
  const brand = kind.startsWith('claude') || kind === 'anthropic-api' ? 'claude ' : '';
  return `${brand}${m.replace(/^claude-/, '').replace(/-/g, ' ')}`.trim();
}

const FAST_NAME: Partial<Record<ProviderKind, string>> = {
  'claude-subscription': 'claude haiku',
  'anthropic-api': 'claude haiku',
  'chatgpt-subscription': 'gpt-6 luna',
  'openai-api': 'gpt-6 luna',
  'gemini-subscription': 'gemini flash-lite',
  'gemini-api': 'gemini flash-lite',
  openrouter: 'claude haiku',
};

function ttsLabel(s: Settings): string {
  switch (s.speech.tts.provider) {
    case 'kokoro':
      return 'natural voice (on-device)';
    case 'system':
      return 'system voice';
    case 'openai':
      return 'openai voice';
    case 'elevenlabs':
      return 'elevenlabs voice';
    default:
      return 'voice off';
  }
}

/** api provider that serves the same models as a subscription app, when its key is saved */
const API_TWIN: Partial<Record<ProviderKind, ProviderKind>> = {
  'claude-subscription': 'anthropic-api',
  'chatgpt-subscription': 'openai-api',
  'gemini-subscription': 'gemini-api',
};

export function estimate(s: Settings): number {
  const kind = s.provider;
  const fast = s.speech.fastReplies !== false && !!FAST_NAME[kind];
  const m = MODEL_MS[kind] ?? { fast: 1000, full: 1500 };
  return sttLabel(s).ms + (fast ? m.fast : m.full) + FIRST_SENTENCE_MS + (TTS_MS[s.speech.tts.provider] ?? 300);
}

export function describeSpeed(s: Settings): SpeedSummary {
  const kind = s.provider;
  const fast = s.speech.fastReplies !== false && !!FAST_NAME[kind];
  const stt = sttLabel(s);
  const pipeline = [stt.label, fast ? `${FAST_NAME[kind]} for quick questions` : modelName(s, kind), ttsLabel(s)].join(' · ');

  // what "make it fast" would do with the keys already saved
  const patch: DeepPartial<Settings> = {};
  const notes: string[] = [];
  const speech: DeepPartial<Settings['speech']> = {};
  const sttNow = s.speech.stt.provider;
  const streamingNow = (sttNow === 'deepgram' || sttNow === 'groq') && !!s.speech.stt.apiKey;
  const openaiStreaming = sttNow === 'openai' && s.speech.stt.streaming !== false;
  if (!streamingNow && !openaiStreaming && sttKey(s, 'openai')) {
    speech.stt = { provider: 'openai', streaming: true, model: 'gpt-live-transcribe' };
    notes.push('streaming transcription with your openai key');
  } else if (!streamingNow && !openaiStreaming && sttNow === 'on-device' && /small|medium|large/i.test(s.speech.stt.model)) {
    // base.en: tiny is barely faster in the worker but mishears much more
    speech.stt = { model: 'Xenova/whisper-base.en' };
    notes.push('the quick on-device whisper (base.en)');
  }
  if (s.speech.fastReplies === false) {
    speech.fastReplies = true;
    notes.push('fast replies');
  }
  const tts = s.speech.tts.provider;
  if (tts === 'system') {
    speech.tts = { provider: 'kokoro', voice: 'af_heart' };
    notes.push('the natural on-device voice');
  }
  if (Object.keys(speech).length) patch.speech = speech;
  const twin = API_TWIN[kind];
  if (twin && s.providers[twin]?.apiKey) {
    patch.provider = twin;
    notes.push(`your ${twin.replace('-api', '')} api key instead of the ${kind.replace('-subscription', '')} app (faster, billed per use)`);
  }

  const hints: string[] = [];
  if (sttNow === 'on-device' && !sttKey(s, 'openai')) hints.push('a deepgram or groq key (voice › speech to text) gets the transcript ~0.3 s after you let go');
  if (twin && !s.providers[twin]?.apiKey) hints.push(`an ${twin === 'anthropic-api' ? 'anthropic' : twin.replace('-api', '')} api key (brain) answers ~0.7 s sooner than the ${kind.replace('-subscription', '')} app`);
  if (tts === 'kokoro' || tts === 'system') hints.push('an elevenlabs or openai key (voice › text to speech) starts a cloud voice in ~0.3 s; the free natural voice needs no key');

  const fastest = Object.keys(patch).length ? patch : null;
  return {
    pipeline,
    estimateMs: estimate(s),
    fastest,
    fastestNote: notes.length ? `switches to ${notes.join(', ')}` : 'already as fast as your keys allow',
    hints,
  };
}
