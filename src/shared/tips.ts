// Proactive tips: the pure decision and throttling logic (unit tested, test/tips.test.ts).
// main/tips.ts runs the loop: every ~45–90 s while the user is active it takes a cheap look
// (focused app + window title, optionally a small screenshot to the cheapest model) and may
// offer one tip: a dot on the companion, never spoken, opened by a key or a click.

export interface TipsPolicyOptions {
  /** random wait between two looks */
  minLookMs: number;
  maxLookMs: number;
  /** most tips offered in any rolling hour */
  perHour: number;
  /** quiet time after a tip was offered */
  minGapMs: number;
  /** after "not now": no tips for this long */
  snoozeMs: number;
  /** most model calls in any rolling hour (the look itself is free) */
  modelPerHour: number;
  /** the user counts as active when the last input was this recent */
  activeIdleSec: number;
  /** the same tip (or one for the same app + title) is not offered again within this */
  repeatMs: number;
  /** a pending dot disappears after this */
  pendingMs: number;
}

export const DEFAULT_TIPS_POLICY: TipsPolicyOptions = {
  minLookMs: 45_000,
  maxLookMs: 90_000,
  perHour: 3,
  minGapMs: 10 * 60_000,
  snoozeMs: 30 * 60_000,
  modelPerHour: 12,
  activeIdleSec: 60,
  repeatMs: 24 * 3600_000,
  pendingMs: 3 * 60_000,
};

/** What a look sees. Titles stay in memory; the log only gets app names and signal names. */
export interface TipContext {
  app: string;
  title: string;
}

export interface LookConditions {
  /** seconds since the last keyboard / mouse input */
  idleSec: number;
  /** clickity is listening / thinking / speaking / acting / a choice or dictation is pending */
  busy: boolean;
  /** a tip dot is already waiting */
  pending: boolean;
}

export type Signal = 'error-on-screen' | 'repeating' | 'new-window';

export type LookDecision = { look: true } | { look: false; reason: 'not-yet' | 'idle' | 'busy' | 'pending' | 'snoozed' | 'rate' | 'gap' };

export type AssessDecision =
  | { ask: true; signals: Signal[] }
  | { ask: false; reason: 'call' | 'video' | 'clickity' | 'private' | 'nothing-new' | 'model-budget' | 'unknown-app' };

export type OfferDecision = { offer: true } | { offer: false; reason: 'empty' | 'rate' | 'gap' | 'repeat' | 'snoozed' };

const CALL = /\b(zoom( meeting| workplace)?|zoom\.us|microsoft teams|teams meeting|google meet|meet\.google|meet - |facetime|webex|skype|slack huddle|huddle|discord|whereby|around|gotomeeting|jitsi|signal call|whatsapp call|on a call|call with)\b/i;
const CALL_APPS = /^(zoom|zoom\.us|teams|ms-teams|facetime|webex|skype|discord|whereby)$/i;
const VIDEO = /\b(youtube|netflix|prime video|disney\+|hulu|twitch|vimeo|plex|max|apple tv|mubi|crunchyroll|picture[- ]in[- ]picture|full ?screen)\b/i;
const VIDEO_APPS = /^(vlc|mpv|iina|quicktime player|tv|totem|celluloid|mplayer|smplayer|kodi|plex|netflix|infuse|movies & tv|media player)$/i;
const ERROR = /\b(error|failed|failure|exception|crash(ed)?|not responding|fatal|cannot|can't|couldn't|unable to|denied|problem|warning|traceback|segmentation fault|404|500|timed out)\b/i;
const SELF = /^(clickity|electron)$/i;

/** In a call or watching something: never look, never offer. */
export function quietReason(c: TipContext): 'call' | 'video' | null {
  const app = c.app.trim();
  if (CALL_APPS.test(app) || CALL.test(c.title)) return 'call';
  if (VIDEO_APPS.test(app) || VIDEO.test(c.title)) return 'video';
  return null;
}

/** The focused app is on the user's never-screenshot / private list (another module owns that list). */
export function isPrivateApp(app: string, privacy: unknown): boolean {
  const names = privateAppNames(privacy);
  if (!names.length || !app) return false;
  const a = app.toLowerCase();
  return names.some((n) => a === n || a.includes(n) || n.includes(a));
}

/** Defensive read of a `settings.privacy` field we don't own: any string list of app names in it. */
export function privateAppNames(privacy: unknown): string[] {
  if (!privacy || typeof privacy !== 'object') return [];
  const out: string[] = [];
  for (const v of Object.values(privacy as Record<string, unknown>)) {
    if (!Array.isArray(v)) continue;
    for (const x of v) {
      const name = typeof x === 'string' ? x : x && typeof x === 'object' ? (x as Record<string, unknown>).name ?? (x as Record<string, unknown>).app : '';
      if (typeof name === 'string' && name.trim()) out.push(name.trim().toLowerCase());
    }
  }
  return out;
}

/** Privacy says "never send screenshots at all" (any boolean that reads like it). */
export function privacyBlocksScreens(privacy: unknown): boolean {
  if (!privacy || typeof privacy !== 'object') return false;
  const p = privacy as Record<string, unknown>;
  return p.screenshots === false || p.neverScreenshot === true || p.noScreenshots === true;
}

/** The model's answer: {"tip": "…"} or {"tip": null} (possibly in prose / a code fence). */
export function parseTipReply(raw: string): string | null {
  const s = String(raw ?? '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const data = JSON.parse(s.slice(start, end + 1)) as { tip?: unknown };
    if (typeof data.tip !== 'string') return null;
    const tip = data.tip.replace(/\s+/g, ' ').trim();
    if (tip.length < 12 || /^(none|null|no tip|n\/a)\.?$/i.test(tip)) return null;
    return tip.length > 240 ? `${tip.slice(0, 239).trimEnd()}…` : tip;
  } catch {
    return null;
  }
}

/** A stable short key for "the same tip" (case, punctuation and spacing ignored). */
export function tipKey(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 80);
}

/**
 * The throttle: when to look, whether a look is worth a model call, whether a tip may be offered.
 * Clock-injected (every method takes `now`), random-injected (the look interval).
 */
export class TipsPolicy {
  opts: TipsPolicyOptions;
  private rand: () => number;
  private nextLookAt: number;
  private offered: number[] = [];
  private modelCalls: number[] = [];
  private snoozedUntil = 0;
  private lastOfferAt = -Infinity;
  private seen = new Map<string, number>();
  private lastCtx = '';
  private focus: Array<{ key: string; at: number }> = [];

  constructor(now: number, opts: Partial<TipsPolicyOptions> = {}, rand: () => number = Math.random) {
    this.opts = { ...DEFAULT_TIPS_POLICY, ...opts };
    this.rand = rand;
    this.nextLookAt = now + this.interval();
  }

  private interval(): number {
    const { minLookMs, maxLookMs } = this.opts;
    return Math.round(minLookMs + (maxLookMs - minLookMs) * Math.min(1, Math.max(0, this.rand())));
  }

  private prune(now: number): void {
    this.offered = this.offered.filter((t) => now - t < 3600_000);
    this.modelCalls = this.modelCalls.filter((t) => now - t < 3600_000);
    for (const [k, t] of this.seen) if (now - t > this.opts.repeatMs) this.seen.delete(k);
    this.focus = this.focus.filter((f) => now - f.at < 10 * 60_000);
  }

  /** Is it time for a look? A "no" for busy / idle keeps the slot, so it looks soon after. */
  shouldLook(now: number, c: LookConditions): LookDecision {
    this.prune(now);
    if (now < this.nextLookAt) return { look: false, reason: 'not-yet' };
    const no = (reason: Exclude<LookDecision, { look: true }>['reason'], wait = 10_000): LookDecision => {
      this.nextLookAt = now + wait;
      return { look: false, reason };
    };
    if (now < this.snoozedUntil) return no('snoozed', Math.min(this.snoozedUntil - now, this.interval()));
    if (c.pending) return no('pending', this.interval());
    if (c.busy) return no('busy');
    if (c.idleSec > this.opts.activeIdleSec) return no('idle', 15_000);
    if (this.offered.length >= this.opts.perHour) return no('rate', this.interval());
    if (now - this.lastOfferAt < this.opts.minGapMs) return no('gap', this.interval());
    this.nextLookAt = now + this.interval();
    return { look: true };
  }

  /** Remember where the user is (every look), for the "switching back and forth" signal. */
  noteFocus(c: TipContext, now: number): void {
    const key = `${c.app}|${c.title}`;
    const last = this.focus[this.focus.length - 1];
    if (!last || last.key !== key) this.focus.push({ key, at: now });
  }

  /** The user went back and forth between the same two windows several times in 10 minutes. */
  repeating(now: number): boolean {
    this.prune(now);
    if (this.focus.length < 6) return false;
    const recent = this.focus.slice(-6).map((f) => f.key);
    return new Set(recent).size === 2;
  }

  /** Is this look worth a (cheap) model call? */
  assess(c: TipContext, now: number, privacy?: unknown): AssessDecision {
    this.prune(now);
    if (SELF.test(c.app.trim())) return { ask: false, reason: 'clickity' };
    const quiet = quietReason(c);
    if (quiet) return { ask: false, reason: quiet };
    if (isPrivateApp(c.app, privacy)) return { ask: false, reason: 'private' };
    if (!c.app && !c.title) return { ask: false, reason: 'unknown-app' };
    this.noteFocus(c, now);
    const key = `${c.app}|${c.title}`;
    const signals: Signal[] = [];
    if (ERROR.test(c.title)) signals.push('error-on-screen');
    if (this.repeating(now)) signals.push('repeating');
    if (key !== this.lastCtx) signals.push('new-window');
    this.lastCtx = key;
    // same window as last time and nothing alarming: nothing new to say
    if (!signals.length) return { ask: false, reason: 'nothing-new' };
    if (this.seen.has(`ctx:${key}`) && !signals.includes('repeating')) return { ask: false, reason: 'nothing-new' };
    if (this.modelCalls.length >= this.opts.modelPerHour) return { ask: false, reason: 'model-budget' };
    this.modelCalls.push(now);
    return { ask: true, signals };
  }

  /** The model came back with `tip` for `c`: may we offer it now? */
  offer(tip: string | null, c: TipContext, now: number): OfferDecision {
    this.prune(now);
    if (!tip) {
      this.seen.set(`ctx:${c.app}|${c.title}`, now); // asked about this window already: don't ask again
      return { offer: false, reason: 'empty' };
    }
    if (now < this.snoozedUntil) return { offer: false, reason: 'snoozed' };
    if (this.offered.length >= this.opts.perHour) return { offer: false, reason: 'rate' };
    if (now - this.lastOfferAt < this.opts.minGapMs) return { offer: false, reason: 'gap' };
    const k = `tip:${tipKey(tip)}`;
    if (this.seen.has(k)) return { offer: false, reason: 'repeat' };
    this.seen.set(k, now);
    this.seen.set(`ctx:${c.app}|${c.title}`, now);
    this.offered.push(now);
    this.lastOfferAt = now;
    return { offer: true };
  }

  /** "not now": quiet for a while */
  snooze(now: number): void {
    this.snoozedUntil = now + this.opts.snoozeMs;
  }

  /** tips offered in the last hour */
  offeredLastHour(now: number): number {
    this.prune(now);
    return this.offered.length;
  }

  /** look at the next chance (tests; settings turning tips on) — every other rule still applies */
  lookSoon(now: number): void {
    this.nextLookAt = now;
  }

  /** when the next look is due (ms epoch) */
  nextLook(): number {
    return this.nextLookAt;
  }
}
