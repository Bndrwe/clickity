// Chord helpers: KeyboardEvent.code <-> canonical KeyName <-> lowercase label.
import type { KeyName } from '../../shared/types';

const MODS = ['Control', 'Alt', 'Shift', 'Meta'];

export function canonicalCode(code: string): KeyName {
  if (code === 'ControlLeft' || code === 'ControlRight') return 'Control';
  if (code === 'AltLeft' || code === 'AltRight') return 'Alt';
  if (code === 'ShiftLeft' || code === 'ShiftRight') return 'Shift';
  if (code === 'MetaLeft' || code === 'MetaRight' || code === 'OSLeft' || code === 'OSRight') return 'Meta';
  return code;
}

export const isModifier = (k: KeyName): boolean => MODS.includes(k);
export const isFunctionKey = (k: KeyName): boolean => /^F([1-9]|1\d|2[0-4])$/.test(k);

/** modifiers first (control, alt, shift, meta), then the rest in the order given */
export function orderChord(keys: Iterable<KeyName>): KeyName[] {
  const set = [...new Set(keys)];
  return [...MODS.filter((m) => set.includes(m)), ...set.filter((k) => !isModifier(k))];
}

/** at least one key, and a non-shift modifier or a function key, so plain typing is never hijacked */
export function validateChord(keys: KeyName[]): string | null {
  if (keys.length === 0) return 'press at least one key';
  const ok = keys.some((k) => k === 'Control' || k === 'Alt' || k === 'Meta' || isFunctionKey(k));
  return ok ? null : 'include control, option, cmd or an f-key';
}

const PUNCT: Record<string, string> = {
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
  Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', IntlBackslash: '\\',
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
};

export function keyWord(k: KeyName, platform: string): string {
  const mac = platform === 'darwin';
  switch (k) {
    case 'Control': return mac ? 'control' : 'ctrl';
    case 'Alt': return mac ? 'option' : 'alt';
    case 'Shift': return 'shift';
    case 'Meta': return mac ? 'cmd' : 'win';
  }
  if (k in PUNCT) return PUNCT[k];
  let m = /^Key([A-Z])$/.exec(k);
  if (m) return m[1].toLowerCase();
  m = /^Digit(\d)$/.exec(k);
  if (m) return m[1];
  m = /^Numpad(.+)$/.exec(k);
  if (m) return 'num ' + m[1].replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return k.replace(/([a-z\d])([A-Z])/g, '$1 $2').toLowerCase();
}

export function chordLabel(keys: KeyName[], platform: string): string {
  return orderChord(keys).map((k) => keyWord(k, platform)).join(' + ');
}
