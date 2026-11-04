// chatgpt-subscription: drives the OpenAI Codex CLI (`codex exec`) headlessly so the user's
// ChatGPT Plus/Pro plan is used. Codex handles its own sign-in; we never read its tokens.
import * as fs from 'node:fs';
import type { ChatRequest, ModelInfo, ProviderConfig, ProviderStatus } from '../../shared/types';
import { describeImages, foldTranscript, withDefault } from './common';
import { capture, cliFailure, cliVersion, makeTempDir, removeDir, requestImages, resolveBinary, runCli, writeImages } from './cli';
import { parseJson } from './http';
import type { Provider } from './provider';

const LABEL = 'codex';
const LOGIN_HINT = 'click sign in, or run `codex login` in a terminal';

const MODELS: ModelInfo[] = [
  { id: 'gpt-5', label: 'gpt-5', vision: true },
  { id: 'gpt-5.1', label: 'gpt-5.1', vision: true },
  { id: 'gpt-5-codex', label: 'gpt-5-codex', vision: true },
  { id: 'gpt-5.1-codex', label: 'gpt-5.1-codex', vision: true },
  { id: 'gpt-5.1-codex-mini', label: 'gpt-5.1-codex mini', vision: true },
  { id: 'gpt-5-mini', label: 'gpt-5 mini', vision: true },
  { id: 'o3', label: 'o3', vision: true },
];

async function binary(cfg: ProviderConfig): Promise<string> {
  const bin = await resolveBinary('codex', cfg.cliPath);
  if (!bin) {
    throw new Error(
      cfg.cliPath?.trim()
        ? `codex not found at ${cfg.cliPath.trim().toLowerCase()}`
        : 'codex cli not found. install it with: npm i -g @openai/codex',
    );
  }
  return bin;
}

/** Tracks text already emitted per message so repeated/partial snapshots only yield the new part. */
class Emitter {
  private seen = new Map<string, string>();
  any = false;
  /** full = latest full text of that message; returns the unseen suffix */
  full(id: string, text: string): string {
    const prev = this.seen.get(id) ?? '';
    this.seen.set(id, text);
    if (text.startsWith(prev)) return text.slice(prev.length);
    return prev ? '' : text; // diverged: don't repeat ourselves
  }
  delta(id: string, d: string): string {
    this.seen.set(id, (this.seen.get(id) ?? '') + d);
    return d;
  }
}

async function* stream(req: ChatRequest, cfg: ProviderConfig): AsyncGenerator<string> {
  const bin = await binary(cfg);
  const dir = makeTempDir('codex');
  try {
    const images = requestImages(req);
    const paths = images.every((im) => im.path && fs.existsSync(im.path))
      ? images.map((im) => im.path)
      : writeImages(images, dir);
    const prompt = foldTranscript(req, { includeSystem: true, imageNote: describeImages(req) });

    const args = ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', '--color', 'never'];
    if (req.model.trim()) args.push('-m', req.model.trim());
    // keep reasoning short for a snappy spoken reply
    args.push('-c', 'model_reasoning_effort=low');
    for (const p of paths) args.push('-i', p);
    // `--` ends the (variadic) -i list; `-` = read the prompt from stdin
    args.push('--', '-');

    const run = await runCli({ bin, args, stdin: prompt, cwd: dir, signal: req.signal, timeoutMs: 180_000 });
    const em = new Emitter();
    let lastError = '';
    let failed = false;
    let other = '';
    for await (const line of run.lines) {
      const j = parseJson(line);
      if (!j || typeof j !== 'object') {
        if (line.trim()) other += line + '\n';
        continue;
      }
      // newer shape: { type: 'item.completed', item: { id, type: 'agent_message', text } }
      if (typeof j.type === 'string') {
        const t: string = j.type;
        if (t.startsWith('item.')) {
          const item = j.item ?? {};
          const itype = item.type ?? item.item_type;
          if ((itype === 'agent_message' || itype === 'assistant_message') && typeof item.text === 'string') {
            const out = em.full(String(item.id ?? 'msg'), item.text);
            if (out) {
              em.any = true;
              yield out;
            }
          } else if (itype === 'error' && item.message) {
            lastError = String(item.message);
          }
          continue;
        }
        if (t === 'turn.failed') {
          failed = true;
          lastError = String(j.error?.message ?? (lastError || 'turn failed'));
          break;
        }
        if (t === 'error') {
          lastError = String(j.message ?? j.error?.message ?? 'error');
          continue;
        }
        if (t === 'turn.completed') break;
        continue;
      }
      // older shape: { id, msg: { type: 'agent_message_delta' | 'agent_message' | 'task_complete' | 'error', … } }
      const msg = j.msg;
      if (!msg || typeof msg !== 'object') continue;
      if (msg.type === 'agent_message_delta' && typeof msg.delta === 'string') {
        em.any = true;
        yield em.delta(String(j.id ?? 'legacy'), msg.delta);
      } else if (msg.type === 'agent_message' && typeof msg.message === 'string') {
        const out = em.full(String(j.id ?? 'legacy'), msg.message);
        if (out) {
          em.any = true;
          yield out;
        }
      } else if (msg.type === 'error' || msg.type === 'stream_error') {
        lastError = String(msg.message ?? 'error');
      } else if (msg.type === 'task_complete') {
        if (!em.any && typeof msg.last_agent_message === 'string' && msg.last_agent_message) {
          em.any = true;
          yield msg.last_agent_message;
        }
        break;
      }
    }
    if (req.signal.aborted) return;
    if (em.any && !failed) return;
    const exit = await run.exit;
    throw cliFailure(LABEL, exit, `${lastError}\n${other}`, LOGIN_HINT);
  } finally {
    removeDir(dir);
  }
}

async function status(cfg: ProviderConfig): Promise<ProviderStatus> {
  const bin = await resolveBinary('codex', cfg.cliPath);
  if (!bin) return { ok: false, detail: cfg.cliPath?.trim() ? 'codex not found at that path' : 'codex not found on path' };
  const version = await cliVersion(bin);
  if (!version) return { ok: false, detail: "codex found but won't run" };
  const v = version === 'installed' ? 'codex' : `codex ${version}`;
  const r = await capture(bin, ['login', 'status'], 10_000);
  const text = `${r.stdout}\n${r.stderr}`.toLowerCase();
  if (r.code === 0 && !/not logged in/.test(text)) {
    const how = /chatgpt/.test(text) ? 'signed in with chatgpt' : /api key/.test(text) ? 'using an api key' : 'signed in';
    return { ok: true, detail: `${v} · ${how}` };
  }
  return { ok: false, detail: `${v} · not signed in` };
}

export const codexCli: Provider = {
  kind: 'chatgpt-subscription',
  stream,
  listModels: async () => withDefault('chatgpt-subscription', MODELS),
  status,
};
