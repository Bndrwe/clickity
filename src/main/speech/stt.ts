// Speech-to-text over HTTPS. 'on-device' runs in the overlay renderer, never here.
import type { Settings } from '../../shared/types';

/** test / e2e fakes: CLICKITY_OPENAI_BASE, CLICKITY_GROQ_BASE, CLICKITY_DEEPGRAM_BASE */
const base = (name: string, real: string): string => (process.env[name] || real).replace(/\/+$/, '');

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

async function parseJson<T>(name: string, res: Response): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch {
    throw new Error(`${name} transcription: unexpected response (not json)`);
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
  wav: Buffer, signal?: AbortSignal, prompt?: string,
): Promise<string> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'speech.wav');
  form.append('model', model);
  form.append('response_format', 'json');
  if (lang) form.append('language', lang);
  // custom words (dictation dictionary): whisper's initial prompt biases spelling of names / jargon
  if (prompt) form.append('prompt', prompt.slice(0, 800));
  const headers: Record<string, string> = {};
  if (key) headers.Authorization = `Bearer ${key}`;
  const res = await postFetch(name, url, { method: 'POST', headers, body: form, signal });
  if (!res.ok) await fail(name, res);
  const j = await parseJson<{ text?: string }>(name, res);
  return (j.text ?? '').trim();
}

export async function transcribe(wav: Buffer, settings: Settings, signal?: AbortSignal, opts: { prompt?: string } = {}): Promise<string> {
  const prompt = opts.prompt?.trim() || undefined;
  const stt = settings.speech.stt;
  const lang = stt.language?.trim() || undefined;
  switch (stt.provider) {
    case 'openai': {
      const key = stt.apiKey || settings.providers['openai-api']?.apiKey;
      if (!key) throw MISSING('openai');
      return openaiStyle('openai', `${base('CLICKITY_OPENAI_BASE', 'https://api.openai.com/v1')}/audio/transcriptions`, key,
        stt.model || 'gpt-transcribe', lang, wav, signal, prompt);
    }
    case 'groq': {
      if (!stt.apiKey) throw MISSING('groq');
      return openaiStyle('groq', `${base('CLICKITY_GROQ_BASE', 'https://api.groq.com/openai/v1')}/audio/transcriptions`, stt.apiKey,
        stt.model || 'whisper-large-v3-turbo', lang, wav, signal, prompt);
    }
    case 'local': {
      const base = (stt.baseUrl || 'http://localhost:8080/v1').replace(/\/+$/, '');
      return openaiStyle('local', `${base}/audio/transcriptions`, stt.apiKey,
        stt.model || 'whisper-1', lang, wav, signal, prompt);
    }
    case 'gemini': {
      const key = stt.apiKey || settings.providers['gemini-api']?.apiKey;
      if (!key) throw MISSING('gemini');
      const model = 'gemini-3.8-flash';
      const instruction = 'transcribe verbatim, output only the words' + (lang ? ` (language: ${lang})` : '') + (prompt ? `. names and words that may appear: ${prompt}` : '');
      const res = await postFetch('gemini', `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          contents: [{ parts: [{ text: instruction }, { inline_data: { mime_type: 'audio/wav', data: wav.toString('base64') } }] }],
        }),
        signal,
      });
      if (!res.ok) await fail('gemini', res);
      const j = await parseJson<{ candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }>('gemini', res);
      return (j.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('').trim();
    }
    case 'deepgram': {
      if (!stt.apiKey) throw MISSING('deepgram');
      const q = new URLSearchParams({ model: stt.model && /^nova|^base|^enhanced/.test(stt.model) ? stt.model : 'nova-3', smart_format: 'true', punctuate: 'true' });
      if (lang) q.set('language', lang);
      const res = await postFetch('deepgram', `${base('CLICKITY_DEEPGRAM_BASE', 'https://api.deepgram.com/v1')}/listen?${q}`, {
        method: 'POST',
        headers: { Authorization: `Token ${stt.apiKey}`, 'content-type': 'audio/wav' },
        body: new Uint8Array(wav),
        signal,
      });
      if (!res.ok) await fail('deepgram', res);
      const j = await parseJson<{ results?: { channels?: Array<{ alternatives?: Array<{ transcript?: string }> }> } }>('deepgram', res);
      return (j.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? '').trim();
    }
    case 'on-device':
      throw new Error('on-device transcription runs in the overlay');
    default:
      throw new Error(`unknown transcription provider: ${String(stt.provider)}`);
  }
}
