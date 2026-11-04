// gemini-subscription: drives Google's Gemini CLI (`gemini -p`) headlessly so the user's Google
// account / AI Pro plan is used. Gemini CLI handles its own sign-in; we never read its tokens.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ChatRequest, ModelInfo, ProviderConfig, ProviderStatus } from '../../shared/types';
import { describeImages, foldTranscript, withDefault } from './common';
import { cliFailure, cliHelp, cliVersion, makeTempDir, removeDir, requestImages, resolveBinary, runCli, writeImages } from './cli';
import { parseJson } from './http';
import type { Provider } from './provider';

const LABEL = 'gemini cli';
const LOGIN_HINT = 'click sign in, or run `gemini` in a terminal and choose "login with google"';

const MODELS: ModelInfo[] = [
  { id: 'gemini-3.8-flash', label: 'gemini 3.8 flash', vision: true },
  { id: 'gemini-4-argon', label: 'gemini 4 argon (most capable)', vision: true },
  { id: 'gemini-3.5-flash-lite', label: 'gemini 3.5 flash-lite (fastest)', vision: true },
  { id: 'gemini-3.1-pro-preview', label: 'gemini 3.1 pro (preview)', vision: true },
];

type OutputMode = 'stream-json' | 'json' | 'text';

async function outputMode(bin: string): Promise<OutputMode> {
  const help = await cliHelp(bin);
  if (/stream-json/.test(help)) return 'stream-json';
  if (/--output-format/.test(help)) return 'json';
  return 'text';
}

async function binary(cfg: ProviderConfig): Promise<string> {
  const bin = await resolveBinary('gemini', cfg.cliPath);
  if (!bin) {
    throw new Error(
      cfg.cliPath?.trim()
        ? `gemini cli not found at ${cfg.cliPath.trim().toLowerCase()}`
        : 'gemini cli not found. install it with: npm i -g @google/gemini-cli',
    );
  }
  return bin;
}

function failure(exit: { code: number | null; stderr: string; spawnError?: NodeJS.ErrnoException }, extra: string): Error {
  if (/auth method|GEMINI_API_KEY|login with google|sign in/i.test(extra + exit.stderr) && !exit.spawnError) {
    return new Error(`${LABEL} isn't signed in. ${LOGIN_HINT}`);
  }
  return cliFailure(LABEL, exit, extra, LOGIN_HINT);
}

const NOISE = /^(loaded cached credentials\.?|data collection is disabled\.?|using cached credentials.*)$/i;

async function* runOnce(
  bin: string,
  mode: OutputMode,
  req: ChatRequest,
  dir: string,
  imageNames: string[],
  state: { yielded: boolean; retryable: boolean },
): AsyncGenerator<string> {
  const body = foldTranscript(req, { includeSystem: true, imageNote: describeImages(req) });
  // images are pulled in by gemini cli's @path syntax; paths are relative to cwd (the workspace)
  const refs = imageNames.length ? `screenshots: ${imageNames.map((n) => '@' + n).join(' ')}\n\n` : '';
  // npm installs on windows run through cmd.exe, which mangles multi-line args: send the body on
  // stdin there (gemini cli prepends piped stdin to the -p prompt). elsewhere pass it all in -p.
  const viaCmdShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin);
  const pArg = viaCmdShell
    ? `${refs.replace(/\n+/g, ' ')}reply to the user's last message above.`
    : `${body}\n\n${refs}`.trim();
  const args: string[] = [];
  if (req.model.trim()) args.push('-m', req.model.trim());
  if (mode !== 'text') args.push('--output-format', mode);
  args.push('-p', pArg);

  const run = await runCli({
    bin,
    args,
    stdin: viaCmdShell ? body : '',
    cwd: dir,
    signal: req.signal,
    timeoutMs: 180_000,
  });

  let sawDelta = false;
  let errorText = '';
  let all = '';
  let firstText = true;
  for await (const line of run.lines) {
    if (mode === 'text') {
      if (NOISE.test(line.trim())) continue;
      const out = (firstText ? '' : '\n') + line;
      firstText = false;
      if (out) {
        state.yielded = true;
        yield out;
      }
      continue;
    }
    if (mode === 'json') {
      all += line + '\n';
      continue;
    }
    const j = parseJson(line);
    if (!j || typeof j !== 'object') {
      if (line.trim() && !NOISE.test(line.trim())) errorText += line + '\n';
      continue;
    }
    if (j.type === 'message' && j.role === 'assistant') {
      const text = typeof j.content === 'string' ? j.content : '';
      if (!text) continue;
      if (j.delta === true) {
        sawDelta = true;
        state.yielded = true;
        yield text;
      } else if (!sawDelta) {
        state.yielded = true;
        yield text;
      }
    } else if (j.type === 'error') {
      errorText += `${j.message ?? j.error?.message ?? ''}\n`;
    } else if (j.type === 'result') {
      if (j.status && j.status !== 'success') {
        throw failure({ code: 1, stderr: '' }, `${j.error?.message ?? j.error ?? ''}\n${errorText}`);
      }
      return;
    }
  }

  const exit = await run.exit;
  if (req.signal.aborted) return;
  if (mode === 'json') {
    const start = all.indexOf('{');
    const j = start >= 0 ? parseJson(all.slice(start)) : undefined;
    if (j?.error) throw failure(exit, String(j.error.message ?? j.error));
    if (typeof j?.response === 'string' && j.response) {
      state.yielded = true;
      yield j.response;
      return;
    }
    errorText += all;
  }
  if (state.yielded && (exit.code === 0 || exit.code === null)) return;
  if (!state.yielded && /output-format|unknown (argument|option)|invalid values/i.test(exit.stderr + errorText)) {
    state.retryable = true;
    return;
  }
  throw failure(exit, errorText);
}

async function* stream(req: ChatRequest, cfg: ProviderConfig): AsyncGenerator<string> {
  const bin = await binary(cfg);
  const dir = makeTempDir('gemini');
  try {
    const images = requestImages(req);
    const names = writeImages(images, dir).map((p) => path.basename(p));
    let mode = await outputMode(bin);
    const state = { yielded: false, retryable: false };
    yield* runOnce(bin, mode, req, dir, names, state);
    if (state.retryable && mode !== 'text') {
      // this gemini cli build rejected --output-format: fall back to plain text
      mode = 'text';
      state.retryable = false;
      yield* runOnce(bin, mode, req, dir, names, state);
      if (state.retryable) throw new Error(`${LABEL} failed (unsupported options)`);
    }
  } finally {
    removeDir(dir);
  }
}

function authKind(): string | null {
  if (process.env.GEMINI_API_KEY) return 'using gemini_api_key';
  if (process.env.GOOGLE_API_KEY || process.env.GOOGLE_GENAI_USE_VERTEXAI) return 'using google cloud credentials';
  const dir = path.join(os.homedir(), '.gemini');
  if (fs.existsSync(path.join(dir, 'oauth_creds.json'))) return 'signed in with google';
  try {
    const s = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
    const t = s?.selectedAuthType ?? s?.security?.auth?.selectedType;
    if (typeof t === 'string' && t) return t === 'oauth-personal' ? 'signed in with google' : 'auth configured';
  } catch {
    /* ignore */
  }
  try {
    const env = fs.readFileSync(path.join(dir, '.env'), 'utf8');
    if (/^\s*(GEMINI_API_KEY|GOOGLE_API_KEY)\s*=/m.test(env)) return 'using an api key';
  } catch {
    /* ignore */
  }
  return null;
}

async function status(cfg: ProviderConfig): Promise<ProviderStatus> {
  const bin = await resolveBinary('gemini', cfg.cliPath);
  if (!bin) return { ok: false, detail: cfg.cliPath?.trim() ? 'gemini not found at that path' : 'gemini not found on path' };
  const version = await cliVersion(bin);
  if (!version) return { ok: false, detail: "gemini cli found but won't run" };
  const v = version === 'installed' ? 'gemini cli' : `gemini cli ${version}`;
  const auth = authKind();
  return auth ? { ok: true, detail: `${v} · ${auth}` } : { ok: false, detail: `${v} · not signed in` };
}

export const geminiCli: Provider = {
  kind: 'gemini-subscription',
  stream,
  listModels: async () => withDefault('gemini-subscription', MODELS),
  status,
};
