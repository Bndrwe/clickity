// claude-subscription: drives Claude Code (`claude -p`) headlessly so the user's Pro/Max plan is used.
// We never touch the user's OAuth tokens: Claude Code authenticates itself.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ChatRequest, ModelInfo, ProviderConfig, ProviderStatus } from '../../shared/types';
import { foldTranscript, withDefault } from './common';
import { capture, cliFailure, cliHelp, cliVersion, makeTempDir, removeDir, requestImages, resolveBinary, runCli } from './cli';
import { openTurn, prewarm } from './claude-session';
import { parseJson } from './http';
import type { Provider } from './provider';

const LABEL = 'claude code';
const LOGIN_HINT = 'click sign in, or run `claude` in a terminal and use /login';

const MODELS: ModelInfo[] = [
  { id: 'sonnet', label: 'sonnet (latest)', vision: true },
  { id: 'opus', label: 'opus (latest)', vision: true },
  { id: 'haiku', label: 'haiku (latest)', vision: true },
  { id: 'claude-fable-5-1', label: 'claude fable 5.1 (most capable)', vision: true },
  { id: 'claude-opus-5-5', label: 'claude opus 5.5', vision: true },
  { id: 'claude-sonnet-5-5', label: 'claude sonnet 5.5', vision: true },
  { id: 'claude-haiku-5-5', label: 'claude haiku 5.5 (fastest)', vision: true },
];

// built-in tools to deny on older versions that lack `--tools ""`
const BUILTIN_TOOLS = [
  'Bash', 'BashOutput', 'KillShell', 'Edit', 'MultiEdit', 'Write', 'Read', 'Glob', 'Grep', 'LS',
  'NotebookEdit', 'NotebookRead', 'WebFetch', 'WebSearch', 'Task', 'TodoWrite', 'ExitPlanMode', 'SlashCommand',
];

function hasFlag(help: string, flag: string): boolean {
  return new RegExp(`(^|[\\s,])${flag.replace(/[-]/g, '\\-')}(?=[\\s,<=]|$)`, 'm').test(help);
}

async function binary(cfg: ProviderConfig): Promise<string> {
  const bin = await resolveBinary('claude', cfg.cliPath);
  if (!bin) {
    throw new Error(
      cfg.cliPath?.trim()
        ? `claude code not found at ${cfg.cliPath.trim().toLowerCase()}`
        : 'claude code not found. install it with: npm i -g @anthropic-ai/claude-code',
    );
  }
  return bin;
}

interface Built {
  bin: string;
  args: string[];
  /** the system prompt couldn't be passed as an argument: it goes into the user turn */
  foldSystem: boolean;
  viaCmdShell: boolean;
}

/** argv for a headless stream-json run; `system` is the prompt the process is started with. */
async function buildArgs(cfg: ProviderConfig, model: string, system: string, effort?: string): Promise<Built> {
  const bin = await binary(cfg);
  const help = await cliHelp(bin);
  const viaCmdShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin);

  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json'];
  const partial = hasFlag(help, '--include-partial-messages');
  if (partial) args.push('--include-partial-messages');
  if (model.trim()) args.push('--model', model.trim());
  // voice turns: answer quickly (5.x models think adaptively)
  if (effort && hasFlag(help, '--effort')) args.push('--effort', effort);

  // system prompt: replace claude code's coding-agent prompt when we can. Multi-line args can't
  // survive cmd.exe (npm .cmd shims on windows), so there we fold it into the user turn.
  let foldSystem = false;
  if (system.trim()) {
    if (!viaCmdShell && hasFlag(help, '--system-prompt')) args.push('--system-prompt', system);
    else if (!viaCmdShell && hasFlag(help, '--append-system-prompt')) args.push('--append-system-prompt', system);
    else foldSystem = true;
  }

  // no tools: it should just answer
  if (hasFlag(help, '--tools')) args.push('--tools', '');
  else args.push('--disallowedTools', BUILTIN_TOOLS.join(','));
  if (hasFlag(help, '--max-turns')) args.push('--max-turns', '1');
  if (hasFlag(help, '--no-session-persistence')) args.push('--no-session-persistence');
  if (hasFlag(help, '--strict-mcp-config')) args.push('--strict-mcp-config'); // no --mcp-config → no mcp servers
  if (hasFlag(help, '--disable-slash-commands')) args.push('--disable-slash-commands');
  return { bin, args, foldSystem, viaCmdShell };
}

function userLine(content: any[]): object {
  return { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: '' };
}

function imageContent(req: ChatRequest): any[] {
  const content: any[] = [];
  requestImages(req).forEach((im) => {
    content.push({ type: 'text', text: im.label });
    content.push({ type: 'image', source: { type: 'base64', media_type: im.mime, data: im.base64 } });
  });
  return content;
}

/** Parse stream-json lines of one turn into text deltas. */
async function* parseTurn(lines: AsyncIterable<string>, errors: { text: string }, state: { yielded: boolean; result: boolean }): AsyncGenerator<string> {
  let sawDelta = false;
  for await (const line of lines) {
    const j = parseJson(line);
    if (!j || typeof j !== 'object') {
      if (line.trim()) errors.text += line + '\n';
      continue;
    }
    if (j.type === 'stream_event') {
      const ev = j.event;
      if (j.parent_tool_use_id) continue;
      if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && typeof ev.delta.text === 'string') {
        sawDelta = true;
        if (ev.delta.text) {
          state.yielded = true;
          yield ev.delta.text;
        }
      }
    } else if (j.type === 'assistant') {
      if (j.error) errors.text += `${j.error}\n`;
      if (sawDelta || j.parent_tool_use_id) continue;
      for (const block of j.message?.content ?? []) {
        if (block?.type === 'text' && typeof block.text === 'string' && block.text) {
          state.yielded = true;
          yield block.text;
        }
      }
    } else if (j.type === 'result') {
      const failed = j.is_error === true || (typeof j.subtype === 'string' && j.subtype !== 'success');
      if (failed) {
        const detail = [j.result, ...(Array.isArray(j.errors) ? j.errors : []), j.subtype].filter(Boolean).join(' ');
        throw cliFailure(LABEL, { code: 1, stderr: '' }, detail + '\n' + errors.text, LOGIN_HINT);
      }
      if (!state.yielded && typeof j.result === 'string' && j.result) {
        state.yielded = true;
        yield j.result;
      }
      state.result = true;
      return;
    }
  }
}

function persistentAllowed(): boolean {
  return process.env.CLICKITY_CLAUDE_PERSISTENT !== '0';
}

async function* stream(req: ChatRequest, cfg: ProviderConfig): AsyncGenerator<string> {
  if (req.sessionKey && persistentAllowed()) {
    yield* streamPersistent(req, cfg);
    return;
  }
  const b = await buildArgs(cfg, req.model, req.system, req.effort);
  const content = imageContent(req);
  content.push({ type: 'text', text: foldTranscript(req, { includeSystem: b.foldSystem }) || '(no text)' });
  const stdin = JSON.stringify(userLine(content)) + '\n';

  const cwd = makeTempDir('claude');
  try {
    const run = await runCli({ bin: b.bin, args: b.args, stdin, cwd, signal: req.signal, timeoutMs: 180_000 });
    const errors = { text: '' };
    const state = { yielded: false, result: false };
    yield* parseTurn(run.lines, errors, state);
    if (state.result) return;
    const exit = await run.exit;
    if (req.signal.aborted) return;
    if (state.yielded && exit.code === 0) return;
    throw cliFailure(LABEL, exit, errors.text, LOGIN_HINT);
  } finally {
    removeDir(cwd);
  }
}

/** The text of the user message before the newest one (null = this is the first). */
function previousUserText(req: ChatRequest): string | null {
  let seenLast = false;
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i]!;
    if (m.role !== 'user') continue;
    if (!seenLast) {
      seenLast = true;
      continue;
    }
    return m.text;
  }
  return null;
}

/** Split the request's system prompt into the stable part (process argv) and this turn's context. */
function splitSystem(req: ChatRequest): { stable: string; dynamic: string } {
  const st = req.systemStable;
  if (st && req.system.startsWith(st)) return { stable: st, dynamic: req.system.slice(st.length).trim() };
  return { stable: req.system, dynamic: '' };
}

async function* streamPersistent(req: ChatRequest, cfg: ProviderConfig): AsyncGenerator<string> {
  const { stable, dynamic } = splitSystem(req);
  const b = await buildArgs(cfg, req.model, stable, req.effort);
  if (b.foldSystem || b.viaCmdShell) {
    // windows .cmd shims can't take the prompt as an argument: one process per turn there
    yield* stream({ ...req, sessionKey: undefined }, cfg);
    return;
  }
  const last = req.messages[req.messages.length - 1];
  const newUser = last?.role === 'user' ? last.text : '';
  const t0 = Date.now();
  const turn = await openTurn(req.sessionKey!, { bin: b.bin, args: b.args }, previousUserText(req), newUser, (continued) => {
    const content = imageContent(req);
    const context = dynamic ? `<turn_context>\n${dynamic}\n</turn_context>\n\n` : '';
    const text = continued ? `${context}${newUser.trim() || '(no text)'}` : `${context}${foldTranscript(req) || '(no text)'}`;
    content.push({ type: 'text', text });
    return userLine(content);
  }, req.signal);
  req.onNote?.(`claude code ${turn.warm ? 'warm process' : 'new process'}${turn.continued ? ', continued chat' : ''} (${Date.now() - t0}ms to send)`);
  const errors = { text: '' };
  const state = { yielded: false, result: false };
  let ok = false;
  try {
    yield* parseTurn(turn.lines, errors, state);
    ok = state.result;
    if (state.result || req.signal.aborted) return;
    throw cliFailure(LABEL, { code: null, stderr: turn.stderr() }, errors.text, LOGIN_HINT);
  } finally {
    turn.release(ok);
  }
}

/** Talk key down: start this chat's Claude Code process while the user is still talking. */
export async function prewarmClaude(cfg: ProviderConfig, key: string, model: string, system: string, effort?: string): Promise<void> {
  if (!persistentAllowed()) return;
  const b = await buildArgs(cfg, model, system, effort);
  if (b.foldSystem || b.viaCmdShell) return;
  await prewarm(key, { bin: b.bin, args: b.args });
}

async function signedIn(): Promise<boolean | null> {
  if (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN) return true;
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  if (fs.existsSync(path.join(configDir, '.credentials.json'))) return true;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'));
    if (j?.oauthAccount || j?.primaryApiKey) return true;
  } catch {
    /* ignore */
  }
  if (process.platform === 'darwin') {
    const r = await capture('/usr/bin/security', ['find-generic-password', '-s', 'Claude Code-credentials'], 5000);
    if (r.code === 0) return true;
    return false;
  }
  return false;
}

async function status(cfg: ProviderConfig): Promise<ProviderStatus> {
  const bin = await resolveBinary('claude', cfg.cliPath);
  if (!bin) return { ok: false, detail: cfg.cliPath?.trim() ? 'claude not found at that path' : 'claude not found on path' };
  const [version, signed] = await Promise.all([cliVersion(bin), signedIn()]);
  if (!version) return { ok: false, detail: "claude code found but won't run" };
  const v = version === 'installed' ? 'claude code' : `claude code ${version}`;
  return signed ? { ok: true, detail: `${v} · signed in` } : { ok: false, detail: `${v} · not signed in` };
}

export const claudeCli: Provider = {
  kind: 'claude-subscription',
  stream,
  listModels: async () => withDefault('claude-subscription', MODELS),
  status,
};
