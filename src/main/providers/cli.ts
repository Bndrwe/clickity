// Shared helpers for the subscription providers that drive official CLIs headlessly.
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createInterface } from 'node:readline';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ChatRequest, ImageInput } from '../../shared/types';
import { AbortedError, shorten } from './http';

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

/* ───────────── PATH ───────────── */

let loginShellPath: Promise<string> | null = null;

/**
 * Apps launched from Finder/Dock get a minimal PATH (/usr/bin:/bin:…). Ask the user's login
 * shell for its PATH once, so npm/homebrew-installed CLIs are found.
 */
function getLoginShellPath(): Promise<string> {
  if (isWin) return Promise.resolve('');
  if (loginShellPath) return loginShellPath;
  loginShellPath = new Promise<string>((resolve) => {
    const shell = process.env.SHELL || (isMac ? '/bin/zsh' : '/bin/bash');
    let out = '';
    let done = false;
    const finish = (v: string) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    try {
      // `printenv PATH` instead of `echo $PATH`: works in fish too (its $PATH is a list, and
      // `${PATH}` is a syntax error there); the env var itself is always ':'-joined.
      const child = spawn(shell, ['-ilc', 'echo __CLICKY_PATH__; printenv PATH; echo __CLICKY_PATH__'], {
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, DISABLE_AUTO_UPDATE: 'true' },
      });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish('');
      }, 4000);
      child.stdout?.on('data', (d) => (out += String(d)));
      child.on('error', () => {
        clearTimeout(timer);
        finish('');
      });
      child.on('close', () => {
        clearTimeout(timer);
        const m = /__CLICKY_PATH__(.*?)__CLICKY_PATH__/s.exec(out);
        finish(m?.[1]?.trim().split(/\r?\n/).pop()?.trim() ?? '');
      });
    } catch {
      finish('');
    }
  });
  return loginShellPath;
}

function extraDirs(): string[] {
  const home = os.homedir();
  if (isWin) {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    // npm's .cmd shims need node.exe on PATH too, so include the usual node install dirs
    // (official installer, nvm-windows symlink, volta) besides the CLI dirs.
    const dirs = [
      path.join(appData, 'npm'),
      path.join(home, '.local', 'bin'),
      path.join(home, '.bun', 'bin'),
      path.join(home, '.claude', 'local'),
      path.join(local, 'Programs', 'claude'),
      path.join(local, 'pnpm'),
      path.join(local, 'Volta', 'bin'),
      path.join(home, 'scoop', 'shims'),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs'),
    ];
    if (process.env.NVM_SYMLINK) dirs.push(process.env.NVM_SYMLINK);
    return dirs;
  }
  const dirs = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.local', 'bin'),
    path.join(home, '.bun', 'bin'),
    path.join(home, '.claude', 'local'),
    path.join(home, '.volta', 'bin'),
    path.join(home, '.yarn', 'bin'),
    path.join(home, '.cargo', 'bin'),
    // version managers' "current/default" bins and shims (fnm, asdf, mise, nvm)
    path.join(home, '.local', 'share', 'fnm', 'aliases', 'default', 'bin'),
    path.join(home, 'Library', 'Application Support', 'fnm', 'aliases', 'default', 'bin'),
    path.join(home, '.fnm', 'aliases', 'default', 'bin'),
    path.join(home, '.asdf', 'shims'),
    path.join(home, '.local', 'share', 'mise', 'shims'),
    path.join(home, '.nvm', 'current', 'bin'),
    path.join(home, 'Library', 'pnpm'),
    path.join(home, '.local', 'share', 'pnpm'),
    '/snap/bin',
  ];
  // nvm: newest installed node's bin
  try {
    const nvm = path.join(home, '.nvm', 'versions', 'node');
    const versions = fs.readdirSync(nvm).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const v of versions.slice(0, 3)) dirs.push(path.join(nvm, v, 'bin'));
  } catch {
    /* no nvm */
  }
  return dirs;
}

let envCache: Promise<NodeJS.ProcessEnv> | null = null;

/** process.env with an augmented PATH. Drops vars that would confuse a nested CLI. */
export function cliEnv(): Promise<NodeJS.ProcessEnv> {
  if (envCache) return envCache;
  envCache = (async () => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.CLAUDECODE; // we may be launched from inside a claude code session
    delete env.CLAUDE_CODE_ENTRYPOINT;
    const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
    const parts = new Set<string>();
    const add = (s: string | undefined) =>
      (s ?? '')
        .split(path.delimiter)
        .filter(Boolean)
        .forEach((p) => parts.add(p));
    // login-shell PATH first: launchd's/the desktop's minimal PATH (/usr/bin…) may hold stub or
    // stale copies that would otherwise shadow the user's homebrew/npm/version-manager installs.
    add(await getLoginShellPath());
    add(env[pathKey]);
    extraDirs().forEach((d) => parts.add(d));
    env[pathKey] = [...parts].join(path.delimiter);
    return env;
  })();
  return envCache;
}

function expandHome(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Find a CLI binary: the configured path if set, else search the augmented PATH.
 * Returns null when not found.
 */
export async function resolveBinary(name: string, cliPath?: string): Promise<string | null> {
  // windows only runs .exe/.cmd/.bat here: npm also drops an extensionless sh script and a .ps1
  // next to each .cmd shim, and spawning either fails, so never pick those.
  const exts = isWin ? ['.exe', '.cmd', '.bat'] : [''];
  if (cliPath?.trim()) {
    const p = expandHome(cliPath.trim().replace(/^"(.*)"$/, '$1'));
    if (isWin && !/\.(exe|cmd|bat|com)$/i.test(p)) {
      // "…\\npm\\claude" or "…\\npm\\claude.ps1" → its runnable sibling
      const base = p.replace(/\.ps1$/i, '');
      for (const e of exts) if (isFile(base + e)) return base + e;
    }
    if (isFile(p)) return p;
    // a bare name like "claude-beta": search PATH for it
    if (!p.includes('/') && !p.includes('\\')) name = p;
    else return null;
  }
  const env = await cliEnv();
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  for (let dir of (env[pathKey] ?? '').split(path.delimiter)) {
    if (isWin) dir = dir.trim().replace(/^"(.*)"$/, '$1'); // windows PATH entries may be quoted
    if (!dir) continue;
    for (const e of exts) {
      const full = path.join(dir, name + e);
      if (isFile(full)) {
        if (!isWin) {
          try {
            fs.accessSync(full, fs.constants.X_OK);
          } catch {
            continue;
          }
        }
        return full;
      }
    }
  }
  return null;
}

/* ───────────── spawning ───────────── */

/** Windows .cmd/.bat shims (npm global installs) must run through cmd.exe. */
function needsShell(bin: string): boolean {
  return isWin && /\.(cmd|bat)$/i.test(bin);
}

/**
 * Quote one argument for `cmd.exe /d /s /c "…"` running an npm .cmd shim (shell: true on windows).
 * The line is parsed twice: by cmd.exe (quotes toggle, `%VAR%` expands even inside quotes, &|<>^
 * are special outside quotes, a line break ends the command) and then by node's argv parser
 * (backslashes are literal unless they precede a quote; `""` inside quotes is a literal quote).
 * Embedded quotes become `""` so cmd's quote state never flips (a `\"` would leave the rest of the
 * argument unquoted for cmd → `&` etc. would run as commands). `%` is written as `"^%"` (close
 * quote, caret-escaped percent, reopen) because cmd has no in-quote escape for it (`%%` only works
 * inside batch files; on a /c line it stays doubled). Prompts never go through here: callers send
 * them on stdin.
 */
export function quoteCmdArg(a: string): string {
  a = a.replace(/[\r\n]+/g, ' '); // cmd.exe would cut the command at the line break
  if (a === '') return '""';
  if (!/[\s"&|<>^%!(),;=]/.test(a)) return a;
  let out = '"';
  let slashes = 0;
  for (const ch of a) {
    if (ch === '\\') {
      slashes++;
      continue;
    }
    // backslashes right before a quote we emit must be doubled to stay literal
    if (ch === '"') out += '\\'.repeat(slashes * 2) + '""';
    else if (ch === '%') out += '\\'.repeat(slashes * 2) + '"^%"';
    else out += '\\'.repeat(slashes) + ch;
    slashes = 0;
  }
  return out + '\\'.repeat(slashes * 2) + '"';
}

function spawnOpts(bin: string, args: string[], base: SpawnOptions): { cmd: string; args: string[]; opts: SpawnOptions } {
  if (needsShell(bin)) {
    const line = [quoteCmdArg(bin), ...args.map(quoteCmdArg)].join(' ');
    return { cmd: line, args: [], opts: { ...base, shell: true, windowsHide: true } };
  }
  return { cmd: bin, args, opts: { ...base, windowsHide: true } };
}

export function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (isWin && child.pid) {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
    } else {
      child.kill('SIGTERM');
      const t = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, 1500);
      t.unref?.();
    }
  } catch {
    /* already gone */
  }
}

export interface CliRun {
  /** stdout split into lines (trailing \r removed) */
  lines: AsyncIterable<string>;
  /** resolves when the process exits */
  exit: Promise<{ code: number | null; stderr: string; spawnError?: NodeJS.ErrnoException }>;
  kill(): void;
}

export interface CliRunOptions {
  bin: string;
  args: string[];
  stdin?: string;
  cwd?: string;
  signal?: AbortSignal;
  /** hard timeout for the whole run */
  timeoutMs?: number;
}

/** Spawn a CLI and stream its stdout line by line. The caller must consume `lines` or call kill(). */
export async function runCli(o: CliRunOptions): Promise<CliRun> {
  if (o.signal?.aborted) throw new AbortedError();
  const env = await cliEnv();
  const { cmd, args, opts } = spawnOpts(o.bin, o.args, {
    cwd: o.cwd ?? os.tmpdir(),
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const child = spawn(cmd, args, opts);
  let stderr = '';
  child.stderr?.on('data', (d) => {
    stderr += String(d);
    if (stderr.length > 64_000) stderr = stderr.slice(-32_000);
  });
  let spawnError: NodeJS.ErrnoException | undefined;
  const exit = new Promise<{ code: number | null; stderr: string; spawnError?: NodeJS.ErrnoException }>((resolve) => {
    child.on('error', (e) => {
      spawnError = e as NodeJS.ErrnoException;
      resolve({ code: null, stderr, spawnError });
    });
    child.on('close', (code) => resolve({ code, stderr, spawnError }));
  });
  const kill = () => killTree(child);
  const onAbort = () => kill();
  o.signal?.addEventListener('abort', onAbort, { once: true });
  let timer: NodeJS.Timeout | undefined;
  if (o.timeoutMs) {
    timer = setTimeout(() => {
      stderr += '\n__clicky_timeout__';
      kill();
    }, o.timeoutMs);
  }
  exit.finally(() => {
    o.signal?.removeEventListener('abort', onAbort);
    if (timer) clearTimeout(timer);
  });

  child.stdin?.on('error', () => {}); // EPIPE if the CLI exits early
  if (o.stdin !== undefined) child.stdin?.end(o.stdin);
  else child.stdin?.end();

  const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });
  async function* lines(): AsyncGenerator<string> {
    let finished = false;
    try {
      for await (const line of rl) {
        if (o.signal?.aborted) throw new AbortedError();
        yield line;
      }
      finished = true;
    } finally {
      rl.close();
      if (!finished) kill(); // consumer broke out early or threw
    }
    if (o.signal?.aborted) throw new AbortedError();
  }
  return { lines: lines(), exit, kill };
}

/** Run a short command and capture its output (for --version / --help / status checks). */
export async function capture(
  bin: string,
  args: string[],
  timeoutMs = 8000,
): Promise<{ code: number | null; stdout: string; stderr: string; error?: NodeJS.ErrnoException }> {
  const env = await cliEnv();
  const { cmd, args: a, opts } = spawnOpts(bin, args, { env, cwd: os.homedir(), stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (v: { code: number | null; stdout: string; stderr: string; error?: NodeJS.ErrnoException }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    let child: ChildProcess;
    try {
      child = spawn(cmd, a, opts);
    } catch (e) {
      resolve({ code: null, stdout: '', stderr: '', error: e as NodeJS.ErrnoException });
      return;
    }
    const timer = setTimeout(() => {
      killTree(child);
      done({ code: null, stdout, stderr: stderr + '\ntimed out' });
    }, timeoutMs);
    child.stdout?.on('data', (d) => (stdout += String(d)));
    child.stderr?.on('data', (d) => (stderr += String(d)));
    child.on('error', (e) => done({ code: null, stdout, stderr, error: e as NodeJS.ErrnoException }));
    child.on('close', (code) => done({ code, stdout, stderr }));
  });
}

/** Cache of `<bin> --help` output, used to detect which flags a CLI version supports. */
const helpCache = new Map<string, Promise<string>>();
export function cliHelp(bin: string, args: string[] = ['--help']): Promise<string> {
  const key = bin + '\0' + args.join(' ');
  let p = helpCache.get(key);
  if (!p) {
    p = capture(bin, args, 10_000).then((r) => r.stdout + '\n' + r.stderr);
    helpCache.set(key, p);
    // don't cache failures forever
    p.then((t) => {
      if (!t.trim()) helpCache.delete(key);
    });
  }
  return p;
}

/** First version-looking token in `<bin> --version` output. */
export async function cliVersion(bin: string): Promise<string | null> {
  const r = await capture(bin, ['--version'], 10_000);
  if (r.error) return null;
  const m = /\d+\.\d+(?:\.\d+)?(?:[-.][\w.]+)?/.exec(r.stdout + ' ' + r.stderr);
  return m ? m[0] : r.code === 0 ? 'installed' : null;
}

/* ───────────── temp files ───────────── */

export function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `clickity-${prefix}-`));
}

/**
 * Delete a temp dir in the background. On windows the CLI we just killed (taskkill is async) may
 * still hold the dir as its cwd or have a screenshot open → EBUSY/EPERM, and a one-shot rmSync
 * would leave the screenshots behind in %TEMP%. Retry for a few seconds instead.
 */
export function removeDir(dir: string): void {
  fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }).catch(() => {});
}

/** Write the request's images into `dir` (from base64) with simple names; returns absolute paths. */
export function writeImages(images: ImageInput[], dir: string): string[] {
  return images.map((im, i) => {
    const ext = im.mime === 'image/png' ? 'png' : 'jpg';
    const p = path.join(dir, `screen-${i + 1}.${ext}`);
    fs.writeFileSync(p, Buffer.from(im.base64, 'base64'));
    return p;
  });
}

/* ───────────── errors ───────────── */

/** Turn a failed CLI run into a short lowercase, user-facing error. */
export function cliFailure(
  label: string,
  r: { code: number | null; stderr: string; spawnError?: NodeJS.ErrnoException },
  extra = '',
  loginHint = 'sign in from settings',
): Error {
  if (r.spawnError) {
    if (r.spawnError.code === 'ENOENT') return new Error(`${label} not found. install it or set its path in settings`);
    if (r.spawnError.code === 'EACCES') return new Error(`${label} isn't executable (permission denied)`);
    return new Error(`${label} failed to start (${String(r.spawnError.code ?? r.spawnError.message).toLowerCase()})`);
  }
  const text = `${extra}\n${r.stderr}`;
  if (/__clicky_timeout__/.test(text)) return new Error(`${label} timed out`);
  // windows: the npm .cmd shim ran but cmd.exe couldn't find node.exe (or the shim's target)
  if (/'node(\.exe)?' is not recognized as an internal or external command/i.test(text)) {
    return new Error(`${label} needs node.js. install it from nodejs.org, then restart clickity`);
  }
  if (/is not recognized as an internal or external command|system cannot find the path specified/i.test(text)) {
    return new Error(`${label} not found. install it or set its path in settings`);
  }
  if (/not (logged|signed) in|log ?in required|please (run )?(\/)?login|unauthori[sz]ed|authenticat|invalid api key|oauth token|credentials|\b401\b/i.test(text)) {
    return new Error(`${label} isn't signed in. ${loginHint}`);
  }
  if (/rate.?limit|usage limit|quota|\b429\b|too many requests|limit reached/i.test(text)) {
    return new Error(`${label}: usage limit reached. try again later`);
  }
  if (/model.*(not found|not supported|does not exist|invalid|unavailable)|unknown model|\b404\b/i.test(text)) {
    return new Error(`${label}: model not available on your plan`);
  }
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network|getaddrinfo|fetch failed/i.test(text)) {
    return new Error(`${label}: network error`);
  }
  const lastLine = text
    .split(/\r?\n/)
    .map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').trim())
    .filter((l) => l && !/^at /.test(l))
    .pop();
  const tail = lastLine ? `: ${shorten(lastLine, 120).toLowerCase()}` : r.code !== null ? ` (exit ${r.code})` : '';
  return new Error(`${label} failed${tail}`);
}

/* ───────────── prompts ───────────── */

/** Request carrying the newest images, if any. */
export function requestImages(req: ChatRequest): ImageInput[] {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i]!;
    if (m.role === 'user') return m.images ?? [];
  }
  return [];
}

/* ───────────── terminal for login ───────────── */

function appleScriptString(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

export function shellQuote(s: string): string {
  // windows: also quote paths with cmd metacharacters (e.g. "C:\\R&D\\claude.cmd")
  if (isWin) return /[\s"&|<>^(),;=]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

function trySpawnDetached(cmd: string, args: string[], env: NodeJS.ProcessEnv, extra: SpawnOptions = {}): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore', env, cwd: os.homedir(), ...extra });
      child.once('error', () => resolve(false));
      child.once('spawn', () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}

/** Open a visible OS terminal window running `command` (a shell command line). */
export async function openTerminal(command: string): Promise<void> {
  const env = await cliEnv();
  if (isMac) {
    const script = `tell application "Terminal"\nactivate\ndo script ${appleScriptString(command)}\nend tell`;
    const ok = await trySpawnDetached('osascript', ['-e', script], env);
    if (!ok) throw new Error("couldn't open terminal");
    return;
  }
  if (isWin) {
    // start "<title>" cmd /k "<command>"  — the outer quotes are stripped by cmd /k
    const line = `/d /c start "clickity" cmd /k "${command}"`;
    const ok = await trySpawnDetached(process.env.ComSpec || 'cmd.exe', [line], env, {
      windowsVerbatimArguments: true,
      windowsHide: false,
    });
    if (!ok) throw new Error("couldn't open a command prompt");
    return;
  }
  const inner = `${command}; echo; echo "press enter to close"; read _`;
  const candidates: Array<[string, string[]]> = [
    ['x-terminal-emulator', ['-e', 'bash', '-lc', inner]],
    ['gnome-terminal', ['--', 'bash', '-lc', inner]],
    ['konsole', ['-e', 'bash', '-lc', inner]],
    ['xfce4-terminal', ['-x', 'bash', '-lc', inner]],
    ['kitty', ['bash', '-lc', inner]],
    ['alacritty', ['-e', 'bash', '-lc', inner]],
    ['xterm', ['-e', 'bash', '-lc', inner]],
  ];
  for (const [cmd, args] of candidates) {
    if (await trySpawnDetached(cmd, args, env)) return;
  }
  throw new Error(`no terminal found. run this yourself: ${command}`);
}
