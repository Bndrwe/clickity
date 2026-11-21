// Incremental on-device transcription: while the talk key is held, finished stretches of speech
// (cut at a pause) are transcribed in the worker, so at key up only the last few seconds are left.
// Whisper pads every call to a 30 s window, so short chunks cost about the same encoder time as
// long ones: chunks are only cut once there's a decent amount of audio (MIN_CHUNK_S) and at a
// quiet moment, never mid-word.
import { transcribeLocalTimed } from './stt-local';

const RATE = 16000;
const MIN_CHUNK_S = 6;
const FORCE_CHUNK_S = 14;
const FRAME = 320; // 20 ms

function rms(pcm: Float32Array, from: number, to: number): number {
  let s = 0;
  for (let i = from; i < to; i++) s += pcm[i]! * pcm[i]!;
  return Math.sqrt(s / Math.max(1, to - from));
}

/** Index of the quietest 200 ms stretch in [from, to) (its middle), and how quiet it is. */
export function quietestPoint(pcm: Float32Array, from: number, to: number): { at: number; level: number } {
  const win = 10; // frames
  let best = { at: to, level: Infinity };
  const frames: number[] = [];
  for (let i = from; i + FRAME <= to; i += FRAME) frames.push(rms(pcm, i, i + FRAME));
  for (let f = 0; f + win <= frames.length; f++) {
    let s = 0;
    for (let k = 0; k < win; k++) s += frames[f + k]!;
    const level = s / win;
    if (level < best.level) best = { at: from + (f + win / 2) * FRAME, level };
  }
  return best;
}

export class IncrementalStt {
  private audio: Float32Array[] = [];
  private length = 0;
  private committed = 0; // samples already handed to a chunk
  private texts: string[] = [];
  private busy: Promise<void> | null = null;
  private stopped = false;
  chunks = 0;
  error: unknown = null;
  private model: string;
  private language?: string;
  private log: (m: string) => void;

  constructor(model: string, language: string | undefined, log: (m: string) => void) {
    this.model = model;
    this.language = language;
    this.log = log;
  }

  private all(): Float32Array {
    if (this.audio.length > 1) {
      const out = new Float32Array(this.length);
      let o = 0;
      for (const c of this.audio) {
        out.set(c, o);
        o += c.length;
      }
      this.audio = [out];
    }
    return this.audio[0] ?? new Float32Array(0);
  }

  /** 16 kHz samples as they're recorded */
  push(pcm16k: Float32Array): void {
    if (this.stopped || !pcm16k.length) return;
    this.audio.push(pcm16k);
    this.length += pcm16k.length;
    if (!this.busy && this.length - this.committed >= MIN_CHUNK_S * RATE) this.maybeCut();
  }

  private maybeCut(): void {
    const pcm = this.all();
    const from = this.committed + Math.round(MIN_CHUNK_S * 0.6 * RATE);
    const to = this.length - Math.round(0.3 * RATE);
    if (to - from < RATE / 2) return;
    const q = quietestPoint(pcm, from, to);
    const speech = rms(pcm, this.committed, this.length);
    const quiet = q.level < Math.max(0.004, speech * 0.25);
    if (!quiet && this.length - this.committed < FORCE_CHUNK_S * RATE) return;
    const chunk = pcm.slice(this.committed, q.at);
    this.committed = q.at;
    const idx = this.texts.length;
    this.texts.push('');
    this.chunks++;
    this.busy = transcribeLocalTimed(chunk, this.model, this.language)
      .then((r) => {
        this.texts[idx] = r.text;
        this.log(`chunk ${idx + 1}: ${(chunk.length / RATE).toFixed(1)}s → ${r.text.length} chars in ${r.ms}ms`);
      })
      .catch((e: unknown) => {
        this.error = e;
      })
      .finally(() => {
        this.busy = null;
        if (!this.stopped && this.length - this.committed >= MIN_CHUNK_S * RATE) this.maybeCut();
      });
  }

  /**
   * Key up: transcribe what's left and return the whole transcript. `tail` = audio that was
   * recorded after the last streamed block (the final flush), if any.
   */
  async finish(tail?: Float32Array): Promise<{ text: string; tailMs: number; tailS: number; device?: string }> {
    if (tail?.length) {
      this.audio.push(tail);
      this.length += tail.length;
    }
    this.stopped = true;
    while (this.busy) await this.busy;
    if (this.error) throw this.error;
    const pcm = this.all();
    const rest = pcm.slice(this.committed);
    let tailMs = 0;
    let device: string | undefined;
    if (rest.length >= RATE / 4 || this.texts.length === 0) {
      const r = await transcribeLocalTimed(rest, this.model, this.language);
      this.texts.push(r.text);
      tailMs = r.ms;
      device = r.device;
    }
    return { text: this.texts.map((t) => t.trim()).filter(Boolean).join(' '), tailMs, tailS: rest.length / RATE, device };
  }

  /** the whole recording (for the peak check / fallback) */
  recording(): Float32Array {
    return this.all();
  }

  cancel(): void {
    this.stopped = true;
    this.audio = [];
  }
}
