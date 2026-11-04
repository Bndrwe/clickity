// Pure helpers for agent-mode input (no electron imports, so node:test can load this file):
// canonical KeyName → macOS kVK_* / Windows VK_* / xdotool keysym, and coordinate math.
import type { KeyName } from '../shared/types';

export const MODIFIER_KEYS = ['Control', 'Alt', 'Shift', 'Meta', 'Fn'] as const;
export type ModifierKey = (typeof MODIFIER_KEYS)[number];

const isModifier = (k: string): k is ModifierKey => (MODIFIER_KEYS as readonly string[]).includes(k);

/* ───────────────────────── key name normalisation ───────────────────────── */

const ALIASES: Record<string, KeyName> = {
  ctrl: 'Control', control: 'Control', ctl: 'Control',
  alt: 'Alt', option: 'Alt', opt: 'Alt',
  shift: 'Shift',
  meta: 'Meta', cmd: 'Meta', command: 'Meta', super: 'Meta', win: 'Meta', windows: 'Meta',
  fn: 'Fn',
  enter: 'Enter', return: 'Enter', esc: 'Escape', escape: 'Escape', tab: 'Tab', space: 'Space',
  backspace: 'Backspace', delete: 'Delete', del: 'Delete', insert: 'Insert', ins: 'Insert',
  home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown', pgup: 'PageUp', pgdn: 'PageDown',
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
  arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight',
  capslock: 'CapsLock', '-': 'Minus', '=': 'Equal', ',': 'Comma', '.': 'Period', '/': 'Slash',
  ';': 'Semicolon', "'": 'Quote', '`': 'Backquote', '[': 'BracketLeft', ']': 'BracketRight', '\\': 'Backslash',
};

/** Canonical KeyName for a canonical or loosely written key ("ctrl", "cmd", "a", "return"…), or null. */
export function normalizeKeyName(k: string): KeyName | null {
  if (typeof k !== 'string') return null;
  const t = k.trim();
  if (!t) return null;
  if (isModifier(t) || CANONICAL.has(t)) return t;
  if (/^[a-z]$/i.test(t)) return 'Key' + t.toUpperCase();
  if (/^[0-9]$/.test(t)) return 'Digit' + t;
  if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(t)) return 'F' + t.slice(1);
  const lower = t.toLowerCase();
  if (ALIASES[lower]) return ALIASES[lower];
  if (/^key[a-z]$/i.test(t)) return 'Key' + t.slice(3).toUpperCase();
  if (/^digit[0-9]$/i.test(t)) return 'Digit' + t.slice(5);
  const ci = [...CANONICAL].find((c) => c.toLowerCase() === lower);
  return ci ?? null;
}

/** Split a chord into modifiers (canonical order) and at most one main key. Throws on bad chords. */
export function splitChord(keys: KeyName[]): { mods: ModifierKey[]; main: KeyName | null } {
  if (!Array.isArray(keys) || keys.length === 0) throw new Error('empty key chord');
  const mods = new Set<ModifierKey>();
  let main: KeyName | null = null;
  for (const raw of keys) {
    const k = normalizeKeyName(raw);
    if (!k) throw new Error(`unknown key: ${String(raw).slice(0, 24)}`);
    if (isModifier(k)) mods.add(k);
    else if (main && main !== k) throw new Error('only one non-modifier key per chord');
    else main = k;
  }
  return { mods: MODIFIER_KEYS.filter((m) => mods.has(m)), main };
}

/* ───────────────────────── macOS (kVK_*, Carbon HIToolbox/Events.h) ───────────────────────── */

const MAC_LETTERS: Record<string, number> = {
  A: 0, S: 1, D: 2, F: 3, H: 4, G: 5, Z: 6, X: 7, C: 8, V: 9, B: 11, Q: 12, W: 13, E: 14, R: 15,
  Y: 16, T: 17, O: 31, U: 32, I: 34, P: 35, L: 37, J: 38, K: 40, N: 45, M: 46,
};
const MAC_DIGITS = [29, 18, 19, 20, 21, 23, 22, 26, 28, 25]; // 0..9
const MAC_F = [122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111, 105, 107, 113, 106, 64, 79, 80, 90]; // F1..F20
const MAC_KEYS: Record<string, number> = {
  Enter: 36, Tab: 48, Space: 49, Backspace: 51, Escape: 53, Delete: 117, Home: 115, End: 119,
  PageUp: 116, PageDown: 121, ArrowLeft: 123, ArrowRight: 124, ArrowDown: 125, ArrowUp: 126,
  CapsLock: 57, Equal: 24, Minus: 27, BracketRight: 30, BracketLeft: 33, Quote: 39, Semicolon: 41,
  Backslash: 42, Comma: 43, Slash: 44, Period: 47, Backquote: 50, Insert: 114 /* help */,
  NumpadDecimal: 65, NumpadMultiply: 67, NumpadAdd: 69, NumpadDivide: 75, NumpadEnter: 76,
  NumpadSubtract: 78, NumpadEqual: 81,
  Numpad0: 82, Numpad1: 83, Numpad2: 84, Numpad3: 85, Numpad4: 86, Numpad5: 87, Numpad6: 88,
  Numpad7: 89, Numpad8: 91, Numpad9: 92,
  Control: 59, Alt: 58, Shift: 56, Meta: 55, Fn: 63,
};

export function macKeyCode(k: KeyName): number | undefined {
  if (/^Key[A-Z]$/.test(k)) return MAC_LETTERS[k[3]];
  if (/^Digit\d$/.test(k)) return MAC_DIGITS[Number(k[5])];
  const f = /^F(\d{1,2})$/.exec(k);
  if (f) return MAC_F[Number(f[1]) - 1];
  return MAC_KEYS[k];
}

/** Modifier names the swift helper understands (CGEventFlags). */
export const MAC_MOD: Record<ModifierKey, string> = { Control: 'ctrl', Alt: 'alt', Shift: 'shift', Meta: 'cmd', Fn: 'fn' };

/* ───────────────────────── Windows (VK_*) ───────────────────────── */

/** Bit set on a VK when the key needs KEYEVENTF_EXTENDEDKEY. */
export const WIN_EXTENDED = 0x100;
const WIN_KEYS: Record<string, number> = {
  Backspace: 0x08, Tab: 0x09, Enter: 0x0d, Escape: 0x1b, Space: 0x20, CapsLock: 0x14, Pause: 0x13,
  PageUp: 0x21 | WIN_EXTENDED, PageDown: 0x22 | WIN_EXTENDED, End: 0x23 | WIN_EXTENDED, Home: 0x24 | WIN_EXTENDED,
  ArrowLeft: 0x25 | WIN_EXTENDED, ArrowUp: 0x26 | WIN_EXTENDED, ArrowRight: 0x27 | WIN_EXTENDED, ArrowDown: 0x28 | WIN_EXTENDED,
  PrintScreen: 0x2c | WIN_EXTENDED, Insert: 0x2d | WIN_EXTENDED, Delete: 0x2e | WIN_EXTENDED, ContextMenu: 0x5d | WIN_EXTENDED,
  NumpadMultiply: 0x6a, NumpadAdd: 0x6b, NumpadSubtract: 0x6d, NumpadDecimal: 0x6e, NumpadDivide: 0x6f | WIN_EXTENDED,
  NumpadEnter: 0x0d | WIN_EXTENDED, NumLock: 0x90 | WIN_EXTENDED, ScrollLock: 0x91,
  Semicolon: 0xba, Equal: 0xbb, Comma: 0xbc, Minus: 0xbd, Period: 0xbe, Slash: 0xbf, Backquote: 0xc0,
  BracketLeft: 0xdb, Backslash: 0xdc, BracketRight: 0xdd, Quote: 0xde,
  Control: 0x11, Alt: 0x12, Shift: 0x10, Meta: 0x5b | WIN_EXTENDED,
};

/** Windows virtual-key code (| WIN_EXTENDED for extended keys); undefined for Fn / unknown keys. */
export function winVk(k: KeyName): number | undefined {
  if (/^Key[A-Z]$/.test(k)) return k.charCodeAt(3);
  if (/^Digit\d$/.test(k)) return 0x30 + Number(k[5]);
  if (/^Numpad\d$/.test(k)) return 0x60 + Number(k[6]);
  const f = /^F(\d{1,2})$/.exec(k);
  if (f && Number(f[1]) >= 1 && Number(f[1]) <= 24) return 0x6f + Number(f[1]);
  return WIN_KEYS[k];
}

/* ───────────────────────── X11 (xdotool keysyms) ───────────────────────── */

const XDO_KEYS: Record<string, string> = {
  Enter: 'Return', Tab: 'Tab', Space: 'space', Backspace: 'BackSpace', Escape: 'Escape', Delete: 'Delete',
  Insert: 'Insert', Home: 'Home', End: 'End', PageUp: 'Page_Up', PageDown: 'Page_Down',
  ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down', CapsLock: 'Caps_Lock',
  NumLock: 'Num_Lock', ScrollLock: 'Scroll_Lock', PrintScreen: 'Print', Pause: 'Pause', ContextMenu: 'Menu',
  Minus: 'minus', Equal: 'equal', BracketLeft: 'bracketleft', BracketRight: 'bracketright', Backslash: 'backslash',
  Semicolon: 'semicolon', Quote: 'apostrophe', Comma: 'comma', Period: 'period', Slash: 'slash', Backquote: 'grave',
  NumpadAdd: 'KP_Add', NumpadSubtract: 'KP_Subtract', NumpadMultiply: 'KP_Multiply', NumpadDivide: 'KP_Divide',
  NumpadDecimal: 'KP_Decimal', NumpadEnter: 'KP_Enter', NumpadEqual: 'KP_Equal',
  Control: 'ctrl', Alt: 'alt', Shift: 'shift', Meta: 'super',
};

export function xdoKeysym(k: KeyName): string | undefined {
  if (/^Key[A-Z]$/.test(k)) return k[3].toLowerCase();
  if (/^Digit\d$/.test(k)) return k[5];
  if (/^Numpad\d$/.test(k)) return 'KP_' + k[6];
  if (/^F\d{1,2}$/.test(k)) return k;
  return XDO_KEYS[k];
}

/** "ctrl+shift+s" for xdotool key. Fn is dropped (the keyboard handles it off mac). */
export function xdoChord(keys: KeyName[]): string {
  const { mods, main } = splitChord(keys);
  const parts = mods.filter((m) => m !== 'Fn').map((m) => XDO_KEYS[m]);
  if (main) {
    const s = xdoKeysym(main);
    if (!s) throw new Error(`can't press ${main} on linux`);
    parts.push(s);
  }
  if (!parts.length) throw new Error('empty key chord');
  return parts.join('+');
}

/** VKs in press order (modifiers first). Fn is dropped. */
export function winChord(keys: KeyName[]): number[] {
  const { mods, main } = splitChord(keys);
  const out = mods.filter((m) => m !== 'Fn').map((m) => WIN_KEYS[m]);
  if (main) {
    const vk = winVk(main);
    if (vk === undefined) throw new Error(`can't press ${main} on windows`);
    out.push(vk);
  }
  if (!out.length) throw new Error('empty key chord');
  return out;
}

/** { code, mods } for the swift helper; code -1 = modifier-only chord. */
export function macChord(keys: KeyName[]): { code: number; mods: string[] } {
  const { mods, main } = splitChord(keys);
  let code = -1;
  if (main) {
    const c = macKeyCode(main);
    if (c === undefined) throw new Error(`can't press ${main} on mac`);
    code = c;
  }
  return { code, mods: mods.map((m) => MAC_MOD[m]) };
}

const CANONICAL = new Set<string>([
  ...Object.keys(MAC_KEYS), ...Object.keys(WIN_KEYS), ...Object.keys(XDO_KEYS),
]);

/* ───────────────────────── coordinates ───────────────────────── */

export interface Rect { x: number; y: number; width: number; height: number }
export interface Pt { x: number; y: number }

/** Clamp a point into a rectangle (inclusive of the last pixel row/column). */
export function clampToRect(p: Pt, r: Rect): Pt {
  const cl = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));
  return { x: cl(p.x, r.x, r.x + r.width - 1), y: cl(p.y, r.y, r.y + r.height - 1) };
}

/** Physical-pixel point → MOUSEEVENTF_ABSOLUTE|VIRTUALDESK coordinates (0..65535 across the virtual screen). */
export function toWinAbsolute(p: Pt, virt: Rect): Pt {
  const n = (v: number, o: number, size: number) => {
    if (size <= 1) return 0;
    return Math.min(65535, Math.max(0, Math.round(((v - o) * 65535) / (size - 1))));
  };
  return { x: n(p.x, virt.x, virt.width), y: n(p.y, virt.y, virt.height) };
}

/** Global DIP → X11 physical pixels (Electron on Linux scales the whole desktop by one factor). */
export function dipToX11(p: Pt, scaleFactor: number): Pt {
  const s = scaleFactor > 0 ? scaleFactor : 1;
  return { x: Math.round(p.x * s), y: Math.round(p.y * s) };
}
