// Push-to-talk chord state machine. Pure (no electron / native imports) so it can be unit
// tested with `node --experimental-strip-types --test`; hotkey.ts feeds it native key events.
import type { HotkeySettings, KeyName } from '../shared/types';

const SUBSET_DELAY_MS = 120;
const MAX_HOLD_MS = 5 * 60 * 1000;

export interface HotkeyHandlers {
  onTalkDown(): void;
  onTalkUp(): void;
  onType(): void;
  onEscape(): void;
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
}


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

  private handlers: HotkeyHandlers;
  private delayMs: number;

  // (no parameter properties: this file must run under node --experimental-strip-types)
  constructor(handlers: HotkeyHandlers, cfg: HotkeySettings, delayMs = SUBSET_DELAY_MS) {
    this.handlers = handlers;
    this.delayMs = delayMs;
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
    this.afterRelease();
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
    if (this.holdWatchdog) clearTimeout(this.holdWatchdog);
    this.holdWatchdog = null;
  }

  private afterRelease(): void {
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

