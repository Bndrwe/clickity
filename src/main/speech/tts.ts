// Text-to-speech. 'system' defers to the overlay's speechSynthesis; others return audio bytes.
import type { Settings, SpeakCommand } from '../../shared/types';

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

async function post(name: string, url: string, init: RequestInit): Promise<ArrayBuffer> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (e) {
    if (init.signal?.aborted) throw e;
    throw new Error(`${name} speech: can't reach ${new URL(url).host}`);
  }
  if (!res.ok) {
    const d = await detail(res);
    throw new Error(`${name} speech failed (${res.status})${d ? ': ' + d : ''}`);
  }
  return res.arrayBuffer();
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
    case 'openai': {
      const key = tts.apiKey || settings.providers['openai-api']?.apiKey;
      if (!key) throw new Error('openai speech: missing api key — add one in settings › voice');
      const data = await post('openai', 'https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: tts.model || 'gpt-4o-mini-tts',
          voice: tts.voice || 'alloy',
          input: clean,
          speed: Math.min(4, Math.max(0.25, rate)),
          response_format: 'mp3',
        }),
        signal,
      });
      return { mode: 'audio', mime: 'audio/mpeg', data };
    }
    case 'elevenlabs': {
      if (!tts.apiKey) throw new Error('elevenlabs speech: missing api key — add one in settings › voice');
      const voice = encodeURIComponent(tts.voice || '21m00Tcm4TlvDq8ikWAM');
      const data = await post('elevenlabs', `https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'xi-api-key': tts.apiKey, accept: 'audio/mpeg' },
        body: JSON.stringify({
          text: clean,
          model_id: tts.model || 'eleven_flash_v2_5',
          voice_settings: { speed: Math.min(1.2, Math.max(0.7, rate)) },
        }),
        signal,
      });
      return { mode: 'audio', mime: 'audio/mpeg', data };
    }
    default:
      throw new Error(`unknown speech provider: ${String(tts.provider)}`);
  }
}
