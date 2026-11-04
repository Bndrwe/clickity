// Global push-to-talk / type / escape hotkeys.
// Primary backend: uiohook-napi (real key up/down). Fallback: Electron globalShortcut (toggle only).
// macOS fn: uiohook never sees it, so fn-key.ts runs a tiny event-tap helper and its
// down/up events are fed into the same chord engine as the 'Fn' key.
import type { HotkeySettings, KeyName } from '../shared/types';
import { fnStatus, onFn, restartFnWatch, startFnWatch, stopFnWatch } from './fn-key';
import { ChordEngine, type HotkeyHandlers } from './chord-engine';

export { ChordEngine, type HotkeyHandlers };

/** Modifier order for labels. 'Fn' is the mac fn / globe key (only reported on macOS). */
const MODIFIERS = ['Control', 'Alt', 'Shift', 'Meta', 'Fn'];

/** Modifiers first (control, alt, shift, meta, fn), then the rest in the order given. */
export function orderKeys(keys: Iterable<KeyName>): KeyName[] {
  const set = [...new Set(keys)];
  return [...MODIFIERS.filter((m) => set.includes(m)), ...set.filter((k) => !MODIFIERS.includes(k))];
}

export const chordUsesFn = (h: Pick<HotkeySettings, 'talk' | 'type'>): boolean => h.talk.includes('Fn') || h.type.includes('Fn');

/* ───────────────────────── keycode mapping ───────────────────────── */

type UiohookKeyTable = Record<string, number>;

/** Build uiohook keycode → canonical KeyName from the UiohookKey table. */
export function buildKeycodeMap(K: UiohookKeyTable): Map<number, KeyName> {
  const m = new Map<number, KeyName>();
  const set = (code: number | undefined, name: KeyName) => {
    if (typeof code === 'number' && !m.has(code)) m.set(code, name);
  };
  for (const [k, code] of Object.entries(K)) {
    if (/^[A-Z]$/.test(k)) set(code, 'Key' + k);
    else if (/^[0-9]$/.test(k)) set(code, 'Digit' + k);
    else if (/^F\d{1,2}$/.test(k)) set(code, k);
  }
  const direct = [
    'Backspace', 'Tab', 'Enter', 'CapsLock', 'Escape', 'Space', 'PageUp', 'PageDown', 'End', 'Home',
    'ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown', 'Insert', 'Delete', 'Semicolon', 'Equal', 'Comma',
    'Minus', 'Period', 'Slash', 'Backquote', 'BracketLeft', 'Backslash', 'BracketRight', 'Quote',
    'NumLock', 'ScrollLock', 'PrintScreen',
    'Numpad0', 'Numpad1', 'Numpad2', 'Numpad3', 'Numpad4', 'Numpad5', 'Numpad6', 'Numpad7', 'Numpad8', 'Numpad9',
    'NumpadMultiply', 'NumpadAdd', 'NumpadSubtract', 'NumpadDecimal', 'NumpadDivide', 'NumpadEnter',
  ];
  for (const n of direct) set(K[n], n);
  // numpad navigation cluster (numlock off) → DOM reports Numpad digits
  const nav: Record<string, string> = {
    NumpadEnd: 'Numpad1', NumpadArrowDown: 'Numpad2', NumpadPageDown: 'Numpad3', NumpadArrowLeft: 'Numpad4',
    NumpadArrowRight: 'Numpad6', NumpadHome: 'Numpad7', NumpadArrowUp: 'Numpad8', NumpadPageUp: 'Numpad9',
    NumpadInsert: 'Numpad0', NumpadDelete: 'NumpadDecimal',
  };
  for (const [k, v] of Object.entries(nav)) set(K[k], v);
  for (const k of ['Ctrl', 'CtrlRight']) set(K[k], 'Control');
  for (const k of ['Alt', 'AltRight']) set(K[k], 'Alt');
  for (const k of ['Shift', 'ShiftRight']) set(K[k], 'Shift');
  for (const k of ['Meta', 'MetaRight']) set(K[k], 'Meta');
  return m;
}

/* ───────────────────────── accelerator conversion (fallback) ───────────────────────── */

const ACCEL_KEYS: Record<string, string> = {
  Space: 'Space', Enter: 'Return', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', ArrowUp: 'Up', ArrowDown: 'Down',
  ArrowLeft: 'Left', ArrowRight: 'Right', Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[',
  BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
  CapsLock: 'Capslock', NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummult',
  NumpadDivide: 'numdiv', NumpadDecimal: 'numdec',
};

/** Convert a chord to an Electron accelerator, or null if not expressible (e.g. modifier-only). */
export function chordToAccelerator(keys: KeyName[]): string | null {
  const mods: string[] = [];
  let main: string | null = null;
  for (const k of keys) {
    if (k === 'Control') mods.push('Control');
    else if (k === 'Alt') mods.push('Alt');
    else if (k === 'Shift') mods.push('Shift');
    else if (k === 'Meta') mods.push('Super');
    else {
      if (main) return null; // only one non-modifier key
      let a: string | undefined;
      if (/^Key[A-Z]$/.test(k)) a = k.slice(3);
      else if (/^Digit\d$/.test(k)) a = k.slice(5);
      else if (/^F\d{1,2}$/.test(k)) a = k;
      else if (/^Numpad\d$/.test(k)) a = 'num' + k.slice(6);
      else a = ACCEL_KEYS[k];
      if (!a) return null;
      main = a;
    }
  }
  if (!main) return null;
  return [...mods, main].join('+');
}

/* ───────────────────────── labels ───────────────────────── */

const LABEL_KEYS: Record<string, string> = {
  Space: 'space', Enter: 'enter', Escape: 'esc', Tab: 'tab', Backspace: 'backspace', Delete: 'delete',
  Insert: 'insert', Home: 'home', End: 'end', PageUp: 'pageup', PageDown: 'pagedown', CapsLock: 'caps',
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Backquote: '`', Minus: '-', Equal: '=',
  BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.',
  Slash: '/', NumpadAdd: 'num+', NumpadSubtract: 'num-', NumpadMultiply: 'num*', NumpadDivide: 'num/',
  NumpadDecimal: 'num.', NumpadEnter: 'num enter',
};

export function hotkeyLabel(keys: KeyName[], platform: NodeJS.Platform = process.platform): string {
  const mac = platform === 'darwin';
  const modName: Record<string, string> = {
    Control: mac ? 'control' : 'ctrl',
    Alt: mac ? 'option' : 'alt',
    Shift: 'shift',
    Meta: mac ? 'cmd' : 'win',
    Fn: 'fn',
  };
  return orderKeys(keys)
    .map((k) => {
      if (modName[k]) return modName[k];
      if (/^Key[A-Z]$/.test(k)) return k.slice(3).toLowerCase();
      if (/^Digit\d$/.test(k)) return k.slice(5);
      if (/^F\d{1,2}$/.test(k)) return k.toLowerCase();
      if (/^Numpad\d$/.test(k)) return 'num' + k.slice(6);
      return LABEL_KEYS[k] ?? k.toLowerCase();
    })
    .join(' + ');
}

/* ───────────────────────── backends ───────────────────────── */

const DEFAULT_ACCELERATOR = 'CommandOrControl+Shift+Space';

let engine: ChordEngine | null = null;
let currentHandlers: HotkeyHandlers | null = null;
let currentSettings: HotkeySettings | null = null;
let backend: 'uiohook' | 'globalShortcut' | null = null;
let uio: { uIOhook: any } | null = null;
let registered: string[] = [];
let powerListeners: Array<[string, () => void]> = [];
let offFn: (() => void) | null = null;
let extSuspended = false;
let recSuspended = false;
type RawKeyListener = (key: KeyName, down: boolean) => void;
const rawListeners = new Set<RawKeyListener>();

function emitRaw(key: KeyName, down: boolean): void {
  for (const cb of [...rawListeners]) {
    try { cb(key, down); } catch (e) { console.warn('[hotkey] raw listener threw:', e); }
  }
}

/** Every key the native hook sees (uiohook + mac fn helper), even while suspended. For the settings recorder. */
export function onRawKey(cb: RawKeyListener): () => void {
  rawListeners.add(cb);
  return () => rawListeners.delete(cb);
}

/** Which backend is live: 'uiohook' hears real key up/down (and fn on mac). */
export function hotkeyBackend(): 'uiohook' | 'globalShortcut' | null {
  return backend;
}

function lazyRequire<T = any>(name: string): T {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(name) as T;
}

function startUiohook(cfg: HotkeySettings, handlers: HotkeyHandlers): boolean {
  try {
    if (process.platform === 'darwin') {
      const { systemPreferences } = lazyRequire('electron');
      if (!systemPreferences.isTrustedAccessibilityClient(false)) {
        console.warn('[hotkey] accessibility permission missing; using globalShortcut fallback');
        return false;
      }
    }
    const mod = lazyRequire('uiohook-napi');
    const codeMap = buildKeycodeMap(mod.UiohookKey as UiohookKeyTable);
    const eng = new ChordEngine(handlers, cfg);
    const hook = mod.uIOhook;
    hook.on('keydown', (e: any) => {
      const name = codeMap.get(e.keycode);
      if (!name) {
        // keycode 0 = VC_UNDEFINED (e.g. mac fn): never a real "other key"
        if (e.keycode) eng.foreignKeyDown();
        return;
      }
      emitRaw(name, true);
      eng.reconcileModifiers({ ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey }, name);
      eng.keyDown(name);
    });
    hook.on('keyup', (e: any) => {
      const name = codeMap.get(e.keycode);
      if (!name) return;
      emitRaw(name, false);
      eng.keyUp(name);
    });
    hook.start();
    uio = mod;
    engine = eng;
    eng.setSuspended(extSuspended || recSuspended);
    // mac fn key → same engine (the helper is started by startHotkeys)
    offFn?.();
    offFn = onFn((down) => {
      emitRaw('Fn', down);
      if (down) eng.keyDown('Fn');
      else eng.keyUp('Fn');
    });
    // stuck-key guard across sleep / lock
    try {
      const { powerMonitor } = lazyRequire('electron');
      for (const ev of ['suspend', 'resume', 'lock-screen', 'unlock-screen']) {
        const fn = () => engine?.reset();
        powerMonitor.on(ev, fn);
        powerListeners.push([ev, fn]);
      }
    } catch { /* not in electron */ }
    return true;
  } catch (e) {
    console.warn('[hotkey] uiohook unavailable:', e instanceof Error ? e.message : e);
    try { uio?.uIOhook.stop(); } catch { /* ignore */ }
    uio = null;
    engine = null;
    return false;
  }
}

function startGlobalShortcut(cfg: HotkeySettings, handlers: HotkeyHandlers): void {
  const { globalShortcut } = lazyRequire('electron');
  for (const a of registered) globalShortcut.unregister(a);
  registered = [];
  const talkAccel = chordToAccelerator(cfg.talk);
  const typeAccel = chordToAccelerator(cfg.type);
  let talk = talkAccel;
  if (!talk) {
    talk = typeAccel ?? DEFAULT_ACCELERATOR;
    console.warn(`[hotkey] talk chord "${cfg.talk.join('+')}" can't be a global shortcut; using ${talk} (toggle)`);
  }
  let talking = false;
  const reg = (accel: string, fn: () => void) => {
    try {
      if (globalShortcut.register(accel, fn)) registered.push(accel);
      else console.warn(`[hotkey] could not register ${accel}`);
    } catch (e) {
      console.warn(`[hotkey] invalid accelerator ${accel}:`, e);
    }
  };
  reg(talk, () => {
    try {
      // no key-up here: every press toggles. Ask the conversation when we can, so a turn that was
      // cancelled elsewhere (escape, error) doesn't leave us one press out of step.
      talking = handlers.isTalking ? !handlers.isTalking() : !talking;
      if (talking) handlers.onTalkDown();
      else handlers.onTalkUp();
    } catch (e) { console.warn('[hotkey] handler threw:', e); }
  });
  if (typeAccel && typeAccel !== talk) reg(typeAccel, () => { try { handlers.onType(); } catch (e) { console.warn(e); } });
}

export function startHotkeys(h: HotkeySettings, handlers: HotkeyHandlers): { backend: 'uiohook' | 'globalShortcut' } {
  stopHotkeys();
  currentHandlers = handlers;
  currentSettings = h;
  if (startUiohook(h, handlers)) {
    backend = 'uiohook';
    if (process.platform === 'darwin') {
      try { startFnWatch({ prompt: chordUsesFn(h) }); } catch (e) { console.warn('[hotkey] fn helper failed:', e); }
    }
  } else {
    backend = 'globalShortcut';
    try { startGlobalShortcut(h, handlers); } catch (e) { console.warn('[hotkey] globalShortcut failed:', e); }
  }
  return { backend };
}

export function updateHotkeys(h: HotkeySettings): void {
  const prev = currentSettings;
  currentSettings = h;
  if (backend === 'uiohook') {
    engine?.configure(h);
    // newly using fn and the helper isn't up (e.g. never asked for permission): try again, with the prompt
    const st = fnStatus();
    if (process.platform === 'darwin' && chordUsesFn(h) && !(prev && chordUsesFn(prev)) && st !== 'running' && st !== 'starting' && st !== 'missing') {
      try { restartFnWatch({ prompt: true }); } catch (e) { console.warn('[hotkey] fn helper failed:', e); }
    }
  }
  else if (backend === 'globalShortcut' && currentHandlers) {
    try { startGlobalShortcut(h, currentHandlers); } catch (e) { console.warn('[hotkey] globalShortcut failed:', e); }
  }
}

/** Pause all chord handling (used while the settings keybind recorder is open). */
export function suspendHotkeys(suspended: boolean): void {
  extSuspended = suspended;
  if (backend === 'uiohook') engine?.setSuspended(extSuspended || recSuspended);
  else if (backend === 'globalShortcut') {
    try {
      if (suspended) {
        const { globalShortcut } = lazyRequire('electron');
        for (const a of registered) globalShortcut.unregister(a);
        registered = [];
      } else if (currentSettings && currentHandlers) startGlobalShortcut(currentSettings, currentHandlers);
    } catch (e) { console.warn('[hotkey] suspend failed:', e); }
  }
}

/** Pause chord actions while main records a new keybind (raw keys still flow to onRawKey). */
export function setRecordingSuspended(recording: boolean): void {
  recSuspended = recording;
  if (backend === 'uiohook') engine?.setSuspended(extSuspended || recSuspended);
}

export function stopHotkeys(): void {
  try { engine?.dispose(); } catch { /* ignore */ }
  try { offFn?.(); } catch { /* ignore */ }
  offFn = null;
  try { stopFnWatch(); } catch { /* ignore */ }
  try { uio?.uIOhook.removeAllListeners?.(); uio?.uIOhook.stop(); } catch { /* ignore */ }
  try {
    if (powerListeners.length) {
      const { powerMonitor } = lazyRequire('electron');
      for (const [ev, fn] of powerListeners) powerMonitor.removeListener(ev, fn);
    }
  } catch { /* ignore */ }
  powerListeners = [];
  try {
    if (registered.length) {
      const { globalShortcut } = lazyRequire('electron');
      for (const a of registered) globalShortcut.unregister(a);
    }
  } catch { /* ignore */ }
  registered = [];
  engine = null;
  uio = null;
  backend = null;
}
