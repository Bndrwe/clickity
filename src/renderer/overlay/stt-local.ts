// On-device whisper via transformers.js, running inside the overlay renderer.
// Bundled into the overlay IIFE by esbuild (resolves to transformers.web.js); the onnxruntime
// wasm binaries are fetched from jsdelivr at first use, model weights from the HF hub, and both
// are kept in the browser Cache API, so later launches work offline.
//
// Robustness notes (packaged macOS, file:// page):
//  - `navigator.gpu` can exist with no usable adapter → only pick webgpu when an adapter is
//    actually returned, and fall back to wasm if webgpu fails at load *or* at first inference.
//  - the first load downloads ~80 MB: progress is reported through onLocalSttStatus so the
//    companion can show "downloading the voice model… 42%".
import { env, pipeline } from '@huggingface/transformers';

env.allowLocalModels = false;
env.allowRemoteModels = true;
try {
  env.useBrowserCache = typeof caches !== 'undefined';
} catch {
  env.useBrowserCache = false;
}

type Asr = (audio: Float32Array, opts?: Record<string, unknown>) => Promise<{ text?: string } | Array<{ text?: string }>>;
type Device = 'webgpu' | 'wasm';

export type LocalSttStatus =
  | { state: 'downloading'; model: string; progress: number }
  | { state: 'loading'; model: string }
  | { state: 'ready'; model: string; device: Device; ms: number }
  | { state: 'error'; model: string; message: string };

type Listener = (s: LocalSttStatus) => void;
const listeners = new Set<Listener>();
const status = new Map<string, LocalSttStatus>();

/** Subscribe to load progress / readiness / failure of on-device models. */
export function onLocalSttStatus(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Latest known status of a model (undefined = never requested). */
export function localSttStatus(model: string): LocalSttStatus | undefined {
  return status.get(model);
}

function emit(s: LocalSttStatus): void {
  status.set(s.model, s);
  for (const l of listeners) {
    try {
      l(s);
    } catch {
      /* listener bug: never break loading */
    }
  }
}

interface Loaded {
  asr: Asr;
  device: Device;
}

const pipelines = new Map<string, Promise<Loaded>>();

async function webgpuUsable(): Promise<boolean> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (!gpu) return false;
  try {
    const adapter = await Promise.race([gpu.requestAdapter(), new Promise((r) => setTimeout(() => r(null), 3000))]);
    return !!adapter;
  } catch {
    return false;
  }
}

function create(model: string, device: Device): Promise<Asr> {
  let lastPct = -1;
  const progress_callback = (p: { status?: string; progress?: number; file?: string }) => {
    if (p.status === 'progress_total' && typeof p.progress === 'number') {
      const pct = Math.max(0, Math.min(100, Math.floor(p.progress)));
      if (pct !== lastPct) {
        lastPct = pct;
        // files already in the browser cache report 100% straight away: that's "loading", not a download
        emit(pct >= 100 ? { state: 'loading', model } : { state: 'downloading', model, progress: pct });
      }
    }
  };
  return (pipeline as unknown as (task: string, model: string, opts: Record<string, unknown>) => Promise<Asr>)(
    'automatic-speech-recognition',
    model,
    device === 'webgpu'
      ? { device: 'webgpu', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' }, progress_callback }
      : { device: 'wasm', dtype: 'q8', progress_callback },
  );
}

/** Tiny warm-up so a broken backend fails here (where we can fall back), not on the user's words. */
async function warmUp(asr: Asr): Promise<void> {
  await asr(new Float32Array(16000 / 2), {});
}

function englishOnly(model: string): boolean {
  return /\.en$/i.test(model);
}

function load(model: string): Promise<Loaded> {
  let p = pipelines.get(model);
  if (p) return p;
  p = (async (): Promise<Loaded> => {
    const t0 = performance.now();
    emit({ state: 'loading', model });
    let lastErr: unknown = null;
    const devices: Device[] = (await webgpuUsable()) ? ['webgpu', 'wasm'] : ['wasm'];
    for (const device of devices) {
      try {
        const asr = await create(model, device);
        if (device === 'webgpu') await warmUp(asr);
        const ms = Math.round(performance.now() - t0);
        emit({ state: 'ready', model, device, ms });
        return { asr, device };
      } catch (e) {
        lastErr = e;
        console.warn(`[stt-local] ${device} failed for ${model}:`, e);
      }
    }
    throw lastErr ?? new Error('no backend');
  })().catch((e: unknown) => {
    pipelines.delete(model); // allow retry on the next talk
    const msg = e instanceof Error ? e.message : String(e);
    emit({ state: 'error', model, message: msg.split('\n')[0].toLowerCase().slice(0, 160) });
    throw e;
  });
  pipelines.set(model, p);
  return p;
}

/** Start downloading / warming a model in the background. Errors are reported via status (retried on use). */
export function preloadLocalModel(model: string): void {
  if (!model) return;
  load(model).catch(() => undefined);
}

/** Thrown when the model itself could not be loaded (download / backend), as opposed to inference errors. */
export class ModelLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelLoadError';
  }
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
  let loaded: Loaded;
  try {
    loaded = await load(model);
  } catch (e) {
    throw new ModelLoadError(e instanceof Error ? e.message : String(e));
  }
  const opts: Record<string, unknown> = {};
  // English-only checkpoints (*.en) reject `task` / `language` outright ("cannot specify `task` or
  // `language` for an english-only model"): only multilingual models get them.
  if (!englishOnly(model)) {
    opts.task = 'transcribe';
    if (language && language.trim()) opts.language = language.trim().toLowerCase();
  }
  if (seconds > 28) {
    opts.chunk_length_s = 30;
    opts.stride_length_s = 5;
  }
  let out: Awaited<ReturnType<Asr>>;
  try {
    out = await loaded.asr(pcm16k, opts);
  } catch (e) {
    if (loaded.device !== 'webgpu') throw e;
    // webgpu died mid-session (device lost, driver hiccup): rebuild on wasm and retry once
    console.warn('[stt-local] webgpu inference failed, retrying on wasm:', e);
    const wasm = create(model, 'wasm').then((asr) => ({ asr, device: 'wasm' as Device }));
    pipelines.set(model, wasm);
    out = await (await wasm).asr(pcm16k, opts);
  }
  const text = (Array.isArray(out) ? out.map((o) => o.text ?? '').join(' ') : out.text ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (HALLUCINATIONS.some((r) => r.test(text))) return '';
  if (seconds < 0.6 && /^thank you[.!]?$/i.test(text)) return '';
  return text;
}
