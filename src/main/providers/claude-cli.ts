// claude-subscription: drives Claude Code (`claude -p`) headlessly so the user's Pro/Max plan is used.
// We never touch the user's OAuth tokens: Claude Code authenticates itself.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ChatRequest, ModelInfo, ProviderConfig, ProviderStatus } from '../../shared/types';
import { foldTranscript, withDefault } from './common';
import { capture, cliFailure, cliHelp, cliVersion, makeTempDir, removeDir, requestImages, resolveBinary, runCli } from './cli';
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

async function* stream(req: ChatRequest, cfg: ProviderConfig): AsyncGenerator<string> {
  const bin = await binary(cfg);
  const help = await cliHelp(bin);
  const viaCmdShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin);

  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json'];
  const partial = hasFlag(help, '--include-partial-messages');
  if (partial) args.push('--include-partial-messages');
  if (req.model.trim()) args.push('--model', req.model.trim());

  // system prompt: replace claude code's coding-agent prompt when we can. Multi-line args can't
  // survive cmd.exe (npm .cmd shims on windows), so there we fold it into the user turn.
  let foldSystem = false;
  if (req.system.trim()) {
    if (!viaCmdShell && hasFlag(help, '--system-prompt')) args.push('--system-prompt', req.system);
    else if (!viaCmdShell && hasFlag(help, '--append-system-prompt')) args.push('--append-system-prompt', req.system);
    else foldSystem = true;
  }

  // no tools: it should just answer
  if (hasFlag(help, '--tools')) args.push('--tools', '');
  else args.push('--disallowedTools', BUILTIN_TOOLS.join(','));
  if (hasFlag(help, '--max-turns')) args.push('--max-turns', '1');
  if (hasFlag(help, '--no-session-persistence')) args.push('--no-session-persistence');
  if (hasFlag(help, '--strict-mcp-config')) args.push('--strict-mcp-config'); // no --mcp-config → no mcp servers
  if (hasFlag(help, '--disable-slash-commands')) args.push('--disable-slash-commands');

  const images = requestImages(req);
  const content: any[] = [];
  images.forEach((im) => {
    content.push({ type: 'text', text: im.label });
    content.push({ type: 'image', source: { type: 'base64', media_type: im.mime, data: im.base64 } });
  });
  content.push({ type: 'text', text: foldTranscript(req, { includeSystem: foldSystem }) || '(no text)' });
  const stdin =
    JSON.stringify({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: '' }) + '\n';

  const cwd = makeTempDir('claude');
  try {
    const run = await runCli({ bin, args, stdin, cwd, signal: req.signal, timeoutMs: 180_000 });
    let sawDelta = false;
    let yielded = false;
    let errorText = '';
    for await (const line of run.lines) {
      const j = parseJson(line);
      if (!j || typeof j !== 'object') {
        if (line.trim()) errorText += line + '\n';
        continue;
      }
      if (j.type === 'stream_event') {
        const ev = j.event;
        if (j.parent_tool_use_id) continue;
        if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && typeof ev.delta.text === 'string') {
          sawDelta = true;
          if (ev.delta.text) {
            yielded = true;
            yield ev.delta.text;
          }
        }
      } else if (j.type === 'assistant') {
        if (j.error) errorText += `${j.error}\n`;
        if (sawDelta || j.parent_tool_use_id) continue;
        for (const block of j.message?.content ?? []) {
          if (block?.type === 'text' && typeof block.text === 'string' && block.text) {
            yielded = true;
            yield block.text;
          }
        }
      } else if (j.type === 'result') {
        const failed = j.is_error === true || (typeof j.subtype === 'string' && j.subtype !== 'success');
        if (failed) {
          const detail = [j.result, ...(Array.isArray(j.errors) ? j.errors : []), j.subtype].filter(Boolean).join(' ');
          throw cliFailure(LABEL, { code: 1, stderr: '' }, detail + '\n' + errorText, LOGIN_HINT);
        }
        if (!yielded && typeof j.result === 'string' && j.result) yield j.result;
        return;
      }
    }
    const exit = await run.exit;
    if (req.signal.aborted) return;
    if (yielded && exit.code === 0) return;
    throw cliFailure(LABEL, exit, errorText, LOGIN_HINT);
  } finally {
    removeDir(cwd);
  }
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
