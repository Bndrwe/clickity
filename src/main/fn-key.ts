// macOS fn (globe) key watcher. uiohook never reports fn on mac, so we run a tiny
// listen-only CGEventTap helper (native/macos/fnwatch.swift) and read JSON lines from it.
// Never throws: when the helper is missing or not permitted, fn simply isn't heard.
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export type FnStatus = 'off' | 'starting' | 'running' | 'missing' | 'no-permission' | 'error';

type FnListener = (down: boolean) => void;
type StatusListener = (s: FnStatus) => void;

const MAX_RESTARTS = 5;

let child: ChildProcess | null = null;
let status: FnStatus = 'off';
let down = false;
let restarts = 0;
let restartTimer: NodeJS.Timeout | null = null;
let wantPrompt = false;
let stopping = false;
const fnListeners = new Set<FnListener>();
const statusListeners = new Set<StatusListener>();

function setStatus(s: FnStatus): void {
  if (s === status) return;
  status = s;
  for (const cb of [...statusListeners]) {
    try { cb(s); } catch (e) { console.warn('[fn] status listener threw:', e); }
  }
}

function setDown(d: boolean): void {
  if (d === down) return;
  down = d;
  for (const cb of [...fnListeners]) {
    try { cb(d); } catch (e) { console.warn('[fn] listener threw:', e); }
  }
}

/** Where the helper lives: Contents/Resources/fnwatch when packaged, resources/mac/fnwatch in dev. */
export function helperPath(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require('electron') as typeof import('electron');
    if (app.isPackaged) return path.join(process.resourcesPath, 'fnwatch');
    return path.join(app.getAppPath(), 'resources/mac/fnwatch');
  } catch {
    return path.join(process.cwd(), 'resources/mac/fnwatch');
  }
}

/** Parse one stdout line from the helper. Exported for tests. */
export function parseLine(line: string): { fn?: boolean; ready?: boolean; error?: string } | null {
  const t = line.trim();
  if (!t) return null;
  try {
    const v = JSON.parse(t);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

function spawnHelper(): void {
  if (process.platform !== 'darwin') return;
  const bin = helperPath();
  if (!fs.existsSync(bin)) {
    console.warn(`[fn] helper not found at ${bin}; fn chords are unavailable (npm run build:fnwatch)`);
    setStatus('missing');
    return;
  }
  setStatus('starting');
  let proc: ChildProcess;
  try {
    proc = spawn(bin, wantPrompt ? ['--prompt'] : [], { stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    console.warn('[fn] could not start helper:', e);
    setStatus('error');
    return;
  }
  child = proc;
  let buf = '';
  let sawPermissionError = false;
  proc.stdout?.setEncoding('utf8');
  proc.stdout?.on('data', (chunk: string) => {
    buf += chunk;
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const msg = parseLine(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (!msg) continue;
      if (msg.ready) {
        restarts = 0;
        setStatus('running');
      }
      if (typeof msg.fn === 'boolean') setDown(msg.fn);
      if (msg.error === 'no-permission') sawPermissionError = true;
    }
  });
  proc.stderr?.on('data', (d) => console.warn('[fn] helper:', String(d).trim()));
  proc.stdin?.on('error', () => { /* helper gone */ });
  proc.on('error', (e: NodeJS.ErrnoException) => {
    console.warn('[fn] helper error:', e.message);
    if (child === proc) child = null;
    setDown(false);
    setStatus(e.code === 'ENOENT' ? 'missing' : 'error');
  });
  proc.on('exit', (code) => {
    if (child !== proc) return;
    child = null;
    setDown(false); // never leave fn stuck down
    if (stopping) return;
    if (code === 2 || sawPermissionError) {
      console.warn('[fn] helper has no input monitoring / accessibility permission');
      setStatus('no-permission');
      return;
    }
    setStatus('error');
    if (restarts < MAX_RESTARTS) {
      const delay = 1000 * 2 ** restarts++;
      restartTimer = setTimeout(() => { restartTimer = null; spawnHelper(); }, delay);
      restartTimer.unref?.();
    }
  });
}

/** Start the helper (macOS only). prompt: ask macOS for input monitoring if the tap is refused. */
export function startFnWatch(opts: { prompt?: boolean } = {}): void {
  if (process.platform !== 'darwin') return;
  wantPrompt = !!opts.prompt;
  if (child) return;
  stopping = false;
  restarts = 0;
  spawnHelper();
}

/** Stop and start again, e.g. after the user granted a permission. */
export function restartFnWatch(opts: { prompt?: boolean } = {}): void {
  stopFnWatch();
  startFnWatch(opts);
}

export function stopFnWatch(): void {
  stopping = true;
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = null;
  const p = child;
  child = null;
  if (p) {
    try { p.stdin?.end(); } catch { /* ignore */ }
    try { p.kill(); } catch { /* ignore */ }
  }
  setDown(false);
  if (status === 'running' || status === 'starting') setStatus('off');
}

export function fnStatus(): FnStatus {
  return process.platform === 'darwin' ? status : 'off';
}

export function isFnDown(): boolean {
  return down;
}

export function onFn(cb: FnListener): () => void {
  fnListeners.add(cb);
  return () => fnListeners.delete(cb);
}

export function onFnStatus(cb: StatusListener): () => void {
  statusListeners.add(cb);
  return () => statusListeners.delete(cb);
}
