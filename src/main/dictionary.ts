// Dictation text helpers: custom words → whisper prompt, replacements, dash style, and the
// "you corrected one word" detector behind the auto-learn suggestions. Pure (no electron) so it
// can be unit tested with `node --experimental-strip-types --test`.

export interface Replacement {
  from: string;
  to: string;
}

const MAX_PROMPT_CHARS = 600;

/** Whisper initial prompt from the custom words: "Clickity, Bndrwe, Kubernetes." ('' = none). */
export function dictionaryPrompt(words: readonly string[]): string {
  const clean = [...new Set(words.map((w) => String(w ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean))];
  if (!clean.length) return '';
  let out = '';
  for (const w of clean) {
    const next = out ? `${out}, ${w}` : w;
    if (next.length > MAX_PROMPT_CHARS) break;
    out = next;
  }
  return out ? `${out}.` : '';
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Apply replacements, case-insensitively, on word boundaries, longest "from" first. A lowercase
 * replacement at the start of a sentence keeps the sentence's capital ("Clicky tea…" → "Clickity…").
 */
export function applyReplacements(text: string, replacements: readonly Replacement[]): string {
  const list = replacements
    .map((r) => ({ from: String(r?.from ?? '').trim(), to: String(r?.to ?? '') }))
    .filter((r) => r.from)
    .sort((a, b) => b.from.length - a.from.length);
  let out = text;
  for (const r of list) {
    // \b only works next to word characters; fall back to whitespace / edges otherwise
    const pre = /^\w/.test(r.from) ? '\\b' : '(?<=^|\\s)';
    const post = /\w$/.test(r.from) ? '\\b' : '(?=$|\\s)';
    const re = new RegExp(`${pre}${escapeRe(r.from).replace(/\\? +/g, '\\s+')}${post}`, 'gi');
    out = out.replace(re, (match: string, offset: number, whole: string) => {
      const sentenceStart = offset === 0 || /[.!?]\s+$/.test(whole.slice(0, offset));
      const capital = /^[A-Z]/.test(match) && sentenceStart;
      return capital && r.to ? r.to[0].toUpperCase() + r.to.slice(1) : r.to;
    });
  }
  return out.replace(/ {2,}/g, ' ');
}

/** Em / en dashes in dictated text: keep them, or turn them into commas / plain hyphens. */
export function fixDashes(text: string, mode: 'keep' | 'comma' | 'hyphen'): string {
  if (mode === 'keep') return text;
  if (mode === 'hyphen') return text.replace(/\s*[—–]\s*/g, ' - ');
  return text.replace(/\s*[—–]\s*/g, ', ').replace(/,\s*([.!?])/g, '$1');
}

const words = (s: string): string[] => s.trim().split(/\s+/).filter(Boolean);
const norm = (w: string): string => w.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');

/**
 * The user dictated `next` shortly after `prev`. If `next` is `prev` with one word (or a short run
 * of up to 3 words, like "clicky tea") swapped for one word, or `next` is just a single word that
 * looks like a fix for one of prev's words, return that correction.
 */
export function detectCorrection(prev: string, next: string): Replacement | null {
  const a = words(prev);
  const b = words(next);
  if (!a.length || !b.length) return null;
  if (b.length === 1 && a.length > 1) {
    // a lone re-dictated word: pair it with the most similar word of the previous text
    const target = norm(b[0]);
    if (!target) return null;
    let best: { w: string; score: number } | null = null;
    for (let i = 0; i < a.length; i++) {
      for (let n = 1; n <= 3 && i + n <= a.length; n++) {
        const run = a.slice(i, i + n).map(norm).join(' ');
        if (!run || run === target) continue;
        const score = similarity(run.replace(/ /g, ''), target);
        if (!best || score > best.score) best = { w: a.slice(i, i + n).map(norm).join(' '), score };
      }
    }
    return best && best.score >= 0.5 ? { from: best.w, to: b[0].replace(/[.,!?;:]+$/, '') } : null;
  }
  let p = 0;
  while (p < a.length && p < b.length && norm(a[p]) === norm(b[p])) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && norm(a[a.length - 1 - s]) === norm(b[b.length - 1 - s])) s++;
  const oldRun = a.slice(p, a.length - s);
  const newRun = b.slice(p, b.length - s);
  if (newRun.length !== 1 || oldRun.length < 1 || oldRun.length > 3) return null;
  // the rest must match: at least one shared word, so this is a re-dictation, not a new sentence
  if (p + s === 0) return null;
  const from = oldRun.map(norm).join(' ');
  const to = newRun[0].replace(/[.,!?;:]+$/, '');
  if (!from || !norm(to) || from === norm(to)) return null;
  return { from, to };
}

/** 0..1 letter-bigram overlap (Dice), good enough to tell "clickytea" ~ "clickity". */
export function similarity(x: string, y: string): number {
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const grams = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) m.set(s.slice(i, i + 2), (m.get(s.slice(i, i + 2)) ?? 0) + 1);
    return m;
  };
  const gx = grams(x);
  const gy = grams(y);
  let hit = 0;
  for (const [g, n] of gx) hit += Math.min(n, gy.get(g) ?? 0);
  return (2 * hit) / (x.length - 1 + (y.length - 1));
}

/** Text that would run a command if pasted into a terminal prompt (a newline in it). */
export function looksLikeCommandRisk(text: string): boolean {
  return /[\r\n]/.test(text.trim());
}

/** Very rough "this looks like a secret" check (api keys, tokens, card numbers, password lines). */
export function looksSecret(text: string): boolean {
  const t = text.trim();
  if (/\b(sk|pk|rk|ghp|gho|ghs|xox[abp]|AKIA|AIza)[-_A-Za-z0-9]{12,}/.test(t)) return true;
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(t)) return true;
  if (/\b(?:\d[ -]?){13,19}\b/.test(t) && luhnAny(t)) return true;
  if (/\b(password|passcode|passwd|pin|secret|token|api[-_ ]?key)\s*[:=]\s*\S+/i.test(t)) return true;
  // one long token mixing letters and digits with no spaces
  if (!/\s/.test(t) && t.length >= 24 && /[a-z]/i.test(t) && /\d/.test(t)) return true;
  return false;
}

function luhnAny(t: string): boolean {
  for (const m of t.matchAll(/(?:\d[ -]?){13,19}/g)) {
    const d = m[0].replace(/\D/g, '');
    if (d.length < 13 || d.length > 19) continue;
    let sum = 0;
    for (let i = 0; i < d.length; i++) {
      let n = Number(d[d.length - 1 - i]);
      if (i % 2) {
        n *= 2;
        if (n > 9) n -= 9;
      }
      sum += n;
    }
    if (sum % 10 === 0) return true;
  }
  return false;
}
