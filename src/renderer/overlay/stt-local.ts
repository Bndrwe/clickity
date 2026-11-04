// On-device whisper via transformers.js, running inside the overlay renderer.
// Bundled into the overlay IIFE by esbuild (resolves to transformers.web.js); the onnxruntime
// wasm binaries are fetched from jsdelivr at first use, model weights from the HF hub (browser-cached).
import { env, pipeline } from '@huggingface/transformers';

env.allowLocalModels = false;
env.allowRemoteModels = true;
env.useBrowserCache = true;

type Asr = (audio: Float32Array, opts?: Record<string, unknown>) => Promise<{ text?: string } | Array<{ text?: string }>>;

const pipelines = new Map<string, Promise<Asr>>();

function load(model: string): Promise<Asr> {
  let p = pipelines.get(model);
  if (!p) {
    const gpu = typeof navigator !== 'undefined' && !!(navigator as Navigator & { gpu?: unknown }).gpu;
    const create = (device: 'webgpu' | 'wasm') =>
      (pipeline as unknown as (task: string, model: string, opts: Record<string, unknown>) => Promise<Asr>)(
        'automatic-speech-recognition', model,
        device === 'webgpu'
          ? { device: 'webgpu', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' } }
          : { device: 'wasm', dtype: 'q8' },
      );
    p = (gpu ? create('webgpu').catch(() => create('wasm')) : create('wasm')).catch((e) => {
      pipelines.delete(model); // allow retry
      throw e;
    });
    pipelines.set(model, p);
  }
  return p;
}

/** Start downloading / warming a model in the background. Errors are swallowed (retried on use). */
export function preloadLocalModel(model: string): void {
  if (!model) return;
  load(model).catch((e) => console.warn('[stt-local] preload failed:', e));
}

const HALLUCINATIONS = [
  /^\[?\s*blank[_ ]audio\s*\]?$/i,
  /^[\[(]\s*(silence|music|noise|applause|inaudible|no speech)\s*[\])]$/i,
  /^[♪\s.]*$/,
  /^(thanks? for watching[.!]?|thank you for watching[.!]?|you|bye[.!]?)$/i,
];

export async function transcribeLocal(pcm16k: Float32Array, model: string, language?: string): Promise<string> {
  const seconds = pcm16k.length / 16000;
  if (seconds < 0.25) return '';
  const asr = await load(model);
  const opts: Record<string, unknown> = { task: 'transcribe' };
  if (!/\.en$/i.test(model) && language && language.trim()) opts.language = language.trim().toLowerCase();
  if (seconds > 28) { opts.chunk_length_s = 30; opts.stride_length_s = 5; }
  const out = await asr(pcm16k, opts);
  const text = (Array.isArray(out) ? out.map((o) => o.text ?? '').join(' ') : out.text ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (HALLUCINATIONS.some((r) => r.test(text))) return '';
  if (seconds < 0.6 && /^thank you[.!]?$/i.test(text)) return '';
  return text;
}
