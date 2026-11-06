// In-app updater. Checks GitHub's latest release on startup (after ~10s), every 4 hours and on demand;
// "update" downloads this platform's asset and swaps it in:
//   mac:     unzip (ditto) → detached script replaces the .app after we quit → reopens it
//   windows: the NSIS installer, silently (/S --force-run relaunches it)
//   linux:   AppImage → replaced in place and relaunched; .deb → opened in the system installer
// Not electron-updater: Squirrel.Mac needs a Developer ID signature, our builds are ad-hoc signed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { app, net, shell } from 'electron';
import type { UpdateState } from '../shared/ipc';
import {
  DEFAULT_API,
  cleanAppImageEnv,
  downloadWithRetry,
  fetchLatest,
  isNewer,
  macSwapScript,
  networkError,
  pickAsset,
  realMacBundle,
  relaunchAfterExit,
  swapAppImage,
  type ReleaseInfo,
} from './update-core';
import { log, logPath } from './log';

const FIRST_CHECK_MS = 10_000;
const EVERY_MS = 4 * 60 * 60 * 1000;

let state: UpdateState = { status: 'idle', current: '0.0.0' };
let release: ReleaseInfo | null = null;
let timer: NodeJS.Timeout | null = null;
let firstTimer: NodeJS.Timeout | null = null;
let checking: Promise<UpdateState> | null = null;
let busy = false; // downloading / installing
const listeners = new Set<(s: UpdateState) => void>();

/** CLICKITY_UPDATE_API overrides the github api base (tests only). */
function apiBase(): string {
  return process.env.CLICKITY_UPDATE_API || DEFAULT_API;
}

/** net.fetch follows the system proxy settings; Node's fetch doesn't. */
const fetchImpl = ((url: string, init?: RequestInit) => net.fetch(url, init)) as typeof fetch;

function enabled(): boolean {
  return app.isPackaged || !!process.env.CLICKITY_UPDATE_API;
}

function set(patch: Partial<UpdateState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) {
    try {
      l(state);
    } catch {
      /* a listener's problem */
    }
  }
}

function shortMsg(err: unknown): string {
  const e = networkError(err);
  return e.message.split('\n')[0]!.toLowerCase();
}

export function getUpdateState(): UpdateState {
  return state;
}

export function onUpdateState(cb: (s: UpdateState) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/* ───────────── "updated to …" note ───────────── */

function markerFile(): string {
  return path.join(app.getPath('userData'), 'last-version.json');
}

interface Marker {
  version?: string;
  /** version we updated from, while the note is still unread */
  from?: string;
}

function readMarker(): Marker {
  try {
    const j = JSON.parse(fs.readFileSync(markerFile(), 'utf8'));
    return { version: typeof j.version === 'string' ? j.version : undefined, from: typeof j.from === 'string' ? j.from : undefined };
  } catch {
    return {};
  }
}

function writeMarker(m: Marker): void {
  try {
    fs.mkdirSync(path.dirname(markerFile()), { recursive: true });
    fs.writeFileSync(markerFile(), JSON.stringify(m));
  } catch {
    /* not important */
  }
}

/** Remember which version ran last; after an update keep a one-time note until it's dismissed. */
function noteVersionChange(): void {
  const current = app.getVersion();
  const m = readMarker();
  let from: string | undefined;
  if (m.version && m.version !== current && isNewer(current, m.version)) {
    from = m.version;
    log('update', `updated ${from} → ${current}`);
  } else if (m.version === current && m.from) {
    from = m.from;
  }
  if (from) state = { ...state, updatedFrom: from };
  if (m.version !== current || m.from !== from) writeMarker({ version: current, from });
}

export function dismissUpdateNote(): void {
  if (!state.updatedFrom) return;
  writeMarker({ version: app.getVersion() });
  set({ updatedFrom: undefined });
}

/* ───────────── checking ───────────── */

/** Start the background schedule (first check after ~10s, then every 4 hours). */
export function initUpdater(): void {
  state = { status: 'idle', current: app.getVersion() };
  noteVersionChange();
  if (!enabled()) {
    state = { ...state, status: 'unsupported', error: 'updates are off in dev builds' };
    log('update', 'off (dev build)');
    return;
  }
  log('update', `on, v${state.current} ${process.platform}/${process.arch}${process.env.APPIMAGE ? ' appimage' : ''}`);
  firstTimer = setTimeout(() => void checkForUpdate(false), FIRST_CHECK_MS);
  timer = setInterval(() => void checkForUpdate(false), EVERY_MS);
  firstTimer.unref?.();
  timer.unref?.();
}

export function stopUpdater(): void {
  if (firstTimer) clearTimeout(firstTimer);
  if (timer) clearInterval(timer);
  firstTimer = timer = null;
}

/**
 * Ask github for the latest release. `manual` = the user asked: show "checking…" and errors;
 * background checks stay quiet (an available update stays available if github is unreachable).
 */
export function checkForUpdate(manual = true): Promise<UpdateState> {
  if (!enabled()) return Promise.resolve(state);
  if (busy) return Promise.resolve(state);
  if (checking) return checking;
  checking = (async () => {
    const prev = state;
    if (manual) set({ status: 'checking', error: undefined, message: undefined });
    try {
      const info = await fetchLatest(apiBase(), fetchImpl);
      const current = app.getVersion();
      log('update', `latest v${info.version}, running v${current}${manual ? ' (manual)' : ''}`);
      if (!isNewer(info.version, current)) {
        release = null;
        set({ status: 'up-to-date', latest: info.version, notes: info.notes, error: undefined, message: undefined, progress: undefined, checkedAt: Date.now() });
        return state;
      }
      const asset = pickAsset(info.assets, process.platform, process.arch, process.env.APPIMAGE);
      release = info;
      if (!asset) {
        log('update', `no asset for ${process.platform}/${process.arch} in v${info.version}`);
        set({ status: 'unsupported', latest: info.version, notes: info.notes, error: `no download for ${process.platform} ${process.arch} in this release`, checkedAt: Date.now() });
        return state;
      }
      set({ status: 'available', latest: info.version, notes: info.notes, error: undefined, message: undefined, progress: undefined, checkedAt: Date.now() });
    } catch (err) {
      const msg = shortMsg(err);
      log('update', `check failed${manual ? ' (manual)' : ''}:`, msg);
      if (manual) set({ status: 'error', error: msg, checkedAt: Date.now() });
      else if (prev.status !== 'available') set({ status: prev.status === 'checking' ? 'idle' : prev.status });
    }
    return state;
  })().finally(() => {
    checking = null;
  });
  return checking;
}

/* ───────────── installing ───────────── */

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) =>
    execFile(cmd, args, { timeout: 5 * 60_000 }, (err, _out, stderr) => (err ? reject(new Error(`${path.basename(cmd)} failed: ${String(stderr || err.message).trim().split('\n')[0]}`)) : resolve())),
  );
}

function writable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function quitSoon(): void {
  set({ status: 'installing', progress: undefined });
  log('update', 'quitting to finish the update');
  setTimeout(() => app.quit(), 300);
  // if something keeps the app alive (a window refusing to close), make sure we really exit so the
  // installer / swap script can replace us
  setTimeout(() => app.exit(0), 6000).unref?.();
}

async function installMac(file: string, tmp: string, version: string): Promise<void> {
  const out = path.join(tmp, 'unpacked');
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  log('update', 'unzipping', file);
  await run('/usr/bin/ditto', ['-x', '-k', file, out]);
  const newApp = fs.readdirSync(out).find((n) => n.endsWith('.app'));
  if (!newApp) throw new Error('the download has no app inside');
  const newPath = path.join(out, newApp);
  const running = path.resolve(app.getPath('exe'), '../../..');
  const bundle = realMacBundle(running, os.homedir());
  log('update', `running from ${running}, installed at ${bundle ?? 'unknown'}`);
  if (!bundle || !bundle.endsWith('.app')) {
    shell.showItemInFolder(newPath);
    set({ status: 'ready', progress: undefined, message: `drag the new clickity (v${version}) into applications, then open it from there` });
    return;
  }
  // a folder we can't write to (installed by another user): the swap asks for the password instead of failing
  const asAdmin = !writable(path.dirname(bundle)) || !writable(bundle);
  const script = path.join(tmp, 'swap.sh');
  fs.writeFileSync(script, macSwapScript(process.pid, newPath, bundle, logPath(), asAdmin), { mode: 0o755 });
  spawn('/bin/sh', [script], { detached: true, stdio: 'ignore' }).unref();
  log('update', 'swap script started', script);
  quitSoon();
}

function installWindows(file: string): void {
  log('update', 'running installer silently', file);
  // start the installer only after clickity has exited, or NSIS finds its files in use and fails
  const ps = `Wait-Process -Id ${process.pid} -Timeout 60 -ErrorAction SilentlyContinue; Start-Process -FilePath '${file.replace(/'/g, "''")}' -ArgumentList '/S','--force-run'`;
  spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', ps], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  quitSoon();
}

async function installLinux(file: string, version: string): Promise<void> {
  const appImage = process.env.APPIMAGE;
  if (appImage && file.endsWith('.AppImage')) {
    try {
      swapAppImage(file, appImage);
    } catch (err) {
      log('update', 'appimage swap failed:', err);
      shell.showItemInFolder(file);
      throw new Error(`${shortMsg(err)}. the new appimage is in the folder that opened`);
    }
    log('update', `replaced ${appImage}`);
    relaunchAfterExit(process.pid, appImage, [], cleanAppImageEnv());
    quitSoon();
    return;
  }
  // .deb: hand it to the system's package installer
  log('update', 'opening', file);
  const err = await shell.openPath(file);
  if (err) {
    shell.showItemInFolder(file);
    log('update', 'xdg-open failed:', err);
  }
  set({ status: 'ready', progress: undefined, message: `install v${version} in the window that opened, then restart clickity` });
}

/** Download this platform's asset and install it (restarting clickity where possible). */
export async function installUpdate(): Promise<UpdateState> {
  if (!enabled()) return state;
  if (busy) return state;
  if (!release || !state.latest) {
    await checkForUpdate(true);
    if (state.status !== 'available') return state;
  }
  const info = release!;
  const asset = pickAsset(info.assets, process.platform, process.arch, process.env.APPIMAGE);
  if (!asset) {
    set({ status: 'unsupported', error: `no download for ${process.platform} ${process.arch}` });
    return state;
  }
  busy = true;
  try {
    const tmp = path.join(os.tmpdir(), `clickity-update-${info.version}`);
    const file = path.join(tmp, asset.name);
    log('update', `downloading ${asset.name} (${asset.size} bytes) → ${file}`);
    set({ status: 'downloading', progress: 0, error: undefined, message: undefined });
    const reuse = fs.existsSync(file) && asset.size > 0 && fs.statSync(file).size === asset.size;
    if (!reuse) await downloadWithRetry(asset, file, (f) => set({ progress: f }), fetchImpl);
    log('update', `downloaded${reuse ? ' (cached)' : ''}`);
    set({ status: 'ready', progress: 1 });
    if (process.platform === 'darwin') await installMac(file, tmp, info.version);
    else if (process.platform === 'win32') installWindows(file);
    else await installLinux(file, info.version);
  } catch (err) {
    const msg = shortMsg(err);
    log('update', 'install failed:', err);
    set({ status: 'error', error: msg, progress: undefined });
  } finally {
    busy = false;
  }
  return state;
}
