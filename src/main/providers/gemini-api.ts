// Google Gemini API (AI Studio key), streamGenerateContent over SSE.
import type { ChatRequest, ModelInfo, ProviderConfig, ProviderStatus } from '../../shared/types';
import { withDefault } from './common';
import { getJson, parseJson, request, sse } from './http';
import type { Provider } from './provider';

const NAME = 'gemini api';
const BASE = 'https://generativelanguage.googleapis.com/v1beta';

const FALLBACK: ModelInfo[] = [
  { id: 'gemini-2.5-flash', label: 'gemini 2.5 flash', vision: true },
  { id: 'gemini-2.5-pro', label: 'gemini 2.5 pro', vision: true },
  { id: 'gemini-2.5-flash-lite', label: 'gemini 2.5 flash-lite', vision: true },
  { id: 'gemini-2.0-flash', label: 'gemini 2.0 flash', vision: true },
];

function key(cfg: ProviderConfig): string {
  const k = cfg.apiKey?.trim();
  if (!k) throw new Error(`${NAME}: no api key`);
  return k;
}

function buildContents(req: ChatRequest): any[] {
  const out: any[] = [];
  for (const m of req.messages) {
    const parts: any[] = [];
    if (m.role === 'user' && m.images?.length) {
      for (const im of m.images) {
        parts.push({ text: im.label });
        parts.push({ inline_data: { mime_type: im.mime, data: im.base64 } });
      }
    }
    parts.push({ text: m.text || '(no text)' });
    const role = m.role === 'assistant' ? 'model' : 'user';
    const prev = out[out.length - 1];
    if (prev && prev.role === role) prev.parts.push(...parts);
    else out.push({ role, parts });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

async function* stream(req: ChatRequest, cfg: ProviderConfig): AsyncGenerator<string> {
  const model = req.model.replace(/^models\//, '');
  const body: Record<string, any> = { contents: buildContents(req) };
  if (req.system.trim()) body.systemInstruction = { parts: [{ text: req.system }] };
  const res = await request(NAME, `${BASE}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key(cfg) },
    signal: req.signal,
    body: JSON.stringify(body),
  });
  let any = false;
  for await (const ev of sse(res, req.signal)) {
    const j = parseJson(ev.data);
    if (!j) continue;
    if (j.error) throw new Error(`${NAME}: ${String(j.error.message ?? 'stream error').toLowerCase()}`);
    if (j.promptFeedback?.blockReason) {
      throw new Error(`${NAME}: request blocked (${String(j.promptFeedback.blockReason).toLowerCase()})`);
    }
    const cand = j.candidates?.[0];
    for (const p of cand?.content?.parts ?? []) {
      if (p?.thought) continue;
      if (typeof p?.text === 'string' && p.text) {
        any = true;
        yield p.text;
      }
    }
    const fr = cand?.finishReason;
    if (!any && fr && /SAFETY|RECITATION|PROHIBITED|BLOCKLIST/.test(fr)) {
      throw new Error(`${NAME}: reply blocked (${String(fr).toLowerCase()})`);
    }
  }
}

async function listModels(cfg: ProviderConfig): Promise<ModelInfo[]> {
  try {
    const j = await getJson(NAME, `${BASE}/models?pageSize=200&key=${encodeURIComponent(key(cfg))}`, {});
    const models: ModelInfo[] = (j?.models ?? [])
      .filter((m: any) => (m.supportedGenerationMethods ?? []).includes('generateContent'))
      .map((m: any) => ({
        id: String(m.name ?? '').replace(/^models\//, ''),
        label: m.displayName ? String(m.displayName).toLowerCase() : undefined,
      }))
      .filter((m: ModelInfo) => /^gemini|^gemma|^learnlm/.test(m.id) && !/(embedding|tts|image-generation|native-audio|live)/.test(m.id))
      .map((m: ModelInfo) => ({ ...m, vision: /^gemini/.test(m.id) ? true : undefined }));
    if (models.length) return withDefault('gemini-api', models);
  } catch {
    /* fall through */
  }
  return withDefault('gemini-api', FALLBACK);
}

async function status(cfg: ProviderConfig): Promise<ProviderStatus> {
  return cfg.apiKey?.trim() ? { ok: true, detail: 'key saved' } : { ok: false, detail: 'no api key' };
}

export const geminiApi: Provider = { kind: 'gemini-api', stream, listModels, status };
