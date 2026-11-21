// Speak-as-you-go: turns a streaming reply into an ordered sequence of SpeakCommands for the
// overlay, one sentence at a time, so the first sentence is heard while the model is still
// writing the rest.
//
//  kokoro / system: each sentence goes to the overlay as text right away (it synthesises
//    on-device; Kokoro prepares the next sentence while the current one plays).
//  openai / elevenlabs: each sentence is requested as streamed 24 kHz PCM; up to two requests
//    run ahead, but chunks are forwarded strictly in sentence order, so playback is gapless.
//    A sentence whose request fails is said with the system voice instead.
//
// Every command carries the utterance id; the last one is `{ mode: 'end' }`. Electron-free:
// unit tested (test/speak-stream.test.ts) with a fake sender and fake PCM source.
import type { Settings, SpeakCommand } from '../../shared/types';
import { SentenceChunker } from '../../shared/sentences.ts';
import { KOKORO_DEFAULT_VOICE, STREAM_PCM_RATE, cleanForSpeech, streamPcm } from './tts.ts';

export type PcmSource = (text: string, settings: Settings, signal: AbortSignal, onChunk: (pcm: Buffer) => void) => Promise<void>;

export interface SpeechStreamOptions {
  settings: Settings;
  utt: string;
  signal: AbortSignal;
  send(cmd: SpeakCommand): void;
  /** the first command with audio (or text to synthesise) was handed to the overlay */
  onFirstSent?(): void;
  log?(msg: string): void;
  /** tests: replaces the cloud PCM request */
  pcm?: PcmSource;
}

/** bytes per forwarded PCM chunk: ~100 ms (the first one goes out as soon as it's ~50 ms) */
const CHUNK_BYTES = (STREAM_PCM_RATE * 2) / 10;
const AHEAD = 2;

interface Piece {
  text: string;
  chunks: Buffer[];
  done: boolean;
  failed: boolean;
  started: boolean;
}

export class SpeechStream {
  readonly utt: string;
  private o: SpeechStreamOptions;
  private chunker: SentenceChunker;
  private pieces: Piece[] = [];
  private sending = 0; // index of the piece being forwarded
  private ended = false;
  private closed = false;
  private sentAny = false;
  private wakeSender: (() => void) | null = null;
  private senderDone: Promise<void> | null = null;
  private mode: 'text' | 'pcm' | 'off';
  /** visible text handed to the chunker so far */
  private lastText = '';

  constructor(o: SpeechStreamOptions) {
    this.o = o;
    this.utt = o.utt;
    const p = o.settings.speech.tts.provider;
    this.mode = p === 'off' ? 'off' : p === 'openai' || p === 'elevenlabs' ? 'pcm' : 'text';
    // on-device synthesis time grows with the sentence: start Kokoro on a shorter first piece
    this.chunker = new SentenceChunker(p === 'kokoro' ? { firstMax: 60 } : {});
  }

  /** true once anything has been handed to the overlay */
  get started(): boolean {
    return this.sentAny;
  }

  /** finish() / cancel() was called */
  get finished(): boolean {
    return this.ended;
  }

  get enabled(): boolean {
    return this.mode !== 'off';
  }

  /** The reply so far (visible text, tags stripped). */
  update(visible: string): void {
    if (this.mode === 'off' || this.ended || this.o.signal.aborted) return;
    this.lastText = visible;
    for (const s of this.chunker.update(visible)) this.add(s);
  }

  /**
   * The reply is complete. `spoken` is the full text to say (it may extend the streamed text,
   * e.g. a choice question's options); whatever wasn't said yet is said now. Resolves when
   * everything has been handed to the overlay (not when it finished playing).
   */
  async finish(spoken?: string): Promise<void> {
    if (this.ended) return this.senderDone ?? undefined;
    if (this.mode !== 'off' && !this.o.signal.aborted) {
      const full = spoken ?? this.lastText;
      const upTo = this.chunker.spokenUpTo;
      if (this.lastText && full.startsWith(this.lastText.slice(0, upTo))) {
        for (const s of this.chunker.flush(full)) this.add(s);
      } else if (!this.lastText) {
        for (const s of this.chunker.flush(full)) this.add(s);
      } else {
        // the final text differs from what streamed (rare): say the rest of the stream, then the difference
        for (const s of this.chunker.flush(this.lastText)) this.add(s);
        const extra = full.startsWith(this.lastText) ? full.slice(this.lastText.length) : '';
        for (const s of new SentenceChunker().flush(extra)) this.add(s);
      }
    }
    this.ended = true;
    this.kick();
    if (this.mode !== 'pcm') {
      this.close();
      return;
    }
    await (this.senderDone ?? Promise.resolve());
  }

  /** Stop: nothing more is sent (the caller stops playback in the overlay). */
  cancel(): void {
    this.ended = true;
    this.closed = true;
    this.kick();
  }

  private add(text: string): void {
    const clean = cleanForSpeech(text);
    if (!clean) return;
    if (this.mode === 'text') {
      const t = this.o.settings.speech.tts;
      const rate = Number.isFinite(t.rate) && t.rate > 0 ? t.rate : 1;
      const cmd: SpeakCommand =
        t.provider === 'kokoro'
          ? { mode: 'kokoro', text: clean, voice: t.voice || KOKORO_DEFAULT_VOICE, rate, utt: this.utt, more: true }
          : { mode: 'system', text: clean, voice: t.voice, rate, utt: this.utt, more: true };
      this.emit(cmd);
      return;
    }
    this.pieces.push({ text: clean, chunks: [], done: false, failed: false, started: false });
    this.startAhead();
    if (!this.senderDone) this.senderDone = this.sender();
  }

  private emit(cmd: SpeakCommand): void {
    if (this.closed || this.o.signal.aborted) return;
    if (!this.sentAny && cmd.mode !== 'end') {
      this.sentAny = true;
      this.o.onFirstSent?.();
    }
    this.o.send(cmd);
  }

  private close(): void {
    if (this.closed || this.mode === 'off') return;
    this.emit({ mode: 'end', utt: this.utt });
    this.closed = true;
  }

  private kick(): void {
    const w = this.wakeSender;
    this.wakeSender = null;
    w?.();
  }

  private startAhead(): void {
    for (let i = this.sending; i < Math.min(this.pieces.length, this.sending + AHEAD); i++) {
      const p = this.pieces[i]!;
      if (p.started) continue;
      p.started = true;
      const source = this.o.pcm ?? streamPcm;
      source(p.text, this.o.settings, this.o.signal, (b) => {
        p.chunks.push(b);
        if (i === this.sending) this.kick();
      })
        .catch((e: unknown) => {
          if (this.o.signal.aborted) return;
          p.failed = true;
          this.o.log?.(`sentence ${i + 1} speech failed, using the system voice: ${(e as Error)?.message ?? e}`);
        })
        .finally(() => {
          p.done = true;
          this.kick();
        });
    }
  }

  private async sender(): Promise<void> {
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    let firstOfPiece = true;
    const flush = (piece: Piece): void => {
      if (!pendingBytes) return;
      const data = Buffer.concat(pending);
      pending = [];
      pendingBytes = 0;
      const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
      this.emit({ mode: 'pcm', sampleRate: STREAM_PCM_RATE, data: ab, text: firstOfPiece ? piece.text : undefined, utt: this.utt, more: true });
      firstOfPiece = false;
    };
    while (!this.closed && !this.o.signal.aborted) {
      const piece = this.pieces[this.sending];
      if (!piece) {
        if (this.ended) break;
        await new Promise<void>((r) => (this.wakeSender = r));
        continue;
      }
      while (piece.chunks.length) {
        const c = piece.chunks.shift()!;
        pending.push(c);
        pendingBytes += c.length;
        // the very first audio goes out as soon as there's ~50 ms of it
        if (pendingBytes >= (this.sentAny ? CHUNK_BYTES : CHUNK_BYTES / 2)) flush(piece);
      }
      if (piece.done) {
        flush(piece);
        if (piece.failed && firstOfPiece) {
          const t = this.o.settings.speech.tts;
          this.emit({ mode: 'system', text: piece.text, voice: '', rate: t.rate || 1, utt: this.utt, more: true });
        }
        this.sending++;
        firstOfPiece = true;
        this.startAhead();
        continue;
      }
      await new Promise<void>((r) => (this.wakeSender = r));
    }
    this.close();
  }
}
