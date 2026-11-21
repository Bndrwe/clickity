// Text-to-speech. 'kokoro' (free natural on-device voice) and 'system' are synthesised by the
// overlay; openai / elevenlabs return audio bytes (synthesize, one shot: previews) or stream raw
// 24 kHz PCM (streamPcm: one sentence at a time while the reply is still being written, see
// speak-stream.ts).
import type { Settings, SpeakCommand } from '../../shared/types';

/** The usage meter (src/main/usage.ts, wired by safety.ts): characters sent to a cloud voice. */
let meter: ((provider: string, model: string, chars: number) => void) | null = null;
export function setTtsMeter(fn: typeof meter): void {
  meter = fn;
}
function metered(provider: string, model: string, chars: number): void {
  try {
    meter?.(provider, model, chars);
  } catch {
    /* never let the meter break speech */
  }
}

/** Remove markdown-ish noise so it isn't read aloud. */
export function cleanForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/[*_~`#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** test / e2e fakes: CLICKITY_OPENAI_BASE, CLICKITY_ELEVENLABS_BASE */
const base = (name: string, real: string): string => (process.env[name] || real).replace(/\/+$/, '');

export const KOKORO_DEFAULT_VOICE = 'af_heart';
const DEFAULT_STYLE = 'Warm, natural and conversational, like a friendly person sitting next to the user. Relaxed pace, light and upbeat, never robotic or announcer-like.';

function openaiInstructions(settings: Settings): string | undefined {
  const model = settings.speech.tts.model || 'gpt-4o-mini-tts';
  if (!/mini-tts|gpt-.*tts/.test(model) || /^tts-1/.test(model)) return undefined;
  return settings.speech.tts.instructions?.trim() || DEFAULT_STYLE;
}

/** Sample rate of the raw PCM streamPcm delivers. */
export const STREAM_PCM_RATE = 24000;

/**
 * Synthesise one sentence with a cloud voice and stream it as raw 16-bit mono PCM at 24 kHz.
 * `onChunk` gets even-length byte chunks as they arrive (the first one ~150–300 ms after the
 * request). Resolves when the sentence is complete. 'system' / 'kokoro' / 'off' never get here.
 */
export async function streamPcm(text: string, settings: Settings, signal: AbortSignal, onChunk: (pcm: Buffer) => void): Promise<void> {
  const tts = settings.speech.tts;
  const clean = cleanForSpeech(text);
  if (!clean) return;
  const rate = Number.isFinite(tts.rate) && tts.rate > 0 ? tts.rate : 1;
  let url: string;
  let init: RequestInit;
  let name: string;
  if (tts.provider === 'openai') {
    name = 'openai';
    const key = tts.apiKey || settings.providers['openai-api']?.apiKey;
    if (!key) throw new Error('openai speech: missing api key — add one in settings › voice');
    url = `${base('CLICKITY_OPENAI_BASE', 'https://api.openai.com/v1')}/audio/speech`;
    init = {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: tts.model || 'gpt-4o-mini-tts',
        voice: tts.voice || 'coral',
        input: clean,
        speed: Math.min(4, Math.max(0.25, rate)),
        instructions: openaiInstructions(settings),
        response_format: 'pcm',
        stream_format: 'audio',
      }),
    };
  } else if (tts.provider === 'elevenlabs') {
    name = 'elevenlabs';
    if (!tts.apiKey) throw new Error('elevenlabs speech: missing api key — add one in settings › voice');
    const voice = encodeURIComponent(tts.voice || '21m00Tcm4TlvDq8ikWAM');
    url = `${base('CLICKITY_ELEVENLABS_BASE', 'https://api.elevenlabs.io/v1')}/text-to-speech/${voice}/stream?output_format=pcm_24000&optimize_streaming_latency=3`;
    init = {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'xi-api-key': tts.apiKey, accept: 'audio/pcm' },
      body: JSON.stringify({
        text: clean,
        model_id: tts.model || 'eleven_flash_v2_5',
        voice_settings: { speed: Math.min(1.2, Math.max(0.7, rate)), stability: 0.45, similarity_boost: 0.8 },
      }),
    };
  } else {
    throw new Error(`${tts.provider} voice can't stream`);
  }
  const timeout = AbortSignal.timeout(20_000);
  const sig = AbortSignal.any([signal, timeout]);
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: sig });
  } catch (e) {
    if (signal.aborted) throw e;
    if (timeout.aborted) throw new Error(`${name} speech timed out`);
    throw new Error(`${name} speech: can't reach ${new URL(url).host}`);
  }
  if (!res.ok || !res.body) {
    const d = await detail(res);
    throw new Error(`${name} speech failed (${res.status})${d ? ': ' + d : ''}`);
  }
  metered(name, tts.model || (name === 'openai' ? 'gpt-4o-mini-tts' : 'eleven_flash_v2_5'), clean.length);
  let carry: Buffer | null = null;
  try {
    for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
      let b = Buffer.from(part);
      if (carry) {
        b = Buffer.concat([carry, b]);
        carry = null;
      }
      if (b.length % 2) {
        carry = b.subarray(b.length - 1);
        b = b.subarray(0, b.length - 1);
      }
      if (b.length) onChunk(b);
    }
  } catch (e) {
    if (signal.aborted) throw e;
    throw new Error(`${name} speech: ${timeout.aborted ? 'timed out' : 'audio stream was cut off'}`);
  }
}

async function detail(res: Response): Promise<string> {
  try {
    const t = await res.text();
    try {
      const j = JSON.parse(t);
      const m = j?.error?.message ?? j?.detail?.message ?? j?.detail ?? j?.message;
      if (typeof m === 'string') return m.slice(0, 160).toLowerCase();
    } catch { /* not json */ }
    return t.slice(0, 160).toLowerCase();
  } catch {
    return '';
  }
}

/** A hung TTS request must not hold the turn open forever: the reply is still shown without audio. */
const TTS_TIMEOUT_MS = 60_000;

async function post(name: string, url: string, init: RequestInit): Promise<ArrayBuffer> {
  const timeout = AbortSignal.timeout(TTS_TIMEOUT_MS);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal });
  } catch (e) {
    if (init.signal?.aborted) throw e;
    if (timeout.aborted) throw new Error(`${name} speech timed out`);
    throw new Error(`${name} speech: can't reach ${new URL(url).host}`);
  }
  if (!res.ok) {
    const d = await detail(res);
    throw new Error(`${name} speech failed (${res.status})${d ? ': ' + d : ''}`);
  }
  try {
    return await res.arrayBuffer();
  } catch (e) {
    if (init.signal?.aborted) throw e;
    throw new Error(`${name} speech: ${timeout.aborted ? 'timed out' : 'audio download was cut off'}`);
  }
}

export async function synthesize(text: string, settings: Settings, signal?: AbortSignal): Promise<SpeakCommand | null> {
  const tts = settings.speech.tts;
  if (tts.provider === 'off') return null;
  const clean = cleanForSpeech(text);
  if (!clean) return null;
  const rate = Number.isFinite(tts.rate) && tts.rate > 0 ? tts.rate : 1;

  switch (tts.provider) {
    case 'system':
      return { mode: 'system', text: clean, voice: tts.voice, rate };
    case 'kokoro':
      return { mode: 'kokoro', text: clean, voice: tts.voice || KOKORO_DEFAULT_VOICE, rate };
    case 'openai': {
      const key = tts.apiKey || settings.providers['openai-api']?.apiKey;
      if (!key) throw new Error('openai speech: missing api key — add one in settings › voice');
      const data = await post('openai', `${base('CLICKITY_OPENAI_BASE', 'https://api.openai.com/v1')}/audio/speech`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: tts.model || 'gpt-4o-mini-tts',
          voice: tts.voice || 'alloy',
          input: clean,
          speed: Math.min(4, Math.max(0.25, rate)),
          instructions: openaiInstructions(settings),
          response_format: 'mp3',
        }),
        signal,
      });
      metered('openai', tts.model || 'gpt-4o-mini-tts', clean.length);
      return { mode: 'audio', mime: 'audio/mpeg', data };
    }
    case 'elevenlabs': {
      if (!tts.apiKey) throw new Error('elevenlabs speech: missing api key — add one in settings › voice');
      const voice = encodeURIComponent(tts.voice || '21m00Tcm4TlvDq8ikWAM');
      const data = await post('elevenlabs', `${base('CLICKITY_ELEVENLABS_BASE', 'https://api.elevenlabs.io/v1')}/text-to-speech/${voice}?output_format=mp3_44100_128`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'xi-api-key': tts.apiKey, accept: 'audio/mpeg' },
        body: JSON.stringify({
          text: clean,
          model_id: tts.model || 'eleven_flash_v2_5',
          voice_settings: { speed: Math.min(1.2, Math.max(0.7, rate)) },
        }),
        signal,
      });
      metered('elevenlabs', tts.model || 'eleven_flash_v2_5', clean.length);
      return { mode: 'audio', mime: 'audio/mpeg', data };
    }
    default:
      throw new Error(`unknown speech provider: ${String(tts.provider)}`);
  }
}
