// Global push-to-talk / type / escape hotkeys.
// Primary backend: uiohook-napi (real key up/down). Fallback: Electron globalShortcut (toggle only).
import type { HotkeySettings, KeyName } from '../shared/types';

export interface HotkeyHandlers {
  onTalkDown(): void;
  onTalkUp(): void;
  onType(): void;
  onEscape(): void;
}

const MODIFIERS = ['Control', 'Alt', 'Shift', 'Meta'];
const SUBSET_DELAY_MS = 120;
const MAX_HOLD_MS = 5 * 60 * 1000;

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

/* ───────────────────────── chord state machine (pure) ───────────────────────── */

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}
function isSuperset(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  for (const x of b) if (!a.has(x)) return false;
  return true;
}
function isStrictSubset(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size < b.size && isSuperset(b, a);
}

export class ChordEngine {
  private talk = new Set<string>();
  private type = new Set<string>();
  private mode: 'hold' | 'toggle' = 'hold';
  private held = new Set<string>();
  private talkActive = false;
  private pending: ReturnType<typeof setTimeout> | null = null;
  private holdWatchdog: ReturnType<typeof setTimeout> | null = null;
  private suspended = false;

  constructor(private handlers: HotkeyHandlers, cfg: HotkeySettings, private delayMs = SUBSET_DELAY_MS) {
    this.configure(cfg);
  }

  configure(cfg: HotkeySettings): void {
    this.talk = new Set(cfg.talk);
    this.type = new Set(cfg.type);
    this.mode = cfg.mode;
    this.reset();
  }

  setSuspended(s: boolean): void {
    this.suspended = s;
    this.reset();
  }

  /** Clear all held state; releases an active talk. */
  reset(): void {
    this.clearPending();
    this.held.clear();
    if (this.talkActive) this.endTalk();
  }

  /** Drop modifiers the OS says are no longer down (stuck-key guard). */
  reconcileModifiers(flags: { ctrl: boolean; alt: boolean; shift: boolean; meta: boolean }, except?: KeyName): void {
    const pairs: Array<[string, boolean]> = [['Control', flags.ctrl], ['Alt', flags.alt], ['Shift', flags.shift], ['Meta', flags.meta]];
    let changed = false;
    for (const [name, down] of pairs) {
      if (!down && name !== except && this.held.delete(name)) changed = true;
    }
    if (changed) this.afterRelease();
  }

  keyDown(key: KeyName): void {
    if (this.suspended) return;
    if (this.held.has(key)) return; // autorepeat
    this.held.add(key);
    if (key === 'Escape' && this.held.size === 1) {
      this.safe(() => this.handlers.onEscape());
      return;
    }
    if (this.type.size && sameSet(this.held, this.type) && !sameSet(this.type, this.talk)) {
      this.clearPending();
      if (this.talkActive) this.endTalk();
      this.safe(() => this.handlers.onType());
      return;
    }
    if (this.talk.size && sameSet(this.held, this.talk)) {
      this.onTalkChord();
    }
  }

  keyUp(key: KeyName): void {
    if (this.suspended) return;
    if (!this.held.delete(key)) return;
    this.afterRelease();
  }

  dispose(): void {
    this.clearPending();
    if (this.holdWatchdog) clearTimeout(this.holdWatchdog);
    this.holdWatchdog = null;
  }

  private afterRelease(): void {
    // hold mode: talk ends when any chord key is released
    if (this.pending && !sameSet(this.held, this.talk)) this.clearPending();
    if (this.mode === 'hold' && this.talkActive && !isSuperset(this.held, this.talk)) this.endTalk();
  }

  private onTalkChord(): void {
    if (this.mode === 'hold' && this.talkActive) return;
    const delayed = this.type.size > 0 && isStrictSubset(this.talk, this.type);
    const fire = () => {
      this.pending = null;
      if (this.suspended || !sameSet(this.held, this.talk)) return;
      if (this.mode === 'toggle') {
        if (this.talkActive) this.endTalk();
        else this.startTalk();
      } else this.startTalk();
    };
    this.clearPending();
    if (delayed) this.pending = setTimeout(fire, this.delayMs);
    else fire();
  }

  private startTalk(): void {
    this.talkActive = true;
    if (this.holdWatchdog) clearTimeout(this.holdWatchdog);
    this.holdWatchdog = setTimeout(() => {
      this.holdWatchdog = null;
      this.held.clear();
      if (this.talkActive) this.endTalk();
    }, MAX_HOLD_MS);
    this.holdWatchdog.unref?.();
    this.safe(() => this.handlers.onTalkDown());
  }

  private endTalk(): void {
    this.talkActive = false;
    if (this.holdWatchdog) clearTimeout(this.holdWatchdog);
    this.holdWatchdog = null;
    this.safe(() => this.handlers.onTalkUp());
  }

  private clearPending(): void {
    if (this.pending) clearTimeout(this.pending);
    this.pending = null;
  }

  private safe(fn: () => void): void {
    try {
      fn();
    } catch (e) {
      console.warn('[hotkey] handler threw:', e);
    }
  }
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
  };
  const sorted = [...MODIFIERS.filter((m) => keys.includes(m)), ...keys.filter((k) => !MODIFIERS.includes(k))];
  return sorted
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
      if (!name) return;
      eng.reconcileModifiers({ ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey }, name);
      eng.keyDown(name);
    });
    hook.on('keyup', (e: any) => {
      const name = codeMap.get(e.keycode);
      if (name) eng.keyUp(name);
    });
    hook.start();
    uio = mod;
    engine = eng;
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
      talking = !talking;
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
  } else {
    backend = 'globalShortcut';
    try { startGlobalShortcut(h, handlers); } catch (e) { console.warn('[hotkey] globalShortcut failed:', e); }
  }
  return { backend };
}

export function updateHotkeys(h: HotkeySettings): void {
  currentSettings = h;
  if (backend === 'uiohook') engine?.configure(h);
  else if (backend === 'globalShortcut' && currentHandlers) {
    try { startGlobalShortcut(h, currentHandlers); } catch (e) { console.warn('[hotkey] globalShortcut failed:', e); }
  }
}

/** Pause all chord handling (used while the settings keybind recorder is open). */
export function suspendHotkeys(suspended: boolean): void {
  if (backend === 'uiohook') engine?.setSuspended(suspended);
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

export function stopHotkeys(): void {
  try { engine?.dispose(); } catch { /* ignore */ }
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
