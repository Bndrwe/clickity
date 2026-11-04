// Plays SpeakCommands: system speechSynthesis (sentence-split) or encoded audio via Web Audio.
import type { SpeakCommand } from '../../shared/types';

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

export class Speaker {
  private queue: SpeakCommand[] = [];
  private running = false;
  private gen = 0;
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private timeBuf: Float32Array<ArrayBuffer> | null = null;
  private stopCurrent: (() => void) | null = null;
  private mode: 'none' | 'system' | 'audio' = 'none';
  /** keep utterances referenced so Chrome doesn't GC them before onend */
  private utterances: SpeechSynthesisUtterance[] = [];

  constructor(private onDone: () => void) {}

  get active(): boolean {
    return this.running;
  }

  speak(cmd: SpeakCommand): void {
    this.queue.push(cmd);
    if (!this.running) void this.run();
  }

  stop(): void {
    const wasActive = this.running;
    this.gen++;
    this.queue = [];
    this.stopCurrent?.();
    this.stopCurrent = null;
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    this.utterances = [];
    this.running = false;
    this.mode = 'none';
    if (wasActive) this.onDone();
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

  private async run(): Promise<void> {
    this.running = true;
    const my = this.gen;
    while (this.queue.length && my === this.gen) {
      const cmd = this.queue.shift()!;
      try {
        if (cmd.mode === 'system') await this.playSystem(cmd, my);
        else await this.playAudio(cmd, my);
      } catch (e) {
        console.warn('[overlay] speech failed', e);
      }
    }
    if (my !== this.gen) return; // stop() already reported done
    this.running = false;
    this.mode = 'none';
    this.stopCurrent = null;
    this.onDone();
  }

  private async playSystem(cmd: Extract<SpeakCommand, { mode: 'system' }>, my: number): Promise<void> {
    if (!('speechSynthesis' in window)) return;
    const voices = await voicesReady();
    if (my !== this.gen) return;
    const voice =
      (cmd.voice && (voices.find((v) => v.name === cmd.voice) ?? voices.find((v) => v.voiceURI === cmd.voice))) ||
      voices.find((v) => v.default) ||
      null;
    const rate = Math.min(2, Math.max(0.5, cmd.rate || 1));
    this.mode = 'system';
    for (const piece of splitSentences(cmd.text)) {
      if (my !== this.gen) return;
      await new Promise<void>((resolve) => {
        const u = new SpeechSynthesisUtterance(piece);
        if (voice) {
          u.voice = voice;
          u.lang = voice.lang;
        }
        u.rate = rate;
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(guard);
          this.utterances = this.utterances.filter((x) => x !== u);
          resolve();
        };
        // safety net: some engines never fire onend
        const guard = setTimeout(finish, Math.max(5000, (piece.length * 140) / rate + 2000));
        u.onend = finish;
        u.onerror = finish;
        this.stopCurrent = finish;
        this.utterances.push(u);
        speechSynthesis.speak(u);
      });
    }
  }

  private ensureCtx(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 512;
      this.timeBuf = new Float32Array(this.analyser.fftSize);
      this.analyser.connect(this.ctx.destination);
    }
    return this.ctx;
  }

  private async playAudio(cmd: Extract<SpeakCommand, { mode: 'audio' }>, my: number): Promise<void> {
    const ctx = this.ensureCtx();
    if (ctx.state !== 'running') await ctx.resume().catch(() => undefined);
    const analyser = this.analyser!;
    let decoded: AudioBuffer | null = null;
    try {
      decoded = await ctx.decodeAudioData(cmd.data.slice(0));
    } catch {
      decoded = null;
    }
    if (my !== this.gen) return;
    this.mode = 'audio';

    if (decoded) {
      const buf = decoded;
      await new Promise<void>((resolve) => {
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(analyser);
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          try {
            src.stop();
          } catch {
            /* not started / already stopped */
          }
          src.disconnect();
          resolve();
        };
        src.onended = finish;
        this.stopCurrent = finish;
        src.start();
      });
      return;
    }

    // fallback: let the media element decode (e.g. formats decodeAudioData rejects)
    const url = URL.createObjectURL(new Blob([cmd.data], { type: cmd.mime || 'audio/mpeg' }));
    const audio = new Audio(url);
    let node: MediaElementAudioSourceNode | null = null;
    try {
      node = ctx.createMediaElementSource(audio);
      node.connect(analyser);
    } catch {
      node = null;
    }
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        audio.pause();
        node?.disconnect();
        URL.revokeObjectURL(url);
        resolve();
      };
      audio.onended = finish;
      audio.onerror = finish;
      this.stopCurrent = finish;
      audio.play().catch(finish);
    });
  }
}
