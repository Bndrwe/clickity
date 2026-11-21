// Wake word ("hey clickity"): pure helpers shared by main and the overlay renderer, unit tested
// (test/wake.test.ts). The overlay's voice-activity detector cuts speech into short segments, the
// on-device whisper transcribes the first ~2 s of each, and matchWake() decides whether the user
// was talking to clickity (or to one of their clickys by name). WakeGate caps how often that
// transcription runs, so the CPU cost stays bounded however noisy the room is.

export type WakeSensitivity = 'low' | 'medium' | 'high';

export interface WakeTuning {
  /** VAD threshold (RMS): lower = hears quieter speech, and more noise */
  vadThreshold: number;
  /** similarity (0..1) a heard word must reach to count as the wake word */
  minScore: number;
  /** most head transcriptions per minute */
  perMinute: number;
}

export const WAKE_TUNING: Record<WakeSensitivity, WakeTuning> = {
  low: { vadThreshold: 0.026, minScore: 0.8, perMinute: 8 },
  medium: { vadThreshold: 0.018, minScore: 0.7, perMinute: 12 },
  high: { vadThreshold: 0.012, minScore: 0.6, perMinute: 20 },
};

/** how much of each speech segment is transcribed to look for the wake word */
export const WAKE_HEAD_MS = 2400;
/** after a bare "hey clickity", the next utterance within this long is the question */
export const WAKE_FOLLOW_MS = 7000;

/** the generic wake words (any clicky answers to these: the active one) */
export const WAKE_WORDS = ['clickity'];
const GREETINGS = new Set(['hey', 'hi', 'hello', 'ok', 'okay', 'yo', 'oi', 'hiya', 'heya', 'ey', 'a', 'eh', 'hay']);
const FILLERS = new Set(['um', 'uh', 'er', 'erm', 'hmm', 'so', 'and', 'oh', 'well', 'like']);

/** "Clickity," → "clickity"; "clickity's" → "clickitys" (letters and digits only) */
export function normWord(w: string): string {
  return w
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

/** A rough sound-alike key: clickity / clickety / klikiti / clikkety → "klikiti". */
export function soundKey(w: string): string {
  return normWord(w)
    .replace(/ph/g, 'f')
    .replace(/ck|c|q/g, 'k')
    .replace(/x/g, 'ks')
    .replace(/[eyi]/g, 'i')
    .replace(/(.)\1+/g, '$1');
}

/** Levenshtein distance (small strings only). */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)));
    prev = cur;
  }
  return prev[b.length];
}

/** 0..1: how alike two words sound (the better of spelling and the sound-alike key). */
export function similarity(heard: string, target: string): number {
  const sim = (x: string, y: string) => (x && y ? 1 - editDistance(x, y) / Math.max(x.length, y.length) : 0);
  return Math.max(sim(normWord(heard), normWord(target)), sim(soundKey(heard), soundKey(target)));
}

export interface WakeTarget {
  /** the clicky this name belongs to (undefined = the generic "clickity": whoever is active) */
  id?: string;
  name: string;
}

export interface WakeMatch {
  /** what came after the wake word, as heard ("what's this button?"); '' = nothing yet */
  rest: string;
  score: number;
  /** the target that matched */
  target: WakeTarget;
  /** a greeting ("hey", "ok") came first */
  greeted: boolean;
}

/**
 * Was this transcript addressed to clickity? The wake word has to come first (after an optional
 * greeting / filler): "hey clickity, what's this", "clickity what time is it", "ok study buddy".
 * Fuzzy: whisper writes the name many ways ("clicky", "clickety", "click it e"). Without a
 * greeting the bar is higher, so "click it and save" doesn't wake it.
 */
export function matchWake(text: string, targets: readonly WakeTarget[], sensitivity: WakeSensitivity = 'medium'): WakeMatch | null {
  const raw = String(text ?? '').trim().split(/\s+/).filter(Boolean);
  const words: Array<{ n: string; i: number }> = [];
  raw.forEach((w, i) => {
    const n = normWord(w);
    if (n) words.push({ n, i });
  });
  if (!words.length) return null;
  const minScore = WAKE_TUNING[sensitivity]?.minScore ?? WAKE_TUNING.medium.minScore;
  const all: WakeTarget[] = [...WAKE_WORDS.map((name) => ({ name })), ...targets.filter((t) => normWord(t.name))];
  let best: (WakeMatch & { end: number }) | null = null;
  // skip up to three leading greeting / filler words ("um hey clickity")
  for (let start = 0; start < Math.min(words.length, 4); start++) {
    const lead = words.slice(0, start).map((w) => w.n);
    if (lead.some((w) => !GREETINGS.has(w) && !FILLERS.has(w))) break;
    const greeted = lead.some((w) => GREETINGS.has(w));
    for (let len = 1; len <= 3 && start + len <= words.length; len++) {
      const joined = words.slice(start, start + len).map((w) => w.n).join('');
      for (const t of all) {
        const name = normWord(t.name);
        if (name.length < 3) continue;
        // a name split over words ("click it e", "study buddy") is only trusted after a greeting
        // or when it is the clicky's own multi-word name
        const multiWordName = t.name.trim().split(/\s+/).length > 1;
        if (len > 1 && !greeted && !multiWordName) continue;
        let score = similarity(joined, name);
        // a short name ("bob") must be said exactly, and after a greeting
        if (name.length < 5 && (score < 1 || !greeted)) continue;
        if (greeted) score = Math.min(1, score + 0.08);
        const need = greeted ? minScore : Math.max(minScore + 0.12, 0.84);
        if (score < need) continue;
        if (!best || score > best.score + 1e-9) {
          best = { score, target: t, greeted, rest: '', end: words[start + len - 1].i + 1 };
        }
      }
    }
  }
  if (!best) return null;
  const rest = raw
    .slice(best.end)
    .join(' ')
    .replace(/^[\s,.;:!?…\-–—]+/, '')
    .trim();
  return { rest: isOnlyFiller(rest) ? '' : rest, score: Math.round(best.score * 1000) / 1000, target: best.target, greeted: best.greeted };
}

/** "um.", "uh, okay" → nothing worth sending as a question */
export function isOnlyFiller(text: string): boolean {
  const ws = text.split(/\s+/).map(normWord).filter(Boolean);
  return !ws.length || ws.every((w) => FILLERS.has(w) || GREETINGS.has(w) || w === 'please');
}

/** The names to listen for: every clicky (so "hey study buddy" switches to it), plus "clickity". */
export function wakeTargets(clickys: ReadonlyArray<{ id: string; name: string }>): WakeTarget[] {
  return clickys.filter((c) => normWord(c.name) && !WAKE_WORDS.includes(normWord(c.name))).map((c) => ({ id: c.id, name: c.name }));
}

/* ───────────── rate cap ───────────── */

export interface WakeGateOptions {
  /** shorter segments are a click / cough, not a name */
  minMs: number;
  /** longer segments are skipped (someone talking for a while, a video) */
  maxMs: number;
  perMinute: number;
  /** quiet time between two checks */
  minGapMs: number;
}

export const DEFAULT_WAKE_GATE: WakeGateOptions = { minMs: 350, maxMs: 20_000, perMinute: 12, minGapMs: 1200 };

export type GateVerdict = { ok: true } | { ok: false; reason: 'too-short' | 'too-long' | 'busy' | 'rate' | 'gap' };

/**
 * Decides whether a speech segment gets transcribed. One check at a time, a minimum gap, and at
 * most `perMinute` in any rolling minute: a TV in the background costs at most that many short
 * transcriptions a minute.
 */
export class WakeGate {
  private opts: WakeGateOptions;
  private recent: number[] = [];
  private lastAt = -Infinity;
  private inFlight = false;
  skipped = 0;
  checked = 0;

  constructor(opts: Partial<WakeGateOptions> = {}) {
    this.opts = { ...DEFAULT_WAKE_GATE, ...opts };
  }

  set(opts: Partial<WakeGateOptions>): void {
    this.opts = { ...this.opts, ...opts };
  }

  admit(durationMs: number, now: number): GateVerdict {
    const o = this.opts;
    let v: GateVerdict = { ok: true };
    this.recent = this.recent.filter((t) => now - t < 60_000);
    if (durationMs < o.minMs) v = { ok: false, reason: 'too-short' };
    else if (durationMs > o.maxMs) v = { ok: false, reason: 'too-long' };
    else if (this.inFlight) v = { ok: false, reason: 'busy' };
    else if (now - this.lastAt < o.minGapMs) v = { ok: false, reason: 'gap' };
    else if (this.recent.length >= o.perMinute) v = { ok: false, reason: 'rate' };
    if (!v.ok) {
      if (v.reason !== 'too-short') this.skipped++;
      return v;
    }
    this.recent.push(now);
    this.lastAt = now;
    this.inFlight = true;
    this.checked++;
    return v;
  }

  /** the admitted check finished */
  done(now: number): void {
    this.inFlight = false;
    this.lastAt = now;
  }

  /** checks in the last minute */
  load(now: number): number {
    return this.recent.filter((t) => now - t < 60_000).length;
  }
}
