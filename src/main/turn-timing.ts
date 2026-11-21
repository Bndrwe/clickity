// Per-stage timing of a voice turn, measured from the moment the talk key goes up:
// audio ready → transcript → screenshot → model request → first token → first audio → done.
// Pure (type imports only): unit tested in test/turn-timing.test.ts. conversation.ts owns one
// TurnTimer per voice turn, logs `latency` lines to clickity.log and keeps the last breakdown for
// settings › about › diagnostics.
import type { TurnTiming } from '../shared/types';

export type TimingStage = 'audioReady' | 'transcript' | 'screenshot' | 'request' | 'firstToken' | 'firstAudio' | 'done';
const STAGES: TimingStage[] = ['audioReady', 'transcript', 'screenshot', 'request', 'firstToken', 'firstAudio', 'done'];
const LABEL: Record<TimingStage, string> = {
  audioReady: 'audio',
  transcript: 'transcript',
  screenshot: 'screenshot',
  request: 'request',
  firstToken: 'first token',
  firstAudio: 'first audio',
  done: 'done',
};

export class TurnTimer {
  readonly timing: TurnTiming;
  private readonly keyUp: number;

  constructor(turnId: number, keyUpAt: number, heldMs: number, labels: { stt?: string; model?: string; tts?: string } = {}) {
    this.keyUp = keyUpAt;
    this.timing = {
      turnId,
      at: keyUpAt,
      heldMs,
      stt: labels.stt ?? '',
      model: labels.model ?? '',
      tts: labels.tts ?? '',
      audioReady: null,
      transcript: null,
      screenshot: null,
      request: null,
      firstToken: null,
      firstAudio: null,
      done: null,
      notes: [],
    };
  }

  /** Record a stage the first time it happens (later calls are ignored). Before key up counts as 0. */
  mark(stage: TimingStage, at = Date.now()): void {
    if (this.timing[stage] !== null) return;
    this.timing[stage] = Math.max(0, Math.round(at - this.keyUp));
  }

  has(stage: TimingStage): boolean {
    return this.timing[stage] !== null;
  }

  set(field: 'stt' | 'model' | 'tts', value: string): void {
    this.timing[field] = value;
  }

  note(text: string): void {
    if (text && !this.timing.notes.includes(text) && this.timing.notes.length < 12) this.timing.notes.push(text);
  }

  snapshot(): TurnTiming {
    return { ...this.timing, notes: [...this.timing.notes] };
  }
}

/** "audio 40ms · transcript 210ms · … · first audio 1.65s · done 5.2s" */
export function formatTiming(t: TurnTiming): string {
  const fmt = (ms: number): string => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`);
  return STAGES.filter((s) => t[s] !== null)
    .map((s) => `${LABEL[s]} ${fmt(t[s] as number)}`)
    .join(' · ');
}

/** The full log line: stages, then what ran them. */
export function timingLine(t: TurnTiming): string {
  const what = [t.stt && `stt ${t.stt}`, t.model && `model ${t.model}`, t.tts && `voice ${t.tts}`].filter(Boolean).join(', ');
  return `turn ${t.turnId} (held ${t.heldMs}ms): ${formatTiming(t) || 'no stages'}${what ? ` | ${what}` : ''}${t.notes.length ? ` | ${t.notes.join('; ')}` : ''}`;
}
