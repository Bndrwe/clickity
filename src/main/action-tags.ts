// Agent-mode action tags (see ARCHITECTURE.md "Agent mode"). Pure, unit tested.
//
//   [CLICK:x,y:label:screenN]  [DOUBLECLICK:x,y:label:screenN]  [RIGHTCLICK:x,y:label:screenN]
//   [TYPE:text]          text may contain anything; a literal ']' is written '\]' (and '\' as '\\')
//   [KEY:cmd+s]          one chord, human key names → canonical KeyName
//   [SCROLL:x,y:down 5:screenN]
//   [WAIT:500]           milliseconds (also "1s", "500ms")
//   [DONE]               the task is complete
//
// Coordinates are screenshot pixels, like [POINT:…]; conversation.ts maps them to global DIP.
import type { KeyName } from '../shared/types';

export type ParsedAction =
  | { type: 'click'; x: number; y: number; label: string; screen?: number; button: 'left' | 'right'; count: 1 | 2 }
  | { type: 'scroll'; x: number; y: number; screen?: number; dy: number; dx: number; label: string }
  | { type: 'type'; text: string }
  | { type: 'key'; keys: KeyName[]; label: string }
  | { type: 'wait'; ms: number };

export interface ParsedActions {
  actions: ParsedAction[];
  /** a [DONE] tag was present */
  done: boolean;
}

const TAG_NAMES = ['DOUBLECLICK', 'RIGHTCLICK', 'CLICK', 'TYPE', 'KEY', 'SCROLL', 'WAIT', 'DONE'] as const;
type TagName = (typeof TAG_NAMES)[number];

const MAX_WAIT_MS = 10_000;
const MAX_SCROLL = 50;
const MAX_TYPE = 2000;

interface RawTag {
  name: TagName;
  /** text after "NAME:" (unescaped for TYPE), '' when absent */
  inner: string;
  start: number;
  end: number; // exclusive; buffer length when unclosed
  closed: boolean;
}

/** Every action tag in `text`, in order, plus a trailing unclosed one (closed: false). */
function scanTags(text: string): RawTag[] {
  const out: RawTag[] = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('[', i);
    if (open < 0) break;
    const head = text.slice(open + 1, open + 1 + 12).toUpperCase();
    const name = TAG_NAMES.find((n) => head.startsWith(n) && (head.length === n.length || head[n.length] === ':' || head[n.length] === ']'));
    if (!name) {
      i = open + 1;
      continue;
    }
    let j = open + 1 + name.length;
    if (j >= text.length) {
      out.push({ name, inner: '', start: open, end: text.length, closed: false });
      break;
    }
    if (text[j] === ']') {
      out.push({ name, inner: '', start: open, end: j + 1, closed: true });
      i = j + 1;
      continue;
    }
    j++; // ':'
    const isType = name === 'TYPE';
    let inner = '';
    let closed = false;
    let bad = false;
    for (; j < text.length; j++) {
      const c = text[j];
      if (isType && c === '\\' && (text[j + 1] === ']' || text[j + 1] === '\\')) {
        inner += text[j + 1];
        j++;
        continue;
      }
      if (c === ']') {
        closed = true;
        break;
      }
      if (!isType && (c === '\n' || c === '[')) {
        bad = true; // not a real tag (e.g. "[KEY: the …" in prose that never closes)
        break;
      }
      inner += c;
    }
    if (bad) {
      i = open + 1;
      continue;
    }
    if (!closed) {
      out.push({ name, inner, start: open, end: text.length, closed: false });
      break;
    }
    out.push({ name, inner, start: open, end: j + 1, closed: true });
    i = j + 1;
  }
  return out;
}

/** "[", "[C", "[CLI", "[TYPE" … at the very end while streaming (a tag that may be starting). */
function partialHeadAt(text: string): number {
  const open = text.lastIndexOf('[');
  if (open < 0) return -1;
  const tail = text.slice(open + 1).toUpperCase();
  if (tail.length === 0) return open;
  if (tail.includes(':') || tail.includes(']') || tail.length > 11) return -1;
  return TAG_NAMES.some((n) => n.startsWith(tail)) ? open : -1;
}

/** Remove complete action tags; with `streaming`, also hide a trailing unclosed / partial tag. */
export function stripActionTags(text: string, streaming = false): string {
  const tags = scanTags(text);
  let out = '';
  let pos = 0;
  for (const t of tags) {
    if (!t.closed && !streaming) continue; // final text: an unclosed fragment is dropped below
    out += text.slice(pos, t.start);
    pos = t.end;
  }
  let rest = text.slice(pos);
  if (!streaming) {
    // an unclosed tag at the end of a finished reply: drop it too
    const last = tags[tags.length - 1];
    if (last && !last.closed && last.start >= pos) rest = text.slice(pos, last.start);
  } else {
    const p = partialHeadAt(rest);
    if (p >= 0) rest = rest.slice(0, p);
  }
  return out + rest;
}

/** True when `text` holds at least one complete action tag (or [DONE]). */
export function hasActionTags(text: string): boolean {
  return scanTags(text).some((t) => t.closed);
}

/* ───────────────────────── parsing ───────────────────────── */

const NUM = '(-?\\d+(?:\\.\\d+)?)';
const COORDS_RE = new RegExp(`^${NUM}\\s*,\\s*${NUM}$`);

/** "x,y:rest…:screenN" → coords, middle parts and screen. */
function splitTarget(inner: string): { x: number; y: number; middle: string[]; screen?: number } | null {
  const parts = inner.split(':').map((p) => p.trim());
  const coords = COORDS_RE.exec(parts[0] ?? '');
  if (!coords) return null;
  let screen: number | undefined;
  if (parts.length > 1) {
    const m = /^screen\s*(\d+)$/i.exec(parts[parts.length - 1]);
    if (m) {
      screen = Number(m[1]);
      parts.pop();
    }
  }
  return { x: Number(coords[1]), y: Number(coords[2]), middle: parts.slice(1), screen };
}

const MOD_ALIASES: Record<string, KeyName> = {
  ctrl: 'Control', control: 'Control', ctl: 'Control',
  alt: 'Alt', option: 'Alt', opt: 'Alt', '⌥': 'Alt',
  shift: 'Shift', '⇧': 'Shift',
  cmd: 'Meta', command: 'Meta', meta: 'Meta', super: 'Meta', win: 'Meta', windows: 'Meta', '⌘': 'Meta',
  '⌃': 'Control',
};

const KEY_ALIASES: Record<string, KeyName> = {
  enter: 'Enter', return: 'Enter', esc: 'Escape', escape: 'Escape', tab: 'Tab', space: 'Space', spacebar: 'Space',
  backspace: 'Backspace', delete: 'Delete', del: 'Delete', forwarddelete: 'Delete', insert: 'Insert', ins: 'Insert',
  home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown', pgup: 'PageUp', pgdn: 'PageDown',
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
  arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight',
  '↑': 'ArrowUp', '↓': 'ArrowDown', '←': 'ArrowLeft', '→': 'ArrowRight',
  capslock: 'CapsLock', minus: 'Minus', '-': 'Minus', equal: 'Equal', equals: 'Equal', '=': 'Equal',
  comma: 'Comma', ',': 'Comma', period: 'Period', dot: 'Period', '.': 'Period', slash: 'Slash', '/': 'Slash',
  semicolon: 'Semicolon', ';': 'Semicolon', quote: 'Quote', "'": 'Quote', backquote: 'Backquote', '`': 'Backquote',
  '[': 'BracketLeft', ']': 'BracketRight', backslash: 'Backslash', '\\': 'Backslash',
};

const MOD_ORDER = ['Control', 'Alt', 'Shift', 'Meta'];

/**
 * Human chord → canonical KeyName[] ("cmd+s" → ['Meta','KeyS'], "enter" → ['Enter'],
 * "ctrl+shift+tab"). `mod` / `cmdorctrl` → cmd on mac, ctrl elsewhere. Null when not understood
 * or when it has more than one non-modifier key.
 */
export function parseKeyChord(spec: string, platform: string = process.platform): KeyName[] | null {
  const s = spec.trim();
  if (!s) return null;
  let parts = s.split(/\s*\+\s*|\s+/).filter(Boolean);
  // "ctrl-c" style
  if (parts.length === 1 && /^[a-z⌘⌥⌃⇧]+-.+$/i.test(s)) {
    const [m, ...rest] = s.split('-');
    if (MOD_ALIASES[m.toLowerCase()] || /^(mod|cmdorctrl)$/i.test(m)) parts = [m, rest.join('-')];
  }
  // "cmd+" + "+" → the plus key isn't expressible; trailing '+' means a lone "+" was split away
  if (/\+$/.test(s) && !/\+\s*\+$/.test(s) && parts.length && s !== '+') return null;
  const mods = new Set<KeyName>();
  let main: KeyName | null = null;
  for (const raw of parts) {
    const lower = raw.toLowerCase();
    let k: KeyName | null = null;
    let isMod = false;
    if (lower === 'mod' || lower === 'cmdorctrl' || lower === 'commandorcontrol') {
      k = platform === 'darwin' ? 'Meta' : 'Control';
      isMod = true;
    } else if (MOD_ALIASES[lower] ?? MOD_ALIASES[raw]) {
      k = MOD_ALIASES[lower] ?? MOD_ALIASES[raw];
      isMod = true;
    } else if (/^[a-z]$/i.test(raw)) k = 'Key' + raw.toUpperCase();
    else if (/^[0-9]$/.test(raw)) k = 'Digit' + raw;
    else if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(raw)) k = 'F' + raw.slice(1);
    else if (KEY_ALIASES[lower] ?? KEY_ALIASES[raw]) k = KEY_ALIASES[lower] ?? KEY_ALIASES[raw];
    else if (/^key[a-z]$/i.test(raw)) k = 'Key' + raw.slice(3).toUpperCase();
    else if (/^digit[0-9]$/i.test(raw)) k = 'Digit' + raw.slice(5);
    else if (/^numpad(\d|enter|add|subtract|multiply|divide|decimal)$/i.test(raw)) k = 'Numpad' + raw.slice(6).charAt(0).toUpperCase() + raw.slice(7).toLowerCase();
    if (!k) return null;
    if (isMod) mods.add(k);
    else {
      if (main && main !== k) return null;
      main = k;
    }
  }
  if (!main && mods.size === 0) return null;
  return [...MOD_ORDER.filter((m) => mods.has(m)), ...(main ? [main] : [])];
}

function parseWait(inner: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|seconds?)?$/i.exec(inner.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const ms = m[2] && !/^ms$/i.test(m[2]) ? n * 1000 : n;
  return Math.round(Math.min(MAX_WAIT_MS, Math.max(0, ms)));
}

function parseScroll(middle: string[]): { dx: number; dy: number } | null {
  const spec = (middle.join(' ') || 'down').trim().toLowerCase();
  let dir: string;
  let amount: string | undefined;
  const a = /^(up|down|left|right)(?:\s*(?:by\s*)?(\d+(?:\.\d+)?))?$/.exec(spec);
  const b = a ? null : /^(\d+(?:\.\d+)?)\s*(up|down|left|right)$/.exec(spec);
  if (a) [dir, amount] = [a[1], a[2]];
  else if (b) [dir, amount] = [b[2], b[1]];
  else return null;
  const n = Math.min(MAX_SCROLL, Math.max(1, Math.round(Number(amount ?? 3) || 3)));
  if (dir === 'down') return { dx: 0, dy: n };
  if (dir === 'up') return { dx: 0, dy: -n };
  if (dir === 'right') return { dx: n, dy: 0 };
  return { dx: -n, dy: 0 };
}

/** Parse every complete action tag in order. Malformed tags are skipped. */
export function parseActionTags(text: string, platform: string = process.platform): ParsedActions {
  const actions: ParsedAction[] = [];
  let done = false;
  for (const t of scanTags(text)) {
    if (!t.closed) continue;
    switch (t.name) {
      case 'DONE':
        done = true;
        break;
      case 'CLICK':
      case 'DOUBLECLICK':
      case 'RIGHTCLICK': {
        const tg = splitTarget(t.inner);
        if (!tg) break;
        actions.push({
          type: 'click',
          x: tg.x,
          y: tg.y,
          label: tg.middle.join(':').trim() || 'here',
          screen: tg.screen,
          button: t.name === 'RIGHTCLICK' ? 'right' : 'left',
          count: t.name === 'DOUBLECLICK' ? 2 : 1,
        });
        break;
      }
      case 'SCROLL': {
        const tg = splitTarget(t.inner);
        if (!tg) break;
        const d = parseScroll(tg.middle);
        if (!d) break;
        const dir = d.dy > 0 ? 'down' : d.dy < 0 ? 'up' : d.dx > 0 ? 'right' : 'left';
        actions.push({ type: 'scroll', x: tg.x, y: tg.y, screen: tg.screen, dx: d.dx, dy: d.dy, label: `${dir} ${Math.abs(d.dy || d.dx)}` });
        break;
      }
      case 'TYPE': {
        if (!t.inner) break;
        actions.push({ type: 'type', text: t.inner.slice(0, MAX_TYPE) });
        break;
      }
      case 'KEY': {
        const keys = parseKeyChord(t.inner, platform);
        if (!keys) break;
        actions.push({ type: 'key', keys, label: t.inner.trim().toLowerCase().replace(/\s*\+\s*/g, '+') });
        break;
      }
      case 'WAIT': {
        const ms = parseWait(t.inner);
        if (ms === null) break;
        actions.push({ type: 'wait', ms });
        break;
      }
    }
  }
  return { actions, done };
}

/* ───────────────────────── summaries ───────────────────────── */

function quoteShort(s: string, max: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/**
 * One action in a few words. 'plan' → "click “save”" (confirm bubble), 'past' → "clicked save" (chat log).
 */
export function describeAction(a: ParsedAction, tense: 'plan' | 'past' = 'plan'): string {
  const p = tense === 'past';
  switch (a.type) {
    case 'click': {
      const verb = a.button === 'right' ? (p ? 'right-clicked' : 'right-click') : a.count === 2 ? (p ? 'double-clicked' : 'double-click') : p ? 'clicked' : 'click';
      const label = quoteShort(a.label.toLowerCase(), 32);
      return p ? `${verb} ${label}` : `${verb} “${label}”`;
    }
    case 'type': {
      const text = quoteShort(a.text, p ? 32 : 48);
      return p ? `typed ${text}` : `type “${text}”`;
    }
    case 'key':
      return `${p ? 'pressed' : 'press'} ${a.label}`;
    case 'scroll':
      return `${p ? 'scrolled' : 'scroll'} ${a.label}`;
    case 'wait': {
      const secs = a.ms >= 1000 ? `${+(a.ms / 1000).toFixed(1)}s` : `${a.ms}ms`;
      return `${p ? 'waited' : 'wait'} ${secs}`;
    }
  }
}

/** "click “save” · type “hello” · press cmd+s" (waits left out unless that's all there is). */
export function summarizeActions(actions: ParsedAction[], tense: 'plan' | 'past' = 'plan'): string {
  const shown = actions.filter((a) => a.type !== 'wait');
  return (shown.length ? shown : actions).map((a) => describeAction(a, tense)).join(' · ');
}

/**
 * Does the user's message ask clickity to DO something (vs. ask a question)?
 * Used only to decide whether to nudge a model that answered with words instead of actions.
 */
export function wantsAction(text: string | undefined): boolean {
  const t = (text ?? '').trim().toLowerCase().replace(/^(hey |ok |okay )?(clickity|clicky)[,:]?\s*/, '');
  if (!t || /^(where|what|why|how|which|who|when|is |are |does |do i|can i|should i)\b/.test(t)) return false;
  const verbs =
    'open|click|double[- ]click|right[- ]click|tap|press|hit|type|write|enter|fill( in)?|go to|navigate|scroll|close|quit|exit|launch|start|play|pause|resume|skip|stop|mute|unmute|switch to|select|choose|pick|check|uncheck|tick|toggle|turn (on|off)|enable|disable|minimize|maximize|bring up|search( for)?|find and|save|copy|paste|undo|redo|refresh|reload|log ?in|sign in|submit|send|download|install|bookmark|zoom|do it|agent';
  const lead = '(please |pls |can you |could you |would you |will you |just |now |go ahead and |agent:? )*';
  return new RegExp(`^${lead}(${verbs})\\b`).test(t);
}
