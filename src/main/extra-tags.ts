// [REMEMBER:fact], [HIGHLIGHT:x1,y1,x2,y2:label:screenN], [STEP:n:x,y:label:instruction:screenN]
// and [ROUTINE:days|HH:MM|prompt] tags. Pure, unit tested. Like POINT tags they are never shown
// or spoken; conversation.ts strips them from the visible reply.

export const MAX_STEPS = 15;
export const MAX_HIGHLIGHTS = 8;
export const MAX_REMEMBER_CHARS = 300;

const TAG_RE = /\[(REMEMBER|HIGHLIGHT|STEP|ROUTINE):((?:\\.|[^\]\\\n])*)\]/gi;
/** A trailing tag that has started streaming but isn't closed yet. */
const PARTIAL_RE = /\[(?:R(?:E(?:M(?:E(?:M(?:B(?:E(?:R)?)?)?)?)?)?|O(?:U(?:T(?:I(?:N(?:E)?)?)?)?)?)?|H(?:I(?:G(?:H(?:L(?:I(?:G(?:H(?:T)?)?)?)?)?)?)?)?|S(?:T(?:E(?:P)?)?)?)(?::[^\]\n]*)?$/i;

export interface ParsedHighlight {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  label: string;
  screen?: number;
}

export interface ParsedStep {
  n: number;
  x: number;
  y: number;
  label: string;
  instruction: string;
  screen?: number;
}

export interface ParsedRoutine {
  days: number[];
  time: string;
  prompt: string;
}

export interface ExtraTags {
  remember: string[];
  highlights: ParsedHighlight[];
  steps: ParsedStep[];
  routines: ParsedRoutine[];
}

const unescape = (s: string): string => s.replace(/\\(.)/g, '$1');

/** Split on ':' that isn't escaped. */
function splitColons(inner: string): string[] {
  const out = [''];
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === '\\' && i + 1 < inner.length) {
      out[out.length - 1] += inner[i + 1];
      i++;
    } else if (c === ':') out.push('');
    else out[out.length - 1] += c;
  }
  return out.map((p) => p.trim());
}

function popScreen(parts: string[]): number | undefined {
  if (parts.length < 2) return undefined;
  const m = /^screen\s*(\d+)$/i.exec(parts[parts.length - 1]);
  if (!m) return undefined;
  parts.pop();
  return Number(m[1]);
}

const NUM = '(-?\\d+(?:\\.\\d+)?)';

export function parseExtraTags(text: string): ExtraTags {
  const out: ExtraTags = { remember: [], highlights: [], steps: [], routines: [] };
  for (const m of text.matchAll(TAG_RE)) {
    const kind = m[1].toUpperCase();
    const inner = m[2];
    if (kind === 'REMEMBER') {
      const fact = unescape(inner).replace(/\s+/g, ' ').trim().slice(0, MAX_REMEMBER_CHARS);
      if (fact && !/^none$/i.test(fact)) out.remember.push(fact);
    } else if (kind === 'HIGHLIGHT') {
      if (out.highlights.length >= MAX_HIGHLIGHTS) continue;
      const parts = splitColons(inner);
      const screen = popScreen(parts);
      const c = new RegExp(`^${NUM}\\s*,\\s*${NUM}\\s*,\\s*${NUM}\\s*,\\s*${NUM}$`).exec(parts[0] ?? '');
      if (!c) continue;
      const [x1, y1, x2, y2] = [1, 2, 3, 4].map((i) => Number(c[i]));
      if (x1 === x2 || y1 === y2) continue;
      out.highlights.push({ x1: Math.min(x1, x2), y1: Math.min(y1, y2), x2: Math.max(x1, x2), y2: Math.max(y1, y2), label: parts.slice(1).join(':') || '', screen });
    } else if (kind === 'STEP') {
      const parts = splitColons(inner);
      const screen = popScreen(parts);
      const n = Number(parts[0]);
      const c = new RegExp(`^${NUM}\\s*,\\s*${NUM}$`).exec(parts[1] ?? '');
      if (!Number.isFinite(n) || !c) continue;
      const label = parts[2] ?? '';
      const instruction = parts.slice(3).join(': ').trim() || label;
      out.steps.push({ n, x: Number(c[1]), y: Number(c[2]), label: label || 'here', instruction, screen });
    } else if (kind === 'ROUTINE') {
      const r = parseRoutineTag(unescape(inner));
      if (r) out.routines.push(r);
    }
  }
  out.steps.sort((a, b) => a.n - b.n);
  out.steps = out.steps.slice(0, MAX_STEPS);
  return out;
}

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** "weekdays" / "daily" / "mon,wed,fri" / "1-5" → day numbers (0 = sunday). */
export function parseDays(spec: string): number[] {
  const s = spec.toLowerCase().trim();
  if (/^(daily|every ?day|everyday|all|\*)$/.test(s)) return [0, 1, 2, 3, 4, 5, 6];
  if (/^week ?days?$/.test(s)) return [1, 2, 3, 4, 5];
  if (/^week ?ends?$/.test(s)) return [0, 6];
  const days = new Set<number>();
  for (const part of s.split(/[,\s]+/).filter(Boolean)) {
    const range = /^(\w+)-(\w+)$/.exec(part);
    const one = (w: string): number => {
      if (/^\d$/.test(w)) return Number(w) % 7;
      const i = DAY_NAMES.findIndex((d) => w.startsWith(d));
      return i;
    };
    if (range) {
      const a = one(range[1]);
      const b = one(range[2]);
      if (a < 0 || b < 0) return [];
      for (let d = a; ; d = (d + 1) % 7) {
        days.add(d);
        if (d === b) break;
      }
    } else {
      const d = one(part);
      if (d < 0) return [];
      days.add(d);
    }
  }
  return [...days].sort();
}

/** "HH:MM" (24h) or "9", "9am", "5:30 pm" → "HH:MM", or null. */
export function parseTime(spec: string): string | null {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(spec.trim());
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  const ap = m[3]?.toLowerCase();
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

export function parseRoutineTag(inner: string): ParsedRoutine | null {
  const [daysSpec, timeSpec, ...rest] = inner.split('|');
  const prompt = rest.join('|').replace(/\s+/g, ' ').trim();
  if (!daysSpec || !timeSpec || !prompt) return null;
  const days = parseDays(daysSpec);
  const time = parseTime(timeSpec);
  if (!days.length || !time) return null;
  return { days, time, prompt: prompt.slice(0, 500) };
}

/** Remove every extra tag (and, while streaming, a trailing partial one). */
export function stripExtraTags(text: string, streaming = false): string {
  let out = text.replace(TAG_RE, '');
  if (streaming) out = out.replace(PARTIAL_RE, '');
  else out = out.replace(PARTIAL_RE, '').replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+\n/g, '\n');
  return streaming ? out : out.trim();
}

/* ───────── memory facts ───────── */

/** Secret-looking facts are never remembered. */
export function isSecretFact(fact: string): boolean {
  if (/\b(password|passcode|passwd|pin code|pin is|secret|token|api[-_ ]?key|private key|social security|ssn|cvv|card number)\b/i.test(fact)) return true;
  if (/\b(sk|pk|rk|ghp|xox[abp]|AKIA|AIza)[-_A-Za-z0-9]{12,}/.test(fact)) return true;
  if (/(?:\d[ -]?){13,19}/.test(fact)) return true; // card-like digit runs
  if (/\S{32,}/.test(fact) && /\d/.test(fact)) return true; // long token
  return false;
}

/** Merge new facts into a list: trimmed, case-insensitive dedupe, secrets dropped, newest kept (cap). */
export function mergeFacts(existing: readonly string[], added: readonly string[], cap = 200): string[] {
  const out = [...existing];
  const key = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  for (const raw of added) {
    const f = raw.replace(/\s+/g, ' ').trim().slice(0, MAX_REMEMBER_CHARS);
    if (!f || isSecretFact(f)) continue;
    const k = key(f);
    const i = out.findIndex((e) => key(e) === k);
    if (i >= 0) out.splice(i, 1);
    out.push(f);
  }
  return out.slice(-cap);
}
