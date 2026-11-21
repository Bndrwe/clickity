// Plays SpeakCommands. A reply arrives sentence by sentence while the model is still writing
// (speak-stream.ts in main): every piece is scheduled back to back on one AudioContext, so the
// voice is gapless and starts with the first sentence.
//  - pcm: raw 16-bit PCM chunks (openai / elevenlabs, streamed)
//  - audio: encoded clips (mp3 / wav)
//  - kokoro: synthesised on-device in tts-worker.js (the next sentence is prepared while one plays);
//    if Kokoro can't run, the best system voice says it instead
//  - system: speechSynthesis (the best installed "premium / enhanced / natural" voice by default)
// stop() cuts everything instantly (barge-in). onDone(utt) fires when an utterance has ended
// (`mode: 'end'` / a one-shot piece) and everything queued has played, or on stop.
import type { SpeakCommand, SpeechTiming } from '../../shared/types';

/** Split text into utterance-sized pieces to dodge Chrome's long-utterance cutoff. */
export function splitSentences(text: string, max = 180): string[] {
  const sentences = text.replace(/\s+/g, ' ').trim().match(/[^.!?…]+(?:[.!?…]+["')\]]*|$)\s*/g) ?? [];
  const out: string[] = [];
  for (let s of sentences) {
    s = s.trim();
    while (s.length > max) {
      let cut = s.lastIndexOf(', ', max);
      if (cut < max / 3) cut = s.lastIndexOf(' ', max);
      if (cut < max / 3) cut = max;
      out.push(s.slice(0, cut + 1).trim());
      s = s.slice(cut + 1).trim();
    }
    if (s) out.push(s);
  }
  return out;
}

function voicesReady(): Promise<SpeechSynthesisVoice[]> {
  if (!('speechSynthesis' in window)) return Promise.resolve([]);
  const now = speechSynthesis.getVoices();
  if (now.length) return Promise.resolve(now);
  return new Promise((resolve) => {
    const done = () => {
      speechSynthesis.removeEventListener('voiceschanged', done);
      clearTimeout(timer);
      resolve(speechSynthesis.getVoices());
    };
    const timer = setTimeout(done, 1000);
    speechSynthesis.addEventListener('voiceschanged', done);
  });
}

/**
 * The most natural installed voice for the UI language: neural / premium / enhanced voices
 * (macOS "(Premium)" / "(Enhanced)", Windows "… Online (Natural)", "Neural") beat the default.
 */
export function bestVoice(voices: SpeechSynthesisVoice[], lang = navigator.language || 'en-US'): SpeechSynthesisVoice | null {
  if (!voices.length) return null;
  const base = lang.toLowerCase().split('-')[0]!;
  const score = (v: SpeechSynthesisVoice): number => {
    const n = v.name;
    let s = 0;
    const vl = v.lang.toLowerCase();
    if (vl === lang.toLowerCase()) s += 40;
    else if (vl.split(/[-_]/)[0] === base) s += 30;
    else return -100;
    if (/\(premium\)/i.test(n)) s += 50;
    else if (/natural/i.test(n)) s += 48;
    else if (/neural/i.test(n)) s += 46;
    else if (/\(enhanced\)/i.test(n)) s += 40;
    else if (/siri/i.test(n)) s += 30;
    else if (/google/i.test(n)) s += 20; // chromium's network voices sound better than espeak
    if (/espeak|robot|whisper|bells|bad news|bahh|boing|bubbles|cellos|deranged|hysterical|jester|organ|trinoids|zarvox|albert|fred|junior|ralph|superstar|wobble/i.test(n)) s -= 60;
    if (v.default) s += 5;
    if (v.localService) s += 2;
    return s;
  };
  let best: SpeechSynthesisVoice | null = null;
  let bestScore = -Infinity;
  for (const v of voices) {
    const s = score(v);
    if (s > bestScore) {
      best = v;
      bestScore = s;
    }
  }
  return bestScore > -100 ? best : (voices.find((v) => v.default) ?? voices[0] ?? null);
}

type KokoroStatus = { state: 'idle' | 'downloading' | 'loading' | 'ready' | 'error'; progress?: number; device?: string; message?: string };

/** The Kokoro worker, shared by every utterance; null when it can't start. */
class Kokoro {
  private worker: Worker | null = null;
  private broken = false;
  private seq = 0;
  private pending = new Map<number, { resolve(v: { pcm: Float32Array; rate: number; ms: number }): void; reject(e: Error): void }>();
  status: KokoroStatus = { state: 'idle' };
  /** when loading last failed (offline at first use…): retried a minute later */
  failedAt = 0;
  onStatus: ((s: KokoroStatus) => void) | null = null;

  private get(): Worker | null {
    if (this.worker || this.broken) return this.worker;
    try {
      const w = new Worker('tts-worker.js');
      w.onmessage = (e: MessageEvent) => {
        const m = e.data as { type: string; id: number; pcm?: Float32Array; rate?: number; ms?: number; message?: string; state?: KokoroStatus['state']; progress?: number; device?: string };
        if (m.type === 'status') {
          this.status = { state: m.state ?? 'idle', progress: m.progress, device: m.device, message: m.message };
          if (m.state === 'error') this.failedAt = Date.now();
          this.onStatus?.(this.status);
        } else if (m.type === 'audio' && m.pcm) {
          this.pending.get(m.id)?.resolve({ pcm: m.pcm, rate: m.rate ?? 24000, ms: m.ms ?? 0 });
          this.pending.delete(m.id);
        } else if (m.type === 'error') {
          this.pending.get(m.id)?.reject(new Error(m.message ?? 'kokoro failed'));
          this.pending.delete(m.id);
        }
      };
      w.onerror = (e) => {
        console.warn('[speech] kokoro worker failed:', e.message);
        this.broken = true;
        this.worker = null;
        this.status = { state: 'error', message: 'worker failed' };
        this.onStatus?.(this.status);
        for (const p of this.pending.values()) p.reject(new Error('kokoro worker failed'));
        this.pending.clear();
      };
      this.worker = w;
    } catch (e) {
      console.warn('[speech] no kokoro worker:', e);
      this.broken = true;
    }
    return this.worker;
  }

  /** start downloading / loading in the background */
  preload(): void {
    this.get()?.postMessage({ type: 'load' });
  }

  /** usable right now (not still downloading / broken) */
  get ready(): boolean {
    return this.status.state === 'ready';
  }

  say(text: string, voice: string, speed: number): Promise<{ pcm: Float32Array; rate: number; ms: number }> {
    const w = this.get();
    if (!w) return Promise.reject(new Error('kokoro unavailable'));
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      this.pending.set(id, { resolve, reject });
      w.postMessage({ type: 'say', id, text, voice, speed });
    });
  }
}

export const kokoro = new Kokoro();

/** One queued piece. `buffer` resolves to audio to schedule, or null = say `text` with the system voice. */
interface Item {
  utt?: string;
  more: boolean;
  end: boolean;
  text?: string;
  voice?: string;
  rate?: number;
  buffer?: Promise<AudioBuffer | null>;
  system?: boolean;
}

export class Speaker {
  private queue: Item[] = [];
  private running = false;
  private gen = 0;
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private timeBuf: Float32Array<ArrayBuffer> | null = null;
  private sources = new Set<AudioBufferSourceNode>();
  /** AudioContext time the scheduled audio runs until */
  private until = 0;
  private stopSystem: (() => void) | null = null;
  private mode: 'none' | 'system' | 'audio' = 'none';
  private utterances: SpeechSynthesisUtterance[] = [];
  /** utterances whose first sound was reported */
  private heard = new Set<string>();
  /** the utterance being played and whether its end marker arrived */
  private openUtt: string | undefined;
  private onDone: (utt?: string) => void;
  private onTiming: (t: SpeechTiming) => void;

  constructor(onDone: (utt?: string) => void, onTiming: (t: SpeechTiming) => void = () => undefined) {
    this.onDone = onDone;
    this.onTiming = onTiming;
  }

  get active(): boolean {
    return this.running;
  }

  speak(cmd: SpeakCommand): void {
    const utt = cmd.utt;
    const more = !!cmd.more;
    const item: Item = { utt, more, end: cmd.mode === 'end' || !more };
    if (cmd.mode === 'end') {
      // nothing to play; just closes the utterance
    } else if (cmd.mode === 'system') {
      Object.assign(item, { text: cmd.text, voice: cmd.voice, rate: cmd.rate, system: true });
    } else if (cmd.mode === 'kokoro') {
      item.text = cmd.text;
      item.rate = cmd.rate;
      // start synthesising now: it runs while earlier sentences play
      if (kokoro.ready) {
        const ctx = this.ensureCtx();
        const t0 = performance.now();
        item.buffer = kokoro
          .say(cmd.text, cmd.voice, cmd.rate || 1)
          .then(({ pcm, rate, ms }) => {
            const buf = ctx.createBuffer(1, pcm.length, rate);
            buf.copyToChannel(pcm as Float32Array<ArrayBuffer>, 0);
            if (!this.heard.has(utt ?? '')) this.onTiming({ utt, kind: 'kokoro', ms, note: `kokoro ${Math.round(performance.now() - t0)}ms for ${(pcm.length / rate).toFixed(1)}s` });
            return buf;
          })
          .catch((e: unknown) => {
            console.warn('[speech] kokoro failed, using the system voice:', e);
            return null;
          });
      } else {
        // not loaded yet (first use: downloading) or broken: the system voice says it this time
        if (kokoro.status.state === 'idle' || (kokoro.status.state === 'error' && Date.now() - kokoro.failedAt > 60_000)) kokoro.preload();
        item.system = true;
      }
    } else if (cmd.mode === 'pcm') {
      const ctx = this.ensureCtx();
      item.buffer = Promise.resolve(pcmBuffer(ctx, cmd.data, cmd.sampleRate));
    } else {
      const ctx = this.ensureCtx();
      item.buffer = ctx.decodeAudioData(cmd.data.slice(0)).catch(() => null);
    }
    this.queue.push(item);
    if (!this.running) void this.run();
  }

  stop(): void {
    const wasActive = this.running;
    const utt = this.openUtt;
    this.gen++;
    this.queue = [];
    for (const s of this.sources) {
      try {
        s.onended = null;
        s.stop();
        s.disconnect();
      } catch {
        /* already stopped */
      }
    }
    this.sources.clear();
    this.until = 0;
    this.stopSystem?.();
    this.stopSystem = null;
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    this.utterances = [];
    this.running = false;
    this.mode = 'none';
    this.openUtt = undefined;
    if (wasActive) this.onDone(utt);
  }

  /** 0..1 loudness of what is being spoken right now (synthetic for system voices). */
  level(nowMs: number): number {
    if (this.mode === 'audio' && this.analyser && this.timeBuf) {
      this.analyser.getFloatTimeDomainData(this.timeBuf);
      let sum = 0;
      for (let i = 0; i < this.timeBuf.length; i++) sum += this.timeBuf[i]! * this.timeBuf[i]!;
      return Math.min(1, Math.sqrt(sum / this.timeBuf.length) * 4);
    }
    if (this.mode === 'system') {
      const t = nowMs / 1000;
      return 0.35 + 0.3 * Math.abs(Math.sin(t * 7.3) * Math.sin(t * 2.1));
    }
    return 0;
  }

  private firstSound(utt: string | undefined): void {
    const key = utt ?? '';
    if (this.heard.has(key)) return;
    this.heard.add(key);
    if (this.heard.size > 50) this.heard.delete(this.heard.values().next().value as string);
    this.onTiming({ utt, kind: 'first-audio' });
  }

  private async run(): Promise<void> {
    this.running = true;
    const my = this.gen;
    let ended = false;
    for (;;) {
      if (my !== this.gen) return;
      const item = this.queue.shift();
      if (!item) {
        if (ended) break;
        // the utterance isn't over: wait for its next sentence
        await new Promise<void>((r) => {
          const check = () => (this.queue.length || my !== this.gen ? r() : setTimeout(check, 15));
          check();
        });
        continue;
      }
      this.openUtt = item.utt;
      try {
        if (item.buffer) {
          const buf = await item.buffer;
          if (my !== this.gen) return;
          if (buf) {
            await this.schedule(buf, item.utt, my);
          } else if (item.text) {
            await this.drain(my);
            await this.playSystem(item.text, '', item.rate ?? 1, item.utt, my);
          }
        } else if (item.system && item.text) {
          await this.drain(my);
          await this.playSystem(item.text, item.voice ?? '', item.rate ?? 1, item.utt, my);
        }
      } catch (e) {
        console.warn('[overlay] speech failed', e);
      }
      // a one-shot piece or an `end` marker closes the utterance once everything has played
      if (item.end) {
        ended = true;
        break;
      }
    }
    await this.drain(my);
    if (my !== this.gen) return; // stop() already reported done
    const utt = this.openUtt;
    this.running = false;
    this.mode = 'none';
    this.openUtt = undefined;
    this.onDone(utt);
    if (this.queue.length) void this.run();
  }

  /** Wait until the scheduled audio has played. */
  private async drain(my: number): Promise<void> {
    const ctx = this.ctx;
    while (ctx && my === this.gen && this.sources.size) {
      const left = Math.max(0, this.until - ctx.currentTime);
      await new Promise((r) => setTimeout(r, Math.min(250, left * 1000 + 20)));
      // a suspended context never advances: don't hang forever
      if (ctx.state !== 'running' && left > 0) {
        await Promise.race([ctx.resume().catch(() => undefined), new Promise((r) => setTimeout(r, 1000))]);
        if ((ctx.state as string) !== 'running') break;
      }
    }
  }

  private ensureCtx(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 512;
      this.timeBuf = new Float32Array(this.analyser.fftSize);
      this.analyser.connect(this.ctx.destination);
    }
    return this.ctx;
  }

  /** Queue a buffer right after what's already scheduled (gapless). */
  private async schedule(buf: AudioBuffer, utt: string | undefined, my: number): Promise<void> {
    const ctx = this.ensureCtx();
    // bounded like the mic's resume: a resume() that never settles would wedge the queue
    if (ctx.state !== 'running') {
      await Promise.race([ctx.resume().catch(() => undefined), new Promise((r) => setTimeout(r, 1000))]);
    }
    if (my !== this.gen) return;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.analyser!);
    const at = Math.max(ctx.currentTime + 0.01, this.until);
    this.until = at + buf.duration;
    this.sources.add(src);
    src.onended = () => {
      this.sources.delete(src);
      try {
        src.disconnect();
      } catch {
        /* gone */
      }
    };
    this.mode = 'audio';
    src.start(at);
    const startsIn = (at - ctx.currentTime) * 1000;
    if (startsIn <= 30) this.firstSound(utt);
    else setTimeout(() => my === this.gen && this.firstSound(utt), startsIn);
    // keep at most ~1.5 s scheduled ahead so stop() stays cheap and the level meter follows
    while (my === this.gen && this.until - ctx.currentTime > 1.5 && ctx.state === 'running') {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  private async playSystem(text: string, voiceName: string, rate: number, utt: string | undefined, my: number): Promise<void> {
    if (!('speechSynthesis' in window)) return;
    const voices = await voicesReady();
    if (my !== this.gen) return;
    const voice = (voiceName && (voices.find((v) => v.name === voiceName) ?? voices.find((v) => v.voiceURI === voiceName))) || bestVoice(voices);
    const r = Math.min(2, Math.max(0.5, rate || 1));
    this.mode = 'system';
    for (const piece of splitSentences(text)) {
      if (my !== this.gen) return;
      await new Promise<void>((resolve) => {
        const u = new SpeechSynthesisUtterance(piece);
        if (voice) {
          u.voice = voice;
          u.lang = voice.lang;
        }
        u.rate = r;
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(guard);
          this.utterances = this.utterances.filter((x) => x !== u);
          resolve();
        };
        // safety net: some engines never fire onend (or have no voices at all)
        const guard = setTimeout(finish, Math.max(voices.length ? 5000 : 300, voices.length ? (piece.length * 140) / r + 2000 : 0));
        u.onstart = () => this.firstSound(utt);
        u.onend = finish;
        u.onerror = finish;
        this.stopSystem = finish;
        this.utterances.push(u);
        speechSynthesis.speak(u);
      });
    }
  }
}

/** int16 little-endian mono → AudioBuffer */
function pcmBuffer(ctx: AudioContext, data: ArrayBuffer, rate: number): AudioBuffer | null {
  const n = Math.floor(data.byteLength / 2);
  if (!n) return null;
  const view = new DataView(data);
  const buf = ctx.createBuffer(1, n, rate);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < n; i++) ch[i] = view.getInt16(i * 2, true) / 0x8000;
  return buf;
}
