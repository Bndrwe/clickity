// Web Worker running Kokoro-82M (kokoro-js on transformers.js): a free, natural-sounding voice
// that runs on-device. WebGPU when an adapter is available, else wasm (q8). The model (~90 MB)
// downloads once from the HF hub into the Cache API, with progress.
// Protocol (speech.ts is the other side):
//   in:  { type: 'load' } | { type: 'say', id, text, voice, speed }
//   out: { type: 'status', state: 'downloading' | 'loading' | 'ready' | 'error', progress?, device?, ms?, message? }
//        | { type: 'audio', id, pcm: Float32Array, rate, ms } | { type: 'error', id, message }
import { env } from '@huggingface/transformers';
import { KokoroTTS } from 'kokoro-js';

env.allowLocalModels = false;
try {
  env.useBrowserCache = typeof caches !== 'undefined';
} catch {
  env.useBrowserCache = false;
}
// multi-threaded wasm when SharedArrayBuffer is available (main enables it for our file:// pages;
// onnxruntime would otherwise drop to 1 thread because the page isn't cross-origin isolated)
try {
  const wasm = (env.backends as { onnx?: { wasm?: { numThreads?: number } } }).onnx?.wasm;
  if (wasm && typeof SharedArrayBuffer !== 'undefined') wasm.numThreads = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
} catch {
  /* single-threaded */
}

const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const ctx = self as unknown as { postMessage(m: unknown, transfer?: Transferable[]): void; onmessage: ((e: MessageEvent) => void) | null };

type Device = 'webgpu' | 'wasm';
let loading: Promise<{ tts: KokoroTTS; device: Device }> | null = null;

async function webgpuUsable(): Promise<boolean> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (!gpu) return false;
  try {
    return !!(await Promise.race([gpu.requestAdapter(), new Promise((r) => setTimeout(() => r(null), 3000))]));
  } catch {
    return false;
  }
}

function load(): Promise<{ tts: KokoroTTS; device: Device }> {
  if (loading) return loading;
  loading = (async () => {
    const t0 = performance.now();
    ctx.postMessage({ type: 'status', state: 'loading' });
    let lastPct = -1;
    const progress_callback = (p: { status?: string; progress?: number }) => {
      if (p.status === 'progress_total' && typeof p.progress === 'number') {
        const pct = Math.max(0, Math.min(100, Math.floor(p.progress)));
        if (pct !== lastPct && pct < 100) ctx.postMessage({ type: 'status', state: 'downloading', progress: pct });
        lastPct = pct;
      }
    };
    const devices: Device[] = (await webgpuUsable()) ? ['webgpu', 'wasm'] : ['wasm'];
    let lastErr: unknown = null;
    for (const device of devices) {
      try {
        const tts = await KokoroTTS.from_pretrained(MODEL, { dtype: device === 'webgpu' ? 'fp32' : 'q8', device, progress_callback } as never);
        // warm-up: compiles the graph, and a broken backend fails here instead of on a reply
        await tts.generate('hi.', { voice: 'af_heart' as never });
        ctx.postMessage({ type: 'status', state: 'ready', device, ms: Math.round(performance.now() - t0) });
        return { tts, device };
      } catch (e) {
        lastErr = e;
        console.warn(`[tts-worker] kokoro on ${device} failed:`, e);
      }
    }
    throw lastErr ?? new Error('no backend');
  })().catch((e: unknown) => {
    loading = null;
    ctx.postMessage({ type: 'status', state: 'error', message: (e instanceof Error ? e.message : String(e)).split('\n')[0]!.slice(0, 160).toLowerCase() });
    throw e;
  });
  return loading;
}

// one sentence at a time, in order (the overlay queues them ahead while one plays)
let chain: Promise<void> = Promise.resolve();

ctx.onmessage = (e: MessageEvent) => {
  const m = e.data as { type: string; id?: number; text?: string; voice?: string; speed?: number };
  if (m.type === 'load') {
    load().catch(() => undefined);
    return;
  }
  if (m.type === 'say' && m.text) {
    chain = chain.then(async () => {
      try {
        const { tts } = await load();
        const t0 = performance.now();
        const voice = (m.voice && m.voice in tts.voices ? m.voice : 'af_heart') as never;
        const out = await tts.generate(m.text!, { voice, speed: Math.min(1.6, Math.max(0.6, m.speed ?? 1)) });
        const pcm = out.audio as Float32Array;
        ctx.postMessage({ type: 'audio', id: m.id, pcm, rate: out.sampling_rate, ms: Math.round(performance.now() - t0) }, [pcm.buffer]);
      } catch (err) {
        ctx.postMessage({ type: 'error', id: m.id, message: err instanceof Error ? err.message : String(err) });
      }
    });
  }
};
