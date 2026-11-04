// Mic capture (AudioWorklet with ScriptProcessor fallback), resampling and WAV encoding.

const WORKLET_SRC = `
class ClickyCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(4096);
    this.n = 0;
    this.port.onmessage = (e) => {
      if (e.data === 'flush') {
        if (this.n > 0) this.port.postMessage(this.buf.slice(0, this.n));
        this.n = 0;
        this.port.postMessage('flushed');
      }
    };
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      let i = 0;
      while (i < ch.length) {
        const take = Math.min(ch.length - i, this.buf.length - this.n);
        this.buf.set(ch.subarray(i, i + take), this.n);
        this.n += take;
        i += take;
        if (this.n === this.buf.length) {
          this.port.postMessage(this.buf.slice(0));
          this.n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('clicky-capture', ClickyCapture);
`;

let workletUrl: string | null = null;

export interface Recording {
  pcm: Float32Array;
  sampleRate: number;
  /** AudioContext state when stopped ('suspended' = the audio engine never ran) */
  contextState?: string;
}

/** Loudest absolute sample, 0..1. */
export function peakLevel(pcm: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < pcm.length; i++) {
    const v = Math.abs(pcm[i]!);
    if (v > peak) peak = v;
  }
  return peak;
}

const isMac = /Mac/i.test(navigator.platform || navigator.userAgent);
const isWin = /Win/i.test(navigator.platform || navigator.userAgent);

/** Short, actionable message for a getUserMedia failure. */
export function micErrorMessage(e: unknown): string {
  const name = (e as { name?: string } | null)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
    if (isMac) return 'microphone blocked — allow clickity in system settings › privacy & security › microphone, then restart it';
    if (isWin) return 'microphone blocked — allow microphone access in windows settings › privacy › microphone';
    return 'microphone blocked — allow microphone access for clickity';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') {
    return 'no microphone found — plug one in or pick an input in your sound settings';
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') return 'microphone is busy — another app may be using it';
  if (name === 'AbortError') return 'microphone failed to start — try again';
  const msg = e instanceof Error ? e.message : '';
  return `microphone unavailable${msg ? `: ${msg.toLowerCase().slice(0, 80)}` : ''}`;
}

/** What the recorder is actually using (for clickity.log). */
export interface MicInfo {
  device: string;
  sampleRate: number;
  contextState: string;
  capture: 'worklet' | 'script';
}

/** One recording at a time. The mic stream is released after every stop/cancel. */
export class MicRecorder {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private nodes: AudioNode[] = [];
  private worklet: AudioWorkletNode | null = null;
  private analyser: AnalyserNode | null = null;
  private freq: Uint8Array<ArrayBuffer> | null = null;
  private chunks: Float32Array[] = [];
  private sampleRate = 48000;
  private gen = 0;
  private starting: Promise<void> | null = null;
  private startError: Error | null = null;
  private info: MicInfo | null = null;

  get active(): boolean {
    return this.starting !== null;
  }

  /** Details of the open recording (null until the mic has started). */
  get details(): MicInfo | null {
    return this.info;
  }

  start(): Promise<void> {
    this.release();
    const my = ++this.gen;
    this.chunks = [];
    this.startError = null;
    this.info = null;
    this.starting = this.open(my).catch((e: unknown) => {
      if (my === this.gen) this.startError = new Error(micErrorMessage(e));
      this.release();
      throw this.startError ?? e;
    });
    // callers may not await start; avoid unhandled-rejection noise
    this.starting.catch(() => undefined);
    return this.starting;
  }

  private async open(my: number): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    if (my !== this.gen) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    this.stream = stream;
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.sampleRate = ctx.sampleRate;
    // The overlay is never focused and the hotkey happens outside the page, so the context can
    // start suspended (autoplay policy). resume() can also hang in a background window: bound it.
    if (ctx.state !== 'running') {
      await Promise.race([ctx.resume().catch(() => undefined), new Promise((r) => setTimeout(r, 1000))]);
    }

    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.6;
    source.connect(analyser);
    this.analyser = analyser;
    this.freq = new Uint8Array(analyser.frequencyBinCount);

    // silent sink keeps the capture node pulled by the graph
    const sink = ctx.createGain();
    sink.gain.value = 0;
    sink.connect(ctx.destination);
    this.nodes.push(source, analyser, sink);

    let node: AudioNode | null = null;
    if (ctx.audioWorklet) {
      try {
        workletUrl ??= URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
        await ctx.audioWorklet.addModule(workletUrl);
        if (my !== this.gen) return;
        const w = new AudioWorkletNode(ctx, 'clicky-capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
        w.port.onmessage = (e: MessageEvent) => {
          if (e.data instanceof Float32Array) this.chunks.push(e.data);
        };
        this.worklet = w;
        node = w;
      } catch {
        node = null;
      }
    }
    if (!node) {
      const sp = ctx.createScriptProcessor(4096, 1, 1);
      sp.onaudioprocess = (e) => {
        this.chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      };
      node = sp;
    }
    source.connect(node);
    node.connect(sink);
    this.nodes.push(node);
    if (ctx.state !== 'running') void ctx.resume().catch(() => undefined);
    this.info = {
      device: stream.getAudioTracks()[0]?.label || 'default',
      sampleRate: ctx.sampleRate,
      contextState: ctx.state,
      capture: this.worklet ? 'worklet' : 'script',
    };
  }

  /** Fills `out` with 0..1 levels for a few voice-range bands. */
  bands(out: Float32Array): void {
    if (!this.analyser || !this.freq) {
      out.fill(0);
      return;
    }
    this.analyser.getByteFrequencyData(this.freq);
    const n = out.length;
    // bins ~ 190 Hz each at 48k/256; use roughly 200 Hz – 3.5 kHz
    const lo = 1;
    const hi = Math.min(this.freq.length, 20);
    const per = (hi - lo) / n;
    for (let b = 0; b < n; b++) {
      let sum = 0;
      let c = 0;
      for (let i = Math.floor(lo + b * per); i < Math.floor(lo + (b + 1) * per); i++) {
        sum += this.freq[i]!;
        c++;
      }
      out[b] = c ? Math.min(1, (sum / c / 255) * 1.6) : 0;
    }
  }

  async stop(): Promise<Recording> {
    const starting = this.starting;
    if (!starting) throw new Error('not recording');
    try {
      await starting;
    } catch (e) {
      this.starting = null;
      throw e;
    }
    if (this.worklet) {
      const w = this.worklet;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 200);
        const prev = w.port.onmessage;
        w.port.onmessage = (e: MessageEvent) => {
          if (e.data === 'flushed') {
            clearTimeout(timer);
            resolve();
          } else prev?.call(w.port, e);
        };
        w.port.postMessage('flush');
      });
    }
    const rec: Recording = { pcm: concat(this.chunks), sampleRate: this.sampleRate, contextState: this.ctx?.state ?? 'closed' };
    this.release();
    return rec;
  }

  cancel(): void {
    this.gen++;
    this.release();
  }

  private release(): void {
    for (const n of this.nodes) {
      try {
        n.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    this.nodes = [];
    if (this.worklet) this.worklet.port.onmessage = null;
    this.worklet = null;
    this.analyser = null;
    this.freq = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.starting = null;
    this.chunks = [];
  }
}

function concat(chunks: Float32Array[]): Float32Array {
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Float32Array(len);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/** Resample mono PCM to 16 kHz. Uses OfflineAudioContext (proper filtering), with a box-filter fallback. */
export async function resampleTo16k(pcm: Float32Array, rate: number): Promise<Float32Array> {
  const target = 16000;
  if (rate === target || pcm.length === 0) return pcm;
  const outLen = Math.max(1, Math.round((pcm.length * target) / rate));
  try {
    const off = new OfflineAudioContext(1, outLen, target);
    const buf = off.createBuffer(1, pcm.length, rate);
    buf.copyToChannel(new Float32Array(pcm), 0);
    const src = off.createBufferSource();
    src.buffer = buf;
    src.connect(off.destination);
    src.start();
    const rendered = await off.startRendering();
    return rendered.getChannelData(0).slice(0);
  } catch {
    const ratio = rate / target;
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const a = Math.floor(i * ratio);
      const b = Math.min(pcm.length, Math.max(a + 1, Math.floor((i + 1) * ratio)));
      let s = 0;
      for (let j = a; j < b; j++) s += pcm[j]!;
      out[i] = s / (b - a);
    }
    return out;
  }
}

/** 16-bit PCM mono WAV. */
export function encodeWav(pcm: Float32Array, sampleRate: number): ArrayBuffer {
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  v.setUint32(4, 36 + pcm.length * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, pcm.length * 2, true);
  let o = 44;
  for (let i = 0; i < pcm.length; i++, o += 2) {
    const s = Math.max(-1, Math.min(1, pcm[i]!));
    v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}
