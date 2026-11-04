// Anthropic Messages API (direct, with the user's API key).
import type { ChatRequest, ModelInfo, ProviderConfig, ProviderStatus } from '../../shared/types';
import { withDefault } from './common';
import { getJson, parseJson, request, sse } from './http';
import type { Provider } from './provider';

const NAME = 'anthropic api';
const BASE = 'https://api.anthropic.com/v1';

const FALLBACK: ModelInfo[] = [
  { id: 'claude-sonnet-5-5', label: 'claude sonnet 5.5' },
  { id: 'claude-opus-5-5', label: 'claude opus 5.5' },
  { id: 'claude-haiku-5-5', label: 'claude haiku 5.5' },
  { id: 'claude-fable-5-1', label: 'claude fable 5.1' },
];

function headers(cfg: ProviderConfig): Record<string, string> {
  const key = cfg.apiKey?.trim();
  if (!key) throw new Error(`${NAME}: no api key`);
  return { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' };
}

function buildMessages(req: ChatRequest): any[] {
  const out: any[] = [];
  for (const m of req.messages) {
    const content: any[] = [];
    if (m.role === 'user' && m.images?.length) {
      for (const im of m.images) {
        content.push({ type: 'text', text: im.label });
        content.push({ type: 'image', source: { type: 'base64', media_type: im.mime, data: im.base64 } });
      }
    }
    content.push({ type: 'text', text: m.text || '(no text)' });
    // the api requires alternating roles: merge consecutive same-role turns
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role) prev.content.push(...content);
    else out.push({ role: m.role, content });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

async function* stream(req: ChatRequest, cfg: ProviderConfig): AsyncGenerator<string> {
  const res = await request(NAME, `${BASE}/messages`, {
    method: 'POST',
    headers: headers(cfg),
    signal: req.signal,
    body: JSON.stringify({
      model: req.model,
      // 5.x models think adaptively; leave room for thinking + a short reply,
      // and ask for low effort so the companion answers quickly.
      max_tokens: 16000,
      ...(/^claude-(fable|opus|sonnet|haiku)-5/.test(req.model) ? { output_config: { effort: 'low' } } : {}),
      system: req.system || undefined,
      messages: buildMessages(req),
      stream: true,
    }),
  });
  for await (const ev of sse(res, req.signal)) {
    const j = parseJson(ev.data);
    if (!j) continue;
    if (j.type === 'content_block_delta' && j.delta?.type === 'text_delta' && typeof j.delta.text === 'string') {
      yield j.delta.text;
    } else if (j.type === 'error' || ev.event === 'error') {
      const msg = String(j.error?.message ?? 'stream error').toLowerCase();
      const t = j.error?.type === 'overloaded_error' ? 'overloaded, try again' : msg;
      throw new Error(`${NAME}: ${t}`);
    } else if (j.type === 'message_stop') {
      return;
    }
  }
}

async function listModels(cfg: ProviderConfig): Promise<ModelInfo[]> {
  try {
    const j = await getJson(NAME, `${BASE}/models?limit=100`, headers(cfg));
    const models: ModelInfo[] = (j?.data ?? []).map((m: any) => ({
      id: String(m.id),
      label: m.display_name ? String(m.display_name).toLowerCase() : undefined,
      vision: true,
    }));
    if (models.length) return withDefault('anthropic-api', models);
  } catch {
    /* fall through */
  }
  return withDefault('anthropic-api', FALLBACK);
}

async function status(cfg: ProviderConfig): Promise<ProviderStatus> {
  return cfg.apiKey?.trim() ? { ok: true, detail: 'key saved' } : { ok: false, detail: 'no api key' };
}

export const anthropicApi: Provider = { kind: 'anthropic-api', stream, listModels, status };
