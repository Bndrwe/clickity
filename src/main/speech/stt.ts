// Speech-to-text over HTTPS. 'on-device' runs in the overlay renderer, never here.
import type { Settings } from '../../shared/types';

const MISSING = (name: string) => new Error(`${name} transcription: missing api key — add one in settings › voice`);

async function errorDetail(res: Response): Promise<string> {
  try {
    const t = await res.text();
    try {
      const j = JSON.parse(t);
      const m = j?.error?.message ?? j?.message ?? j?.error;
      if (typeof m === 'string') return m.slice(0, 160);
    } catch { /* not json */ }
    return t.slice(0, 160);
  } catch {
    return '';
  }
}

async function fail(name: string, res: Response): Promise<never> {
  const d = await errorDetail(res);
  throw new Error(`${name} transcription failed (${res.status})${d ? ': ' + d.toLowerCase() : ''}`);
}

async function postFetch(name: string, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (e) {
    if (init.signal?.aborted) throw e;
    throw new Error(`${name} transcription: can't reach ${new URL(url).host}`);
  }
}

async function openaiStyle(
  name: string, url: string, key: string | undefined, model: string, lang: string | undefined,
  wav: Buffer, signal?: AbortSignal,
): Promise<string> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'speech.wav');
  form.append('model', model);
  form.append('response_format', 'json');
  if (lang) form.append('language', lang);
  const headers: Record<string, string> = {};
  if (key) headers.Authorization = `Bearer ${key}`;
  const res = await postFetch(name, url, { method: 'POST', headers, body: form, signal });
  if (!res.ok) await fail(name, res);
  const j = (await res.json()) as { text?: string };
  return (j.text ?? '').trim();
}

export async function transcribe(wav: Buffer, settings: Settings, signal?: AbortSignal): Promise<string> {
  const stt = settings.speech.stt;
  const lang = stt.language?.trim() || undefined;
  switch (stt.provider) {
    case 'openai': {
      const key = stt.apiKey || settings.providers['openai-api']?.apiKey;
      if (!key) throw MISSING('openai');
      return openaiStyle('openai', 'https://api.openai.com/v1/audio/transcriptions', key,
        stt.model || 'gpt-4o-mini-transcribe', lang, wav, signal);
    }
    case 'groq': {
      if (!stt.apiKey) throw MISSING('groq');
      return openaiStyle('groq', 'https://api.groq.com/openai/v1/audio/transcriptions', stt.apiKey,
        stt.model || 'whisper-large-v3-turbo', lang, wav, signal);
    }
    case 'local': {
      const base = (stt.baseUrl || 'http://localhost:8080/v1').replace(/\/+$/, '');
      return openaiStyle('local', `${base}/audio/transcriptions`, stt.apiKey,
        stt.model || 'whisper-1', lang, wav, signal);
    }
    case 'gemini': {
      const key = stt.apiKey || settings.providers['gemini-api']?.apiKey;
      if (!key) throw MISSING('gemini');
      const model = 'gemini-2.5-flash';
      const prompt = 'transcribe verbatim, output only the words' + (lang ? ` (language: ${lang})` : '');
      const res = await postFetch('gemini', `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: 'audio/wav', data: wav.toString('base64') } }] }],
        }),
        signal,
      });
      if (!res.ok) await fail('gemini', res);
      const j = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
      return (j.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('').trim();
    }
    case 'on-device':
      throw new Error('on-device transcription runs in the overlay');
    default:
      throw new Error(`unknown transcription provider: ${String(stt.provider)}`);
  }
}
