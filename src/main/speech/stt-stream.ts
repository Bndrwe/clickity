// Streaming speech-to-text: the overlay streams 16 kHz PCM to main while the talk key is held
// (IPC.pttAudio), so by the time the key goes up the transcript is (almost) ready.
//
//  - openai   realtime transcription websocket (wss …/v1/realtime?intent=transcription,
//             gpt-live-transcribe): text deltas while you talk, `commit` at key up.
//  - deepgram live websocket (nova-3): interim + final results while you talk, `Finalize` at key up.
//  - groq / openai (streaming off) / local / gemini: the audio is already in main at key up, so
//             the upload starts immediately (no wait for the overlay to stop, resample and encode).
//
// Every stream keeps the audio: when a websocket fails (bad key, network, server error) the
// same recording is transcribed over HTTPS instead, so a flaky stream never loses the question.
// Electron-free (fetch + the global WebSocket): unit tested against local fake servers.
import type { Settings } from '../../shared/types';
import { transcribe } from './stt.ts';

export interface SttStream {
  /** "deepgram (streaming)" etc. for the latency log */
  readonly label: string;
  /** 16 kHz mono int16 samples, in order */
  push(pcm: Int16Array): void;
  /** key up: the final transcript */
  finish(signal?: AbortSignal): Promise<string>;
  abort(): void;
  /** live text so far (streaming providers) */
  readonly partial: string;
  /** notes for the latency log ("fell back to https: …") */
  readonly notes: string[];
}

type WsCtor = new (url: string, opts?: unknown) => WebSocket;

export interface SttStreamOptions {
  prompt?: string;
  /** tests: a WebSocket implementation */
  WebSocket?: WsCtor;
  /** tests / e2e fakes: base urls (else CLICKITY_*_BASE env, else the real hosts) */
  openaiBase?: string;
  deepgramBase?: string;
  /** how long finish() waits for the final words before using what it has */
  finalTimeoutMs?: number;
}

const env = (name: string): string | undefined => (typeof process !== 'undefined' ? process.env[name] : undefined) || undefined;

/** https://api.openai.com/v1 (or the test override) */
export function openaiBase(o?: string): string {
  return (o ?? env('CLICKITY_OPENAI_BASE') ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
}
function deepgramBase(o?: string): string {
  return (o ?? env('CLICKITY_DEEPGRAM_BASE') ?? 'https://api.deepgram.com/v1').replace(/\/+$/, '');
}
const toWs = (url: string): string => url.replace(/^http/, 'ws');

/** 16-bit mono PCM → WAV file bytes. */
export function pcmToWav(pcm: Int16Array, rate = 16000): Buffer {
  const buf = Buffer.alloc(44 + pcm.length * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + pcm.length * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(pcm.length * 2, 40);
  Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).copy(buf, 44);
  return buf;
}

/** 16 kHz → 24 kHz (linear; the realtime api wants 24 kHz pcm). */
export function upsample16to24(pcm: Int16Array): Int16Array {
  const n = Math.floor((pcm.length * 3) / 2);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const pos = (i * 2) / 3;
    const a = Math.floor(pos);
    const f = pos - a;
    const x = pcm[a] ?? 0;
    const y = pcm[a + 1] ?? x;
    out[i] = Math.round(x + (y - x) * f);
  }
  return out;
}

function concat(chunks: Int16Array[]): Int16Array {
  let n = 0;
  for (const c of chunks) n += c.length;
  const out = new Int16Array(n);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

const b64 = (pcm: Int16Array): string => Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64');

/** Which stream the settings ask for (null = on-device: the overlay transcribes itself). */
export function streamKind(settings: Settings): 'openai-realtime' | 'deepgram' | 'upload' | null {
  const stt = settings.speech.stt;
  if (stt.provider === 'on-device') return null;
  if (stt.provider === 'deepgram') return 'deepgram';
  if (stt.provider === 'openai' && stt.streaming !== false) return 'openai-realtime';
  return 'upload';
}

function openaiKey(settings: Settings): string | undefined {
  return settings.speech.stt.apiKey || settings.providers['openai-api']?.apiKey || undefined;
}

/** Base: keeps the audio, transcribes it over HTTPS on finish (groq, local, gemini, fallback). */
class UploadStream implements SttStream {
  label: string;
  partial = '';
  notes: string[] = [];
  protected chunks: Int16Array[] = [];
  protected aborted = false;
  protected settings: Settings;
  protected prompt?: string;
  constructor(settings: Settings, prompt?: string, label?: string) {
    this.settings = settings;
    this.prompt = prompt;
    this.label = label ?? `${settings.speech.stt.provider} (upload at key up)`;
  }
  push(pcm: Int16Array): void {
    if (!this.aborted && pcm.length) this.chunks.push(pcm);
  }
  audio(): Int16Array {
    return concat(this.chunks);
  }
  async upload(signal?: AbortSignal, settings = this.settings): Promise<string> {
    const pcm = this.audio();
    if (pcm.length < 1600) return '';
    return (await transcribe(pcmToWav(pcm), settings, signal, { prompt: this.prompt })).trim();
  }
  finish(signal?: AbortSignal): Promise<string> {
    return this.upload(signal);
  }
  abort(): void {
    this.aborted = true;
    this.chunks = [];
  }
}

/** Shared websocket plumbing: queue until open, fall back to an upload on failure. */
abstract class SocketStream extends UploadStream {
  protected ws: WebSocket | null = null;
  protected open = false;
  protected failed: string | null = null;
  protected queue: Int16Array[] = [];
  protected finalTimeoutMs: number;
  protected waiters: Array<() => void> = [];
  constructor(settings: Settings, prompt: string | undefined, label: string, opts: SttStreamOptions) {
    super(settings, prompt, label);
    this.finalTimeoutMs = opts.finalTimeoutMs ?? 4000;
  }

  protected connect(Ws: WsCtor, url: string, init: unknown): void {
    let ws: WebSocket;
    try {
      ws = new Ws(url, init);
    } catch (e) {
      this.fail(`couldn't open the stream: ${(e as Error).message}`);
      return;
    }
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    ws.addEventListener('open', () => {
      if (this.aborted) return ws.close();
      this.open = true;
      this.onOpen();
      for (const c of this.queue) this.send(c);
      this.queue = [];
    });
    ws.addEventListener('message', (ev: MessageEvent) => {
      if (typeof ev.data !== 'string') return;
      let j: any;
      try {
        j = JSON.parse(ev.data);
      } catch {
        return;
      }
      this.onMessage(j);
    });
    ws.addEventListener('error', () => this.fail('stream error'));
    ws.addEventListener('close', (ev: CloseEvent) => {
      this.open = false;
      if (!this.done()) this.fail(`stream closed (${ev.code}${ev.reason ? ` ${ev.reason.slice(0, 80)}` : ''})`);
      this.wake();
    });
  }

  push(pcm: Int16Array): void {
    super.push(pcm);
    if (this.aborted || this.failed) return;
    if (this.open) this.send(pcm);
    else this.queue.push(pcm);
  }

  protected fail(why: string): void {
    if (this.failed || this.done()) return;
    this.failed = why.toLowerCase();
    this.wake();
  }

  protected wake(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  /** wait until `cond` or a failure / close / timeout */
  protected waitFor(cond: () => boolean, ms: number, signal?: AbortSignal): Promise<'ok' | 'timeout' | 'failed'> {
    return new Promise((resolve) => {
      const check = (): void => {
        if (cond()) return finish('ok');
        if (this.failed || signal?.aborted) return finish('failed');
        this.waiters.push(check);
      };
      let settled = false;
      const timer = setTimeout(() => finish('timeout'), ms);
      const finish = (r: 'ok' | 'timeout' | 'failed'): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(r);
      };
      check();
    });
  }

  async finish(signal?: AbortSignal): Promise<string> {
    if (!this.failed) {
      // not connected yet (slow handshake): give it a moment, the audio is queued
      if (!this.open) await this.waitFor(() => this.open, Math.min(2500, this.finalTimeoutMs), signal);
      if (this.open && !this.failed) {
        this.onFinish();
        const r = await this.waitFor(() => this.done(), this.finalTimeoutMs, signal);
        if (r === 'ok') {
          this.close();
          return this.result().trim();
        }
        if (r === 'timeout') {
          this.notes.push('final words timed out');
          const text = this.result().trim();
          this.close();
          if (text) return text;
        }
      }
    }
    this.close();
    if (signal?.aborted) throw new Error('cancelled');
    // the stream failed: transcribe the same recording over https
    this.notes.push(`stream failed (${this.failed ?? 'not connected'}): uploaded instead`);
    return this.upload(signal, this.fallbackSettings());
  }

  protected close(): void {
    try {
      if (this.ws && this.ws.readyState <= 1) this.ws.close();
    } catch {
      /* already closing */
    }
  }

  abort(): void {
    super.abort();
    this.close();
    this.wake();
  }

  protected fallbackSettings(): Settings {
    return this.settings;
  }

  protected abstract send(pcm: Int16Array): void;
  protected abstract onOpen(): void;
  protected abstract onMessage(j: any): void;
  protected abstract onFinish(): void;
  /** the final transcript has arrived */
  protected abstract done(): boolean;
  protected abstract result(): string;
}

/**
 * OpenAI realtime transcription (GA shape): session.update with session.type "transcription",
 * audio/pcm 24 kHz, turn_detection null; input_audio_buffer.append / commit; transcript from
 * conversation.item.input_audio_transcription.delta / .completed.
 */
class OpenAiRealtimeStream extends SocketStream {
  private deltas = '';
  private completed: string | null = null;
  private committedItem: string | null = null;
  private model: string;
  private sentSamples = 0;
  constructor(settings: Settings, prompt: string | undefined, opts: SttStreamOptions) {
    const model = settings.speech.stt.model && !/^(whisper|gpt-transcribe$|gpt-4o)/.test(settings.speech.stt.model) ? settings.speech.stt.model : 'gpt-live-transcribe';
    super(settings, prompt, `openai ${model} (streaming)`, opts);
    this.model = model;
    const key = openaiKey(settings);
    if (!key) {
      this.fail('missing api key');
      return;
    }
    const Ws = (opts.WebSocket ?? (globalThis as any).WebSocket) as WsCtor | undefined;
    if (!Ws) {
      this.fail('no websocket support');
      return;
    }
    const url = `${toWs(openaiBase(opts.openaiBase))}/realtime?intent=transcription`;
    this.connect(Ws, url, { headers: { Authorization: `Bearer ${key}` } });
  }
  protected onOpen(): void {
    const lang = this.settings.speech.stt.language?.trim();
    const transcription: Record<string, unknown> = { model: this.model };
    if (this.prompt) transcription.prompt = this.prompt.slice(0, 800);
    if (lang) transcription.language = lang;
    this.ws!.send(
      JSON.stringify({
        type: 'session.update',
        session: { type: 'transcription', audio: { input: { format: { type: 'audio/pcm', rate: 24000 }, transcription, turn_detection: null } } },
      }),
    );
  }
  protected send(pcm: Int16Array): void {
    this.sentSamples += pcm.length;
    this.ws!.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: b64(upsample16to24(pcm)) }));
  }
  protected onMessage(j: any): void {
    switch (j?.type) {
      case 'input_audio_buffer.committed':
        this.committedItem = j.item_id ?? this.committedItem;
        break;
      case 'conversation.item.input_audio_transcription.delta':
        if (typeof j.delta === 'string') {
          this.deltas += j.delta;
          this.partial = this.deltas;
        }
        break;
      case 'conversation.item.input_audio_transcription.completed':
        if (!this.committedItem || !j.item_id || j.item_id === this.committedItem) {
          this.completed = typeof j.transcript === 'string' ? j.transcript : this.deltas;
          this.wake();
        }
        break;
      case 'conversation.item.input_audio_transcription.failed':
        this.fail(`transcription failed: ${j.error?.message ?? 'unknown'}`);
        break;
      case 'error': {
        const code = String(j.error?.code ?? '');
        // committing an empty buffer (nothing was said): no words, not a failure
        if (/commit_empty|buffer_too_small/.test(code)) {
          this.completed = this.deltas;
          this.wake();
        } else this.fail(`${j.error?.message ?? code ?? 'error'}`);
        break;
      }
    }
  }
  protected onFinish(): void {
    if (this.sentSamples < 1600) {
      this.completed = '';
      this.wake();
      return;
    }
    this.ws!.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
  }
  protected done(): boolean {
    return this.completed !== null;
  }
  protected result(): string {
    return this.completed ?? this.deltas;
  }
  protected fallbackSettings(): Settings {
    const s = this.settings;
    return { ...s, speech: { ...s.speech, stt: { ...s.speech.stt, model: 'gpt-transcribe' } } };
  }
}

/** Deepgram live: binary linear16 frames; Results (is_final) while talking; Finalize at key up. */
class DeepgramStream extends SocketStream {
  private finals: string[] = [];
  private interim = '';
  private finalized = false;
  constructor(settings: Settings, prompt: string | undefined, opts: SttStreamOptions) {
    const stt = settings.speech.stt;
    const model = stt.model && !/whisper|gpt|live/.test(stt.model) ? stt.model : 'nova-3';
    super(settings, prompt, `deepgram ${model} (streaming)`, opts);
    const key = stt.apiKey;
    if (!key) {
      this.fail('missing api key');
      return;
    }
    const Ws = (opts.WebSocket ?? (globalThis as any).WebSocket) as WsCtor | undefined;
    if (!Ws) {
      this.fail('no websocket support');
      return;
    }
    const q = new URLSearchParams({
      model,
      encoding: 'linear16',
      sample_rate: '16000',
      channels: '1',
      interim_results: 'true',
      smart_format: 'true',
      punctuate: 'true',
    });
    const lang = stt.language?.trim();
    if (lang) q.set('language', lang);
    // dictionary words: nova-3 calls them keyterms
    for (const w of (prompt ?? '').split(/[,\n]+/).map((x) => x.trim()).filter(Boolean).slice(0, 50)) q.append('keyterm', w);
    // the browser-style subprotocol auth works with every websocket implementation
    this.connect(Ws, `${toWs(deepgramBase(opts.deepgramBase))}/listen?${q}`, ['token', key]);
  }
  protected onOpen(): void {}
  protected send(pcm: Int16Array): void {
    this.ws!.send(pcm.slice().buffer);
  }
  protected onMessage(j: any): void {
    if (j?.type === 'Results') {
      const t = String(j.channel?.alternatives?.[0]?.transcript ?? '').trim();
      if (j.is_final) {
        if (t) this.finals.push(t);
        this.interim = '';
      } else this.interim = t;
      this.partial = [...this.finals, this.interim].filter(Boolean).join(' ');
      if (j.from_finalize) {
        this.finalized = true;
        this.wake();
      }
    } else if (j?.type === 'Metadata' && this.finalSent) {
      // CloseStream answered: everything has been flushed
      this.finalized = true;
      this.wake();
    } else if (j?.type === 'Error' || j?.err_code) {
      this.fail(String(j.description ?? j.err_msg ?? 'error'));
    }
  }
  private finalSent = false;
  protected onFinish(): void {
    this.finalSent = true;
    this.ws!.send(JSON.stringify({ type: 'Finalize' }));
  }
  protected done(): boolean {
    return this.finalized;
  }
  protected result(): string {
    return [...this.finals, this.interim].filter(Boolean).join(' ');
  }
}

/** The stream for these settings, or null for on-device (the overlay transcribes itself). */
export function createSttStream(settings: Settings, opts: SttStreamOptions = {}): SttStream | null {
  switch (streamKind(settings)) {
    case 'openai-realtime':
      return new OpenAiRealtimeStream(settings, opts.prompt, opts);
    case 'deepgram':
      return new DeepgramStream(settings, opts.prompt, opts);
    case 'upload':
      return new UploadStream(settings, opts.prompt);
    default:
      return null;
  }
}
