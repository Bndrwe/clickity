// Push-to-talk chord state machine. Pure (no electron / native imports) so it can be unit
// tested with `node --experimental-strip-types --test`; hotkey.ts feeds it native key events.
import type { HotkeySettings, KeyName } from '../shared/types';

const SUBSET_DELAY_MS = 120;
const MAX_HOLD_MS = 5 * 60 * 1000;
/** double / triple tap: max gap between one tap's release and the next press */
export const TAP_GAP_MS = 300;
/** a tap is a press shorter than this with no other key */
export const TAP_HOLD_MS = 250;

/** Tap bindings are stored as ['DoubleTap', key] / ['TripleTap', key] in place of a chord. */
export const TAP_PREFIX: Record<string, 2 | 3> = { DoubleTap: 2, TripleTap: 3 };

/** A binding's tap form ({ key, count }) or null when it is an ordinary chord. */
export function tapOf(binding: readonly string[] | undefined): { key: string; count: 2 | 3 } | null {
  if (!binding || binding.length !== 2) return null;
  const count = TAP_PREFIX[binding[0]];
  return count ? { key: binding[1], count } : null;
}

export interface HotkeyHandlers {
  onTalkDown(): void;
  onTalkUp(): void;
  onType(): void;
  onEscape(): void;
  /**
   * Enter / numpad enter pressed on its own. Agent mode uses it to approve pending actions; the
   * handler ignores it unless a confirmation is waiting.
   */
  onEnter?(): void;
  /**
   * Another key was pressed while the talk chord was still held right after it fired: the chord
   * was part of a different shortcut (AltGr = Ctrl+Alt on Windows layouts when typing @ € { },
   * Ctrl+Alt+T / Ctrl+Alt+arrows on Linux desktops…). Drop the recording quietly instead of sending it.
   * Falls back to onEscape when not given.
   */
  onTalkCancel?(): void;
  /**
   * Whether a talk (recording) is really in progress. Lets toggle mode resync when the turn was
   * ended elsewhere (escape, tap error, mic blocked…), so the next press starts again instead of
   * sending a dead "stop". When absent, the engine's own toggle state is trusted.
   */
  isTalking?(): boolean;
  /** dictation chord pressed (draft = alt / option held with it) */
  onDictateDown?(draft: boolean): void;
  /** alt / option joined a dictation in progress: it becomes a draft */
  onDictateDraft?(): void;
  /** dictation chord released: transcribe and insert */
  onDictateUp?(draft: boolean): void;
  /** dictation interrupted by another key / reset: discard */
  onDictateCancel?(): void;
  /** the "type" tap binding (default: double-tap control) */
  onTypeTap?(): void;
  /** the hands-free toggle binding (default: triple-tap control) */
  onAlwaysOn?(): void;
}

/** The engine's view of HotkeySettings: the extra bindings are optional (older configs, tests). */
type EngineConfig = Pick<HotkeySettings, 'talk' | 'type' | 'mode'> & Partial<Pick<HotkeySettings, 'dictate' | 'typeTap' | 'alwaysOn'>>;


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
  /** the chord press that started the current talk is still held (no chord key released yet) */
  private chordHeld = false;
  private pending: ReturnType<typeof setTimeout> | null = null;
  private holdWatchdog: ReturnType<typeof setTimeout> | null = null;
  private suspended = false;
  /** dictation chord (empty = off) and its live state */
  private dictate = new Set<string>();
  private dictActive = false;
  private dictDraft = false;
  /** chord forms of the typeTap / alwaysOn bindings (when they aren't taps) */
  private typeChord2 = new Set<string>();
  private alwaysOnChord = new Set<string>();
  /** tap bindings: key → count → handler */
  private taps = new Map<string, Map<number, () => void>>();
  /** the press that may become a tap */
  private tapDown: { key: string; at: number } | null = null;
  /** consecutive taps so far */
  private tapSeq: { key: string; count: number; lastUp: number } | null = null;
  private tapTimer: ReturnType<typeof setTimeout> | null = null;

  private handlers: HotkeyHandlers;
  private delayMs: number;
  private tapGapMs: number;
  private now: () => number;

  // (no parameter properties: this file must run under node --experimental-strip-types)
  constructor(handlers: HotkeyHandlers, cfg: EngineConfig, delayMs = SUBSET_DELAY_MS, opts: { tapGapMs?: number; now?: () => number } = {}) {
    this.handlers = handlers;
    this.delayMs = delayMs;
    this.tapGapMs = opts.tapGapMs ?? TAP_GAP_MS;
    this.now = opts.now ?? Date.now;
    this.configure(cfg);
  }

  configure(cfg: EngineConfig): void {
    this.talk = new Set(cfg.talk);
    this.type = new Set(cfg.type);
    this.mode = cfg.mode;
    this.dictate = new Set(cfg.dictate ?? []);
    this.taps.clear();
    this.typeChord2.clear();
    this.alwaysOnChord.clear();
    const bind = (binding: string[] | undefined, chord: Set<string>, fire: () => void): void => {
      if (!binding?.length) return;
      const tap = tapOf(binding);
      if (!tap) {
        for (const k of binding) chord.add(k);
        return;
      }
      const byCount = this.taps.get(tap.key) ?? new Map<number, () => void>();
      byCount.set(tap.count, fire);
      this.taps.set(tap.key, byCount);
    };
    bind(cfg.typeTap, this.typeChord2, () => this.safe(() => (this.handlers.onTypeTap ?? this.handlers.onType)()));
    bind(cfg.alwaysOn, this.alwaysOnChord, () => this.safe(() => this.handlers.onAlwaysOn?.()));
    this.reset();
  }

  /** Keys currently held (dictation waits for every key to be up before it types). */
  heldCount(): number {
    return this.held.size;
  }

  setSuspended(s: boolean): void {
    this.suspended = s;
    this.reset();
  }

  /** Clear all held state; releases an active talk. */
  reset(): void {
    this.clearPending();
    this.clearTaps();
    this.held.clear();
    if (this.dictActive) this.cancelDictation();
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
    const wasEmpty = this.held.size === 0;
    this.held.add(key);
    this.trackTapDown(key, wasEmpty);
    // dictation owns the keyboard while its chord is held
    if (this.dictActive) {
      if (key === 'Alt' && !this.dictate.has('Alt')) {
        if (!this.dictDraft) {
          this.dictDraft = true;
          this.safe(() => this.handlers.onDictateDraft?.());
        }
      } else if (!this.dictate.has(key)) this.cancelDictation();
      return;
    }
    if (this.dictate.size && isSuperset(this.held, this.dictate) && [...this.held].every((k) => this.dictate.has(k) || k === 'Alt')) {
      this.clearPending();
      if (this.talkActive) this.cancelTalk();
      this.dictActive = true;
      this.dictDraft = this.held.has('Alt') && !this.dictate.has('Alt');
      const draft = this.dictDraft;
      this.safe(() => this.handlers.onDictateDown?.(draft));
      return;
    }
    // A key outside the talk chord while that chord is still held from the press that started
    // talking: it was another shortcut (AltGr+Q = Ctrl+Alt+Q → "@" on German layouts). Cancel.
    if (this.talkActive && this.chordHeld && !this.talk.has(key) && !(this.type.size && sameSet(this.held, this.type))) {
      this.cancelTalk();
      return;
    }
    if (key === 'Escape' && this.held.size === 1) {
      this.safe(() => this.handlers.onEscape());
      return;
    }
    if ((key === 'Enter' || key === 'NumpadEnter') && this.held.size === 1 && this.handlers.onEnter) {
      this.safe(() => this.handlers.onEnter!());
      return;
    }
    if (this.alwaysOnChord.size && sameSet(this.held, this.alwaysOnChord)) {
      this.clearPending();
      this.safe(() => this.handlers.onAlwaysOn?.());
      return;
    }
    if (this.typeChord2.size && sameSet(this.held, this.typeChord2) && !sameSet(this.typeChord2, this.talk)) {
      this.clearPending();
      if (this.talkActive) this.cancelTalk();
      this.safe(() => (this.handlers.onTypeTap ?? this.handlers.onType)());
      return;
    }
    if (this.type.size && sameSet(this.held, this.type) && !sameSet(this.type, this.talk)) {
      this.clearPending();
      // talk ⊂ type and talk already fired: drop that recording quietly (no "didn't catch that")
      if (this.talkActive) this.cancelTalk();
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
    this.trackTapUp(key);
    this.afterRelease();
  }

  /**
   * Drop a key from the held set without treating it as a release (it was never really pressed:
   * Windows' synthetic LeftControl that comes with AltGr). Cancels a talk it helped start.
   */
  forgetKey(key: KeyName): void {
    if (!this.held.delete(key)) return;
    if (this.pending && !sameSet(this.held, this.talk)) this.clearPending();
    if (this.talkActive && this.chordHeld && this.talk.has(key)) this.cancelTalk();
  }

  /**
   * A key the keycode map doesn't know (layout-specific keys such as the ISO <> key) went down.
   * It isn't tracked as held, but it still means the talk chord was part of another shortcut.
   */
  foreignKeyDown(): void {
    if (this.suspended) return;
    if (this.talkActive && this.chordHeld) this.cancelTalk();
  }

  dispose(): void {
    this.clearPending();
    this.clearTaps();
    if (this.holdWatchdog) clearTimeout(this.holdWatchdog);
    this.holdWatchdog = null;
  }

  private afterRelease(): void {
    if (this.dictActive && !isSuperset(this.held, this.dictate)) {
      this.dictActive = false;
      const draft = this.dictDraft;
      this.dictDraft = false;
      this.safe(() => this.handlers.onDictateUp?.(draft));
    }
    if (!isSuperset(this.held, this.talk)) this.chordHeld = false;
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
        // resync with reality: a turn cancelled elsewhere must not need an extra press
        if (this.talkActive && this.isTalking()) this.endTalk();
        else this.startTalk();
      } else this.startTalk();
    };
    this.clearPending();
    if (delayed) this.pending = setTimeout(fire, this.delayMs);
    else fire();
  }

  private isTalking(): boolean {
    try {
      return this.handlers.isTalking?.() ?? true;
    } catch {
      return true;
    }
  }

  private cancelTalk(): void {
    this.talkActive = false;
    this.chordHeld = false;
    if (this.holdWatchdog) clearTimeout(this.holdWatchdog);
    this.holdWatchdog = null;
    this.safe(() => (this.handlers.onTalkCancel ? this.handlers.onTalkCancel() : this.handlers.onEscape()));
  }

  private startTalk(): void {
    this.talkActive = true;
    this.chordHeld = true;
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
    this.chordHeld = false;
    if (this.holdWatchdog) clearTimeout(this.holdWatchdog);
    this.holdWatchdog = null;
    this.safe(() => this.handlers.onTalkUp());
  }

  private cancelDictation(): void {
    if (!this.dictActive) return;
    this.dictActive = false;
    this.dictDraft = false;
    this.safe(() => this.handlers.onDictateCancel?.());
  }

  /* ── taps: a press + release of one key, nothing else held, repeated within TAP_GAP_MS ── */

  private trackTapDown(key: string, wasEmpty: boolean): void {
    if (!this.taps.size) return;
    if (!wasEmpty || !this.taps.has(key)) {
      // another key: no tap in progress, and a waiting double-tap is off (it was a shortcut)
      this.tapDown = null;
      this.clearTaps();
      return;
    }
    if (this.tapSeq && (this.tapSeq.key !== key || this.now() - this.tapSeq.lastUp > this.tapGapMs)) this.clearTaps();
    if (this.tapTimer) {
      clearTimeout(this.tapTimer); // a further tap may follow: decide on release
      this.tapTimer = null;
    }
    this.tapDown = { key, at: this.now() };
  }

  private trackTapUp(key: string): void {
    const down = this.tapDown;
    this.tapDown = null;
    if (!down || down.key !== key || this.held.size !== 0) return;
    const now = this.now();
    if (now - down.at > TAP_HOLD_MS) {
      this.clearTaps();
      return;
    }
    const seq = this.tapSeq && this.tapSeq.key === key ? this.tapSeq : { key, count: 0, lastUp: 0 };
    seq.count++;
    seq.lastUp = now;
    this.tapSeq = seq;
    const byCount = this.taps.get(key);
    if (!byCount) return;
    const max = Math.max(...byCount.keys());
    const fire = byCount.get(seq.count);
    if (seq.count >= max) {
      this.clearTaps();
      fire?.();
      return;
    }
    // a longer tap sequence is also bound: wait to see whether another tap comes
    if (fire) {
      this.tapTimer = setTimeout(() => {
        this.tapTimer = null;
        if (this.tapSeq !== seq || this.held.size) return;
        this.tapSeq = null;
        if (!this.suspended) fire();
      }, this.tapGapMs);
      this.tapTimer.unref?.();
    }
  }

  private clearTaps(): void {
    if (this.tapTimer) clearTimeout(this.tapTimer);
    this.tapTimer = null;
    this.tapSeq = null;
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


/** Max gap between Windows' synthetic LeftControl and AltRight that together mean AltGr. */
const ALTGR_MAX_GAP_MS = 2;

/**
 * Windows reports AltGr (European layouts: @ € { } …) as a synthetic LeftControl keydown followed
 * by AltRight with the same timestamp, which would look exactly like the default ctrl + alt talk
 * chord. Feed raw uiohook keycodes + times through this; 'altgr' means "retract the Control you
 * just passed on and drop this event". Physical left ctrl + left alt is unaffected (different
 * keycode), and a physical ctrl + right alt is pressed far more than 2ms apart.
 */
export class AltGrFilter {
  private ctrlCode: number;
  private altRightCode: number;
  private lastCtrlTime: number | null = null;
  private altGrHeld = false;
  private swallowCtrlUp = false;

  constructor(ctrlCode: number, altRightCode: number) {
    this.ctrlCode = ctrlCode;
    this.altRightCode = altRightCode;
  }

  keyDown(code: number, time: number): 'pass' | 'drop' | 'altgr' {
    if (code === this.ctrlCode) {
      if (this.altGrHeld) return 'drop'; // autorepeat of the synthetic control
      this.lastCtrlTime = time;
      return 'pass';
    }
    if (code === this.altRightCode) {
      if (this.altGrHeld) return 'drop'; // autorepeat
      if (this.lastCtrlTime !== null && Math.abs(time - this.lastCtrlTime) <= ALTGR_MAX_GAP_MS) {
        this.lastCtrlTime = null;
        this.altGrHeld = true;
        this.swallowCtrlUp = true;
        return 'altgr';
      }
      return 'pass';
    }
    this.lastCtrlTime = null;
    return 'pass';
  }

  keyUp(code: number): 'pass' | 'drop' {
    if (code === this.altRightCode && this.altGrHeld) {
      this.altGrHeld = false;
      return 'drop';
    }
    if (code === this.ctrlCode) {
      this.lastCtrlTime = null;
      if (this.swallowCtrlUp) {
        this.swallowCtrlUp = false;
        return 'drop';
      }
    }
    return 'pass';
  }
}
