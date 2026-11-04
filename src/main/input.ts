// Agent mode: performs clicks, typing, key chords and scrolling on the user's screen.
//   macOS   — native/macos/clickity-input.swift (CGEvent), long-lived, JSON lines over stdio
//   Windows — long-lived PowerShell + C# SendInput wrapper (src/main/input-win.ts)
//   Linux   — xdotool (X11 / XWayland)
// Coordinates arrive as global DIP (Electron screen coordinates) and are clamped to the
// display they land on. Every action is logged (typed text by length only).
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { app, screen } from 'electron';
import type { InputAction, InputStatus } from '../shared/types';
import { log } from './log';
import {
  clampToRect, dipToX11, macChord, toWinAbsolute, winChord, xdoChord, type Pt, type Rect,
} from './input-keys';
import { winPowershellArgs } from './input-win';

const GAP_MS = 60;
const MAX_WAIT_MS = 10_000;
const MAX_TEXT = 5000;

export const MAC_ACCESSIBILITY_HINT =
  'needs accessibility: allow clickity in system settings › privacy & security › accessibility';
const XDOTOOL_HINT = 'install xdotool (sudo apt install xdotool)';
const WAYLAND_HINT = 'agent mode needs x11 (or xwayland)';

/* ───────────────────────── helpers ───────────────────────── */

function abortError(): Error {
  const e = new Error('stopped');
  e.name = 'AbortError';
  return e;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Clamp a global-DIP point onto the display it is nearest to. */
function targetPoint(x: number, y: number): { p: Pt; display: Electron.Display } {
  if (!finite(x) || !finite(y)) throw new Error('bad coordinates');
  const display = screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) });
  return { p: clampToRect({ x, y }, display.bounds), display };
}

function describe(a: InputAction): string {
  switch (a.type) {
    case 'click': return `click ${a.button ?? 'left'}${a.count === 2 ? ' x2' : ''} at ${Math.round(a.x)},${Math.round(a.y)}${a.label ? ` (${a.label})` : ''}`;
    case 'move': return `move to ${Math.round(a.x)},${Math.round(a.y)}`;
    case 'scroll': return `scroll dy=${a.dy}${a.dx ? ` dx=${a.dx}` : ''} at ${Math.round(a.x)},${Math.round(a.y)}`;
    case 'type': return `type ${typeof a.text === 'string' ? a.text.length : 0} chars`;
    case 'key': return `key ${Array.isArray(a.keys) ? a.keys.join('+') : '?'}`;
    case 'wait': return `wait ${a.ms}ms`;
    default: return `unknown ${(a as { type?: unknown }).type}`;
  }
}

function lines(n: unknown): number {
  if (n === undefined) return 0;
  if (!finite(n)) throw new Error('bad scroll amount');
  return Math.max(-50, Math.min(50, Math.round(n)));
}

/* ───────────────────────── long-lived line worker (mac + windows) ───────────────────────── */

interface Pending { resolve(line: string): void; reject(e: Error): void; timer: NodeJS.Timeout }

class LineWorker {
  private proc: ChildProcess | null = null;
  private buf = '';
  private waiting: Pending[] = [];
  private starting: Promise<void> | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private crashes: number[] = [];

  constructor(
    private readonly name: string,
    private readonly launch: () => ChildProcess,
    private readonly readyLine: string | null,
    private readonly startTimeoutMs: number,
  ) {}

  /** Send one line, resolve with the reply line. Requests are serialised. */
  request(line: string, timeoutMs: number): Promise<string> {
    const run = () => this.send(line, timeoutMs);
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }

  stop(): void {
    const p = this.proc;
    this.proc = null;
    this.starting = null;
    this.failAll(new Error('input helper stopped'));
    if (p) {
      try { p.stdin?.end(); } catch { /* ignore */ }
      try { p.kill(); } catch { /* ignore */ }
    }
  }

  private failAll(e: Error): void {
    const w = this.waiting;
    this.waiting = [];
    for (const p of w) {
      clearTimeout(p.timer);
      p.reject(e);
    }
  }

  private ensure(): Promise<void> {
    if (this.proc && !this.starting) return Promise.resolve();
    if (this.starting) return this.starting;
    const now = Date.now();
    this.crashes = this.crashes.filter((t) => now - t < 60_000);
    if (this.crashes.length >= 5) return Promise.reject(new Error('input helper keeps crashing; see logs'));

    this.starting = new Promise<void>((resolve, reject) => {
      let proc: ChildProcess;
      try {
        proc = this.launch();
      } catch (e) {
        this.starting = null;
        return reject(new Error(`could not start input helper: ${(e as Error).message}`));
      }
      this.proc = proc;
      this.buf = '';
      let ready = this.readyLine === null;
      let stderr = '';
      const startTimer = setTimeout(() => {
        if (ready) return;
        log('input', `${this.name} did not start in ${this.startTimeoutMs}ms`, stderr.slice(-300));
        this.stop();
        reject(new Error('input helper did not start'));
      }, this.startTimeoutMs);
      if (ready) {
        clearTimeout(startTimer);
        resolve();
      }
      proc.stdout?.setEncoding('utf8');
      proc.stdout?.on('data', (chunk: string) => {
        this.buf += chunk;
        let i: number;
        while ((i = this.buf.indexOf('\n')) >= 0) {
          const l = this.buf.slice(0, i).replace(/\r$/, '').trim();
          this.buf = this.buf.slice(i + 1);
          if (!l) continue;
          if (!ready) {
            if (l === this.readyLine) {
              ready = true;
              clearTimeout(startTimer);
              if (this.proc === proc) this.starting = null;
              log('input', `${this.name} ready`);
              resolve();
            }
            continue;
          }
          const p = this.waiting.shift();
          if (p) {
            clearTimeout(p.timer);
            p.resolve(l);
          }
        }
      });
      proc.stderr?.setEncoding('utf8');
      proc.stderr?.on('data', (d: string) => {
        stderr = (stderr + d).slice(-2000);
      });
      proc.stdin?.on('error', () => { /* helper gone; exit handler reports it */ });
      proc.on('error', (e: NodeJS.ErrnoException) => {
        log('input', `${this.name} error`, e.message);
        if (this.proc !== proc) return;
        this.proc = null;
        this.starting = null;
        clearTimeout(startTimer);
        const err = new Error(e.code === 'ENOENT' ? 'input helper missing' : `input helper failed: ${e.message}`);
        if (!ready) reject(err);
        this.failAll(err);
      });
      proc.on('exit', (code, sig) => {
        if (this.proc !== proc) return;
        this.proc = null;
        this.starting = null;
        clearTimeout(startTimer);
        this.crashes.push(Date.now());
        log('input', `${this.name} exited code=${code} signal=${sig}`, stderr.trim().slice(-300));
        const err = new Error('input helper stopped unexpectedly');
        if (!ready) reject(err);
        this.failAll(err);
      });
    });
    const starting = this.starting;
    if (this.readyLine === null && this.proc) this.starting = null; // no handshake: usable at once
    return starting;
  }

  private async send(line: string, timeoutMs: number): Promise<string> {
    await this.ensure();
    const proc = this.proc;
    if (!proc?.stdin) throw new Error('input helper not running');
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiting.findIndex((w) => w.timer === timer);
        if (idx >= 0) this.waiting.splice(idx, 1);
        log('input', `${this.name} timed out; restarting it`);
        this.stop(); // state unknown: start fresh next time
        reject(new Error('input timed out'));
      }, timeoutMs);
      this.waiting.push({ resolve, reject, timer });
      try {
        proc.stdin!.write(line + '\n');
      } catch (e) {
        clearTimeout(timer);
        this.waiting.pop();
        reject(new Error(`input helper not running: ${(e as Error).message}`));
      }
    });
  }
}

let quitHooked = false;
function hookQuit(): void {
  if (quitHooked) return;
  quitHooked = true;
  try {
    app.on('will-quit', stopInput);
  } catch { /* not in electron (tests) */ }
}

/* ───────────────────────── macOS ───────────────────────── */

/** Contents/Resources/clickity-input when packaged, resources/mac/clickity-input in dev. */
export function macHelperPath(): string {
  try {
    if (app.isPackaged) return path.join(process.resourcesPath, 'clickity-input');
    return path.join(app.getAppPath(), 'resources/mac/clickity-input');
  } catch {
    return path.join(process.cwd(), 'resources/mac/clickity-input');
  }
}

let macWorker: LineWorker | null = null;
function mac(): LineWorker {
  if (!macWorker) {
    hookQuit();
    macWorker = new LineWorker('mac helper', () => spawn(macHelperPath(), [], { stdio: ['pipe', 'pipe', 'pipe'] }), null, 5000);
  }
  return macWorker;
}

async function macSend(cmd: Record<string, unknown>, timeoutMs = 10_000): Promise<void> {
  if (!fs.existsSync(macHelperPath())) throw new Error('input helper missing (npm run build:input)');
  const reply = await mac().request(JSON.stringify(cmd), timeoutMs);
  let r: { ok?: boolean; error?: string };
  try {
    r = JSON.parse(reply);
  } catch {
    throw new Error('input helper sent a bad reply');
  }
  if (r.ok) return;
  const err = String(r.error || 'input failed');
  throw new Error(err === 'needs accessibility' ? MAC_ACCESSIBILITY_HINT : err);
}

async function macPerform(a: InputAction): Promise<void> {
  switch (a.type) {
    case 'move': {
      const { p } = targetPoint(a.x, a.y);
      return macSend({ cmd: 'move', x: p.x, y: p.y });
    }
    case 'click': {
      const { p } = targetPoint(a.x, a.y);
      return macSend({ cmd: 'click', x: p.x, y: p.y, button: a.button === 'right' ? 'right' : 'left', count: a.count === 2 ? 2 : 1 });
    }
    case 'scroll': {
      const { p } = targetPoint(a.x, a.y);
      return macSend({ cmd: 'scroll', x: p.x, y: p.y, dy: lines(a.dy), dx: lines(a.dx) });
    }
    case 'type':
      return macSend({ cmd: 'type', text: a.text }, 10_000 + a.text.length * 30);
    case 'key': {
      const { code, mods } = macChord(a.keys);
      return macSend({ cmd: 'key', code, mods });
    }
  }
}

/* ───────────────────────── Windows ───────────────────────── */

let winWorker: LineWorker | null = null;
function win(): LineWorker {
  if (!winWorker) {
    hookQuit();
    const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    winWorker = new LineWorker(
      'powershell',
      () => spawn(fs.existsSync(exe) ? exe : 'powershell.exe', winPowershellArgs(), { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }),
      'ready',
      30_000, // first Add-Type compile can be slow on a cold machine
    );
  }
  return winWorker;
}

async function winSend(line: string, timeoutMs = 10_000): Promise<void> {
  const reply = await win().request(line, timeoutMs);
  if (reply === 'ok') return;
  throw new Error(reply.startsWith('err ') ? reply.slice(4).trim().toLowerCase() || 'input failed' : 'input helper sent a bad reply');
}

/** Physical bounds of the whole virtual desktop (union of every display). */
function winVirtualRect(): Rect {
  const rects = screen.getAllDisplays().map((d) => screen.dipToScreenRect(null, d.bounds));
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  const r = Math.max(...rects.map((q) => q.x + q.width));
  const b = Math.max(...rects.map((q) => q.y + q.height));
  return { x, y, width: r - x, height: b - y };
}

function winAbs(x: number, y: number): Pt {
  const { p } = targetPoint(x, y);
  const phys = screen.dipToScreenPoint(p);
  return toWinAbsolute(phys, winVirtualRect());
}

async function winPerform(a: InputAction): Promise<void> {
  switch (a.type) {
    case 'move': {
      const q = winAbs(a.x, a.y);
      return winSend(`move ${q.x} ${q.y}`);
    }
    case 'click': {
      const q = winAbs(a.x, a.y);
      return winSend(`click ${q.x} ${q.y} ${a.button === 'right' ? 'right' : 'left'} ${a.count === 2 ? 2 : 1}`);
    }
    case 'scroll': {
      const q = winAbs(a.x, a.y);
      return winSend(`scroll ${q.x} ${q.y} ${lines(a.dy)} ${lines(a.dx)}`);
    }
    case 'type':
      return winSend(`type ${Buffer.from(a.text, 'utf8').toString('base64')}`, 10_000 + a.text.length * 10);
    case 'key':
      return winSend(`key ${winChord(a.keys).join(',')}`);
  }
}

/* ───────────────────────── Linux (xdotool) ───────────────────────── */

/** xdotool decodes `type` text with the C locale: make sure it is a UTF-8 one. */
function xdoEnv(): NodeJS.ProcessEnv {
  const loc = process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG || '';
  return /utf-?8/i.test(loc) ? process.env : { ...process.env, LC_ALL: 'C.UTF-8' };
}

function xdotool(args: string[], timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('xdotool', args, { timeout: timeoutMs, env: xdoEnv() }, (err, _out, stderr) => {
      if (!err) return resolve();
      const e = err as NodeJS.ErrnoException & { killed?: boolean };
      if (e.code === 'ENOENT') return reject(new Error(XDOTOOL_HINT));
      if (e.killed) return reject(new Error('xdotool timed out'));
      const msg = String(stderr || e.message).trim().split('\n')[0].toLowerCase().slice(0, 160);
      reject(new Error(`xdotool failed: ${msg}`));
    });
  });
}

function linuxEnvProblem(): string | null {
  const wayland = process.env.XDG_SESSION_TYPE === 'wayland' || !!process.env.WAYLAND_DISPLAY;
  if (!process.env.DISPLAY) return wayland ? WAYLAND_HINT : 'agent mode needs an x11 display';
  return null;
}

function x11Point(x: number, y: number): Pt {
  const { p, display } = targetPoint(x, y);
  return dipToX11(p, display.scaleFactor);
}

async function xMove(q: Pt): Promise<void> {
  // --sync waits for the pointer to arrive (it can wait forever when the pointer is already there
  // on some servers, hence the short timeout and the fallback without --sync)
  try {
    await xdotool(['mousemove', '--sync', String(q.x), String(q.y)], 2000);
  } catch (e) {
    if ((e as Error).message !== 'xdotool timed out') throw e;
    await xdotool(['mousemove', String(q.x), String(q.y)]);
  }
}

async function linuxPerform(a: InputAction): Promise<void> {
  const env = linuxEnvProblem();
  if (env) throw new Error(env);
  switch (a.type) {
    case 'move':
      return xMove(x11Point(a.x, a.y));
    case 'click': {
      await xMove(x11Point(a.x, a.y));
      const btn = a.button === 'right' ? '3' : '1';
      return xdotool(a.count === 2 ? ['click', '--repeat', '2', '--delay', '80', btn] : ['click', btn]);
    }
    case 'scroll': {
      await xMove(x11Point(a.x, a.y));
      const dy = lines(a.dy);
      const dx = lines(a.dx);
      if (dy) await xdotool(['click', '--repeat', String(Math.abs(dy)), '--delay', '15', dy > 0 ? '5' : '4']);
      if (dx) await xdotool(['click', '--repeat', String(Math.abs(dx)), '--delay', '15', dx > 0 ? '7' : '6']);
      return;
    }
    case 'type': {
      // characters outside the keymap are typed through a temporary keysym remap that can drop
      // keys when rushed, so non-ascii text goes slower
      const delay = /[^\x00-\x7f]/.test(a.text) ? 30 : 8;
      return xdotool(['type', '--delay', String(delay), '--', a.text], 10_000 + a.text.length * (delay + 40));
    }
    case 'key':
      return xdotool(['key', '--delay', '12', '--', xdoChord(a.keys)]);
  }
}

/* ───────────────────────── public API ───────────────────────── */

/** Is agent mode usable right now? prompt (mac): ask macOS to show the accessibility dialog. */
export async function inputStatus(opts: { prompt?: boolean } = {}): Promise<InputStatus> {
  const backend = 'native';
  try {
    if (process.platform === 'darwin') {
      if (!fs.existsSync(macHelperPath())) return { ok: false, backend, detail: 'input helper missing (npm run build:input)' };
      try {
        await macSend({ cmd: 'status', prompt: !!opts.prompt }, 5000);
      } catch (e) {
        const m = (e as Error).message;
        return { ok: false, backend, detail: m === MAC_ACCESSIBILITY_HINT ? 'needs accessibility' : m };
      }
      return { ok: true, backend, detail: '' };
    }
    if (process.platform === 'win32') {
      await winSend('ping', 30_000);
      return { ok: true, backend, detail: '' };
    }
    if (process.platform === 'linux') {
      const env = linuxEnvProblem();
      if (env) return { ok: false, backend, detail: env };
      try {
        await xdotool(['version'], 5000);
      } catch (e) {
        const m = (e as Error).message;
        return { ok: false, backend, detail: m === XDOTOOL_HINT ? m : `xdotool not working: ${m}` };
      }
      return { ok: true, backend, detail: '' };
    }
    return { ok: false, backend, detail: `agent mode isn't supported on ${process.platform}` };
  } catch (e) {
    return { ok: false, backend, detail: (e as Error).message || 'input unavailable' };
  }
}

function validate(a: InputAction): void {
  if (!a || typeof a !== 'object') throw new Error('bad action');
  switch (a.type) {
    case 'click':
    case 'move':
    case 'scroll':
      if (!finite(a.x) || !finite(a.y)) throw new Error(`bad coordinates for ${a.type}`);
      return;
    case 'type':
      if (typeof a.text !== 'string') throw new Error('nothing to type');
      if (a.text.length > MAX_TEXT) throw new Error(`text too long (max ${MAX_TEXT} chars)`);
      return;
    case 'key':
      if (!Array.isArray(a.keys) || !a.keys.length) throw new Error('empty key chord');
      return;
    case 'wait':
      if (!finite(a.ms) || a.ms < 0) throw new Error('bad wait');
      return;
    default:
      throw new Error(`unknown action: ${String((a as { type?: unknown }).type).slice(0, 20)}`);
  }
}

/**
 * Run actions in order, ~60ms apart. Checks the signal between actions (and during waits) and
 * throws Error('stopped') (name 'AbortError') when aborted. Other failures throw an Error with a
 * short lowercase message, e.g. "needs accessibility: …", "install xdotool (…)".
 */
export async function perform(actions: InputAction[], signal?: AbortSignal): Promise<void> {
  if (!Array.isArray(actions)) throw new Error('bad actions');
  const exec =
    process.platform === 'darwin' ? macPerform
    : process.platform === 'win32' ? winPerform
    : process.platform === 'linux' ? linuxPerform
    : null;
  if (!exec) throw new Error(`agent mode isn't supported on ${process.platform}`);
  for (let i = 0; i < actions.length; i++) {
    if (signal?.aborted) throw abortError();
    if (i > 0) await sleep(GAP_MS, signal);
    const a = actions[i];
    validate(a);
    log('input', `${i + 1}/${actions.length} ${describe(a)}`);
    if (a.type === 'wait') {
      await sleep(Math.min(a.ms, MAX_WAIT_MS), signal);
      continue;
    }
    if (a.type === 'type' && !a.text) continue;
    const t0 = Date.now();
    try {
      await exec(a);
    } catch (e) {
      const msg = (e as Error).message || 'input failed';
      log('input', `failed: ${describe(a)}: ${msg}`);
      throw new Error(msg);
    }
    const ms = Date.now() - t0;
    if (ms > 500) log('input', `took ${ms}ms`);
  }
}

/** Stop the long-lived helpers (also hooked to app will-quit). */
export function stopInput(): void {
  macWorker?.stop();
  winWorker?.stop();
}
