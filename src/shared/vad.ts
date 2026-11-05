// A tiny energy voice-activity detector for hands-free mode. Pure: feed it the RMS level of
// successive audio frames (with their time) and it says when an utterance starts and ends.
// Used by the overlay renderer; unit tested under node.

export interface VadOptions {
  /** RMS above this (after the adaptive floor) counts as speech */
  threshold: number;
  /** speech must last this long before an utterance counts (shorter = a click / cough) */
  minSpeechMs: number;
  /** this much silence ends an utterance */
  silenceMs: number;
  /** consecutive loud time needed to start (debounce) */
  startMs: number;
  /** utterances are cut here */
  maxMs: number;
}

export const DEFAULT_VAD: VadOptions = { threshold: 0.018, minSpeechMs: 400, silenceMs: 900, startMs: 120, maxMs: 30_000 };

export type VadEvent =
  | { type: 'start'; at: number }
  /** an utterance worth transcribing: [start, end] in the caller's clock */
  | { type: 'end'; start: number; end: number }
  /** started, but too short to be speech */
  | { type: 'discard'; start: number; end: number };

export class EnergyVad {
  private opts: VadOptions;
  private floor = 0;
  private loudSince: number | null = null;
  private speechStart: number | null = null;
  private lastLoud = 0;

  constructor(opts: Partial<VadOptions> = {}) {
    this.opts = { ...DEFAULT_VAD, ...opts };
  }

  get speaking(): boolean {
    return this.speechStart !== null;
  }

  reset(): void {
    this.loudSince = null;
    this.speechStart = null;
  }

  /** The current threshold: the configured one, raised a little over a noisy room's floor. */
  level(): number {
    return Math.max(this.opts.threshold, this.floor * 2.5);
  }

  /** One frame. Returns an event when the state changes. */
  push(rms: number, now: number): VadEvent | null {
    const o = this.opts;
    const loud = rms > this.level();
    // track the noise floor slowly while nobody is talking
    if (!loud && this.speechStart === null) this.floor = this.floor ? this.floor * 0.98 + rms * 0.02 : rms;
    if (this.speechStart === null) {
      if (!loud) {
        this.loudSince = null;
        return null;
      }
      this.loudSince ??= now;
      if (now - this.loudSince < o.startMs) return null;
      this.speechStart = this.loudSince;
      this.lastLoud = now;
      return { type: 'start', at: this.speechStart };
    }
    if (loud) this.lastLoud = now;
    const start = this.speechStart;
    const tooLong = now - start >= o.maxMs;
    if (now - this.lastLoud >= o.silenceMs || tooLong) {
      const end = tooLong ? now : this.lastLoud;
      this.speechStart = null;
      this.loudSince = null;
      return end - start >= o.minSpeechMs ? { type: 'end', start, end } : { type: 'discard', start, end };
    }
    return null;
  }
}

/** RMS of a frame of samples. */
export function rmsOf(frame: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < frame.length; i++) s += frame[i] * frame[i];
  return frame.length ? Math.sqrt(s / frame.length) : 0;
}

/** The output device's name suggests the companion's voice can't leak into the mic. */
export function looksLikeHeadphones(label: string): boolean {
  return /head(phone|set)|airpods|buds|earphone|bluetooth|bose|sony wh|beats/i.test(label);
}
