// OpenAI Chat Completions (streaming) — shared by openai-api, openrouter and local.
import type { ChatRequest, ModelInfo, ProviderConfig, ProviderStatus } from '../../shared/types';
import { withDefault } from './common';
import { getJson, parseJson, request, sse, stripTrailingSlash, withTimeout } from './http';
import type { Provider } from './provider';

interface CompatOptions {
  name: string;
  baseUrl(cfg: ProviderConfig): string;
  keyRequired: boolean;
  extraHeaders?: Record<string, string>;
  /** tweak the request body per backend */
  shapeBody?(body: Record<string, any>, model: string): void;
}

function buildMessages(req: ChatRequest): any[] {
  const out: any[] = [];
  if (req.system.trim()) out.push({ role: 'system', content: req.system });
  for (const m of req.messages) {
    if (m.role === 'user' && m.images?.length) {
      const content: any[] = [];
      for (const im of m.images) {
        content.push({ type: 'text', text: im.label });
        content.push({ type: 'image_url', image_url: { url: `data:${im.mime};base64,${im.base64}` } });
      }
      content.push({ type: 'text', text: m.text || '(no text)' });
      out.push({ role: 'user', content });
    } else {
      out.push({ role: m.role, content: m.text || '(no text)' });
    }
  }
  return out;
}

function headersFor(o: CompatOptions, cfg: ProviderConfig): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json', ...(o.extraHeaders ?? {}) };
  const key = cfg.apiKey?.trim();
  if (key) h.authorization = `Bearer ${key}`;
  else if (o.keyRequired) throw new Error(`${o.name}: no api key`);
  return h;
}

export async function* compatStream(o: CompatOptions, req: ChatRequest, cfg: ProviderConfig): AsyncGenerator<string> {
  const body: Record<string, any> = { model: req.model, messages: buildMessages(req), stream: true };
  o.shapeBody?.(body, req.model);
  const res = await request(o.name, `${stripTrailingSlash(o.baseUrl(cfg))}/chat/completions`, {
    method: 'POST',
    headers: headersFor(o, cfg),
    signal: req.signal,
    body: JSON.stringify(body),
  });
  for await (const ev of sse(res, req.signal)) {
    if (ev.data === '[DONE]') return;
    const j = parseJson(ev.data);
    if (!j) continue;
    if (j.error) {
      const msg = typeof j.error === 'string' ? j.error : j.error.message ?? 'stream error';
      throw new Error(`${o.name}: ${String(msg).toLowerCase()}`);
    }
    const choice = j.choices?.[0];
    const delta = choice?.delta?.content;
    if (typeof delta === 'string' && delta) yield delta;
    else if (Array.isArray(delta)) {
      for (const p of delta) if (typeof p?.text === 'string' && p.text) yield p.text;
    }
    if (choice?.finish_reason === 'error') throw new Error(`${o.name}: the model stopped with an error`);
  }
}

export async function compatModels(o: CompatOptions, cfg: ProviderConfig): Promise<any[]> {
  const j = await getJson(o.name, `${stripTrailingSlash(o.baseUrl(cfg))}/models`, headersFor(o, cfg));
  return Array.isArray(j?.data) ? j.data : Array.isArray(j) ? j : [];
}

/* ───────────── openai api ───────────── */

const OPENAI: CompatOptions = {
  name: 'openai api',
  baseUrl: () => 'https://api.openai.com/v1',
  keyRequired: true,
  shapeBody(body, model) {
    const reasoning = /^(o\d|gpt-5)/.test(model) && !/chat/.test(model);
    if (reasoning) {
      // reasoning tokens count against max_completion_tokens; keep effort low for snappy replies
      body.reasoning_effort = 'low';
    } else {
      body.max_completion_tokens = 1024;
    }
  },
};

const OPENAI_FALLBACK: ModelInfo[] = [
  { id: 'gpt-4.1', label: 'gpt-4.1' },
  { id: 'gpt-4.1-mini', label: 'gpt-4.1 mini' },
  { id: 'gpt-4o', label: 'gpt-4o' },
  { id: 'gpt-4o-mini', label: 'gpt-4o mini' },
  { id: 'gpt-5', label: 'gpt-5' },
  { id: 'gpt-5-mini', label: 'gpt-5 mini' },
  { id: 'o4-mini', label: 'o4-mini' },
  { id: 'o3', label: 'o3' },
];

function isOpenAIChatModel(id: string): boolean {
  if (!/^(gpt-|o\d|chatgpt-)/.test(id)) return false;
  return !/(audio|realtime|transcribe|tts|embedding|image|search|instruct|moderation|codex|computer-use|-pro|davinci|babbage)/.test(id);
}

export const openaiApi: Provider = {
  kind: 'openai-api',
  stream: (req, cfg) => compatStream(OPENAI, req, cfg),
  async listModels(cfg) {
    try {
      const data = await compatModels(OPENAI, cfg);
      const models: ModelInfo[] = data
        .map((m: any) => String(m.id ?? ''))
        .filter(isOpenAIChatModel)
        .sort()
        .map((id: string) => ({ id, vision: !/^(gpt-3\.5|o1-mini|o3-mini)/.test(id) }));
      if (models.length) return withDefault('openai-api', models);
    } catch {
      /* fall through */
    }
    return withDefault('openai-api', OPENAI_FALLBACK);
  },
  async status(cfg): Promise<ProviderStatus> {
    return cfg.apiKey?.trim() ? { ok: true, detail: 'key saved' } : { ok: false, detail: 'no api key' };
  },
};

/* ───────────── openrouter ───────────── */

const OPENROUTER: CompatOptions = {
  name: 'openrouter',
  baseUrl: () => 'https://openrouter.ai/api/v1',
  keyRequired: true,
  extraHeaders: { 'HTTP-Referer': 'https://github.com/Bndrwe/clickity', 'X-Title': 'clickity' },
  shapeBody(body) {
    body.max_tokens = 1024;
  },
};

const OPENROUTER_FALLBACK: ModelInfo[] = [
  { id: 'anthropic/claude-sonnet-4.5', label: 'claude sonnet 4.5', vision: true },
  { id: 'anthropic/claude-haiku-4.5', label: 'claude haiku 4.5', vision: true },
  { id: 'openai/gpt-4.1', label: 'gpt-4.1', vision: true },
  { id: 'openai/gpt-5', label: 'gpt-5', vision: true },
  { id: 'google/gemini-2.5-flash', label: 'gemini 2.5 flash', vision: true },
  { id: 'google/gemini-2.5-pro', label: 'gemini 2.5 pro', vision: true },
  { id: 'qwen/qwen2.5-vl-72b-instruct', label: 'qwen2.5 vl 72b', vision: true },
];

export const openrouter: Provider = {
  kind: 'openrouter',
  stream: (req, cfg) => compatStream(OPENROUTER, req, cfg),
  async listModels(cfg) {
    try {
      // the model list is public; send the key only if we have one
      const h: Record<string, string> = { ...OPENROUTER.extraHeaders };
      if (cfg.apiKey?.trim()) h.authorization = `Bearer ${cfg.apiKey.trim()}`;
      const j = await getJson('openrouter', 'https://openrouter.ai/api/v1/models', h);
      const data: any[] = Array.isArray(j?.data) ? j.data : [];
      const models: ModelInfo[] = data
        .map((m: any) => {
          const mods: unknown = m.architecture?.input_modalities;
          const vision = Array.isArray(mods)
            ? mods.includes('image')
            : typeof m.architecture?.modality === 'string'
              ? /image/.test(String(m.architecture.modality).split('->')[0] ?? '')
              : undefined;
          return { id: String(m.id ?? ''), label: m.name ? String(m.name).toLowerCase() : undefined, vision };
        })
        .filter((m: ModelInfo) => m.id)
        // vision models first, then alphabetical
        .sort((a: ModelInfo, b: ModelInfo) => Number(b.vision === true) - Number(a.vision === true) || a.id.localeCompare(b.id));
      if (models.length) return withDefault('openrouter', models);
    } catch {
      /* fall through */
    }
    return withDefault('openrouter', OPENROUTER_FALLBACK);
  },
  async status(cfg): Promise<ProviderStatus> {
    return cfg.apiKey?.trim() ? { ok: true, detail: 'key saved' } : { ok: false, detail: 'no api key' };
  },
};

/* ───────────── local (ollama, lm studio, llama.cpp, vllm…) ───────────── */

export const DEFAULT_LOCAL_BASE = 'http://localhost:11434/v1';

function localBase(cfg: ProviderConfig): string {
  let b = cfg.baseUrl?.trim() || DEFAULT_LOCAL_BASE;
  if (!/^https?:\/\//i.test(b)) b = `http://${b}`;
  return stripTrailingSlash(b);
}

function looksLikeOllama(base: string): boolean {
  return /:11434\b/.test(base) || /ollama/i.test(base);
}

/** Ollama's native root (strip a trailing /v1). */
function ollamaRoot(base: string): string {
  return base.replace(/\/v1$/i, '');
}

const LOCAL: CompatOptions = {
  name: 'local model',
  baseUrl: localBase,
  keyRequired: false,
  shapeBody(body) {
    body.max_tokens = 1024;
  },
};

const LOCAL_FALLBACK: ModelInfo[] = [
  { id: 'qwen2.5vl:7b', label: 'qwen2.5-vl 7b (ollama)', vision: true },
  { id: 'gemma3:12b', label: 'gemma 3 12b (ollama)', vision: true },
  { id: 'llama3.2-vision:11b', label: 'llama 3.2 vision 11b (ollama)', vision: true },
  { id: 'llava:13b', label: 'llava 13b (ollama)', vision: true },
];

const VISION_HINT = /(vl|vision|llava|gemma3|gemma-3|pixtral|minicpm-v|moondream|bakllava|mllama|qwen2\.5-?omni|llama4|mistral-small3\.[12])/i;

async function localModelIds(cfg: ProviderConfig, signal?: AbortSignal): Promise<string[]> {
  const base = localBase(cfg);
  const ids: string[] = [];
  let firstErr: unknown;
  try {
    const h: Record<string, string> = {};
    if (cfg.apiKey?.trim()) h.authorization = `Bearer ${cfg.apiKey.trim()}`;
    const j = await getJson(LOCAL.name, `${base}/models`, h, signal);
    const data: any[] = Array.isArray(j?.data) ? j.data : Array.isArray(j?.models) ? j.models : [];
    for (const m of data) {
      const id = m?.id ?? m?.name ?? m?.model;
      if (id) ids.push(String(id));
    }
  } catch (e) {
    firstErr = e;
  }
  if (looksLikeOllama(base)) {
    try {
      const j = await getJson(LOCAL.name, `${ollamaRoot(base)}/api/tags`, {}, signal);
      for (const m of j?.models ?? []) {
        const id = m?.name ?? m?.model;
        if (id && !ids.includes(String(id))) ids.push(String(id));
      }
    } catch (e) {
      firstErr ??= e;
    }
  }
  if (!ids.length && firstErr) throw firstErr;
  return ids;
}

export const local: Provider = {
  kind: 'local',
  stream: (req, cfg) => compatStream(LOCAL, req, cfg),
  async listModels(cfg) {
    try {
      const ids = await localModelIds(cfg);
      if (ids.length) {
        return withDefault(
          'local',
          ids.map((id) => ({ id, vision: VISION_HINT.test(id) ? true : undefined })),
        );
      }
    } catch {
      /* fall through */
    }
    return withDefault('local', LOCAL_FALLBACK);
  },
  async status(cfg): Promise<ProviderStatus> {
    const base = localBase(cfg);
    try {
      const ids = await localModelIds(cfg, withTimeout(3000));
      const who = looksLikeOllama(base) ? 'ollama' : 'local server';
      if (!ids.length) return { ok: false, detail: `${who} · no models installed` };
      return { ok: true, detail: `${who} · ${ids.length} model${ids.length === 1 ? '' : 's'}` };
    } catch {
      return { ok: false, detail: `can't reach ${base}` };
    }
  },
};
