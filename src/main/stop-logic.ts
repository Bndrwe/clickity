// Stop / pause: what the stop key (default esc) does in each state, the hint the bubble shows,
// agent-run pause bookkeeping, double-delivery dedupe and stop-key validation. Pure (no electron
// / native imports) so it is unit tested with `node --experimental-strip-types --test`
// (test/stop.test.ts); conversation.ts, hotkey.ts and settings-validate.ts use it.
import type { KeyName } from '../shared/types';

/** 'stop' = the key stops; 'pause' = it pauses an agent run; 'paused' = an agent run waits for enter. */
export type BusyMode = 'stop' | 'pause' | 'paused';

/** An agent run, as the stop key sees it. */
export interface AgentSnap {
  /** the act → look → continue loop is running (its final words no longer count) */
  running: boolean;
  /** stop key pressed: pausing at the next safe point */
  pausing: boolean;
  /** paused: waiting for enter / continue */
  paused: boolean;
  /** waiting for approval (enter / esc): esc there means "no", handled by the confirm */
  confirming: boolean;
  /** automatic mode's "starting in 3… esc to cancel" */
  countdown: boolean;
}

export interface BusySnapshot {
  /** the current turn (null = none) */
  turn: null | {
    /** 'window' = typed in the chats window / notch (has its own stop button) */
    kind: 'voice' | 'type' | 'window' | 'test';
    agent: AgentSnap | null;
  };
  /** a dictation records / transcribes, or a draft streams / waits in the preview */
  dictation: boolean;
}

/**
 * Whether clickity is busy, what the stop key would do, and whether the global key applies
 * (`global`: grab the stop key). Chats-window replies are busy (the chats window / notch / tray
 * show stop) but not global: pressing esc in another app must not kill them. An agent run acting
 * on the screen is always global.
 */
export function busyState(s: BusySnapshot): { mode: BusyMode; global: boolean } | null {
  const t = s.turn;
  if (t) {
    const a = t.agent?.running ? t.agent : null;
    const global = t.kind !== 'window' || !!a;
    if (a) {
      if (a.paused) return { mode: 'paused', global };
      if (a.confirming || a.countdown) return { mode: 'stop', global };
      return { mode: 'pause', global };
    }
    return { mode: 'stop', global };
  }
  if (s.dictation) return { mode: 'stop', global: true };
  return null;
}

/**
 * What one stop request does. `how`: 'key' = the stop key or the bubble's stop button (pauses an
 * agent run first); 'stop' = an explicit stop (chats / notch / tray stop): never just pauses.
 */
export type StopStep = 'none' | 'dictation' | 'pause-agent' | 'stop-agent' | 'cancel-turn';

export function stopStep(s: BusySnapshot, how: 'key' | 'stop'): StopStep {
  const t = s.turn;
  if (t) {
    const a = t.agent?.running ? t.agent : null;
    if (a) {
      if (how === 'stop' || a.paused || a.pausing || a.countdown) return 'stop-agent';
      if (a.confirming) return 'stop-agent'; // the confirm normally takes esc first ("not done: cancelled")
      return 'pause-agent';
    }
    // the global key leaves chats-window replies alone (they have a stop button)
    if (t.kind === 'window' && how === 'key') return s.dictation ? 'dictation' : 'none';
    return 'cancel-turn';
  }
  return s.dictation ? 'dictation' : 'none';
}

/** The quiet line under the bubble: "esc to stop" / "esc to pause" / "paused · enter to continue · esc to stop". */
export function stopHint(mode: BusyMode, key: string): string {
  if (mode === 'paused') return `paused · enter / ${key}`;
  return `${key} to ${mode === 'pause' ? 'pause' : 'stop'}`;
}

/**
 * Agent-run pause bookkeeping: the first request pauses (at the next safe point: after the
 * current input action, or by aborting the model call), the second stops.
 */
export class PauseControl {
  state: 'running' | 'pausing' | 'paused' = 'running';

  /** the stop key: 'pause' (first press) or 'stop' (already pausing / paused) */
  request(): 'pause' | 'stop' {
    if (this.state === 'running') {
      this.state = 'pausing';
      return 'pause';
    }
    return 'stop';
  }

  /** at a safe point: true when a pause was requested (the run is now paused) */
  reached(): boolean {
    if (this.state !== 'pausing') return false;
    this.state = 'paused';
    return true;
  }

  /** enter / continue: back to running (false when it wasn't paused) */
  resume(): boolean {
    if (this.state === 'running') return false;
    this.state = 'running';
    return true;
  }

  get pending(): boolean {
    return this.state !== 'running';
  }
}

/**
 * One physical press can arrive twice: through the global-shortcut grab and through the native
 * hook (uiohook only listens). A press from the *other* path within `windowMs` of the last
 * accepted one is that echo and is dropped; two presses on the same path are two presses (esc,
 * esc = pause, then stop).
 */
export class PressDedupe {
  private lastAt = -Infinity;
  private lastSource = '';
  private windowMs: number;

  constructor(windowMs = 400) {
    this.windowMs = windowMs;
  }

  accept(source: string, now: number): boolean {
    if (source !== this.lastSource && now - this.lastAt < this.windowMs) return false;
    this.lastAt = now;
    this.lastSource = source;
    return true;
  }

  /** a press handled elsewhere (e.g. another owner's grab) still swallows its echo */
  note(source: string, now: number): void {
    this.lastAt = now;
    this.lastSource = source;
  }
}

const MODS = ['Control', 'Alt', 'Shift', 'Meta', 'Fn'];
/** keys that may be the stop key on their own (no modifier): they never type anything */
const PLAIN_OK = /^(Escape|F([1-9]|1\d|2[0-4]))$/;

/** Default stop key. */
export const DEFAULT_STOP: KeyName[] = ['Escape'];

/**
 * Why `keys` can't be the stop key (null = fine). It is grabbed as a global shortcut while busy,
 * so: exactly one non-modifier key, no fn (not expressible as a shortcut), no taps, and a plain
 * key only if it never types (esc, f-keys) — otherwise a chord with ctrl / alt / cmd.
 * Plain enter is taken (continue a paused run).
 */
export function stopKeyProblem(keys: readonly KeyName[] | undefined, platform = 'darwin'): string | null {
  if (!Array.isArray(keys) || keys.length === 0) return 'press a key';
  if (keys.some((k) => typeof k !== 'string' || !k)) return 'press a key';
  if (keys[0] === 'DoubleTap' || keys[0] === 'TripleTap') return "taps can't stop — press one key";
  if (keys.includes('Fn')) return "fn can't be grabbed — pick another key";
  const main = keys.filter((k) => !MODS.includes(k));
  if (main.length !== 1) return main.length ? 'only one key besides modifiers' : 'add a key besides the modifiers';
  const strong = keys.some((k) => k === 'Control' || k === 'Alt' || k === 'Meta');
  if (!strong && !PLAIN_OK.test(main[0])) {
    return platform === 'darwin' ? 'pick esc, an f-key, or add control, option or cmd' : 'pick esc, an f-key, or add ctrl, alt or win';
  }
  return null;
}
