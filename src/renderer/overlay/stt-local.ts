// On-device whisper for the overlay: runs in a Web Worker (stt-worker.js) so loading the model
// and transcribing never freeze the companion; the model stays loaded (warm) between turns.
// If the worker can't start, the same engine runs on this thread (stt-engine.ts).
import * as engine from './stt-engine';
import type { LocalSttStatus } from './stt-engine';

export type { LocalSttStatus } from './stt-engine';
export { ModelLoadError } from './stt-engine';

type Listener = (s: LocalSttStatus) => void;
const listeners = new Set<Listener>();
const status = new Map<string, LocalSttStatus>();

function emit(s: LocalSttStatus): void {
  status.set(s.model, s);
  for (const l of listeners) {
    try {
      l(s);
    } catch {
      /* listener bug */
    }
  }
}
engine.onLocalSttStatus(emit); // fallback path reports here directly

export function onLocalSttStatus(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function localSttStatus(model: string): LocalSttStatus | undefined {
  return status.get(model);
}

interface Pending {
  resolve(r: { text: string; ms: number; device?: string }): void;
  reject(e: Error): void;
}
let worker: Worker | null = null;
let workerBroken = false;
let seq = 0;
const pending = new Map<number, Pending>();

function getWorker(): Worker | null {
  if (worker || workerBroken) return worker;
  try {
    const w = new Worker('stt-worker.js');
    w.onmessage = (e: MessageEvent) => {
      const m = e.data as { type: string; id: number; status?: LocalSttStatus; text?: string; ms?: number; device?: string; message?: string; load?: boolean };
      if (m.type === 'status' && m.status) emit(m.status);
      else if (m.type === 'result') {
        pending.get(m.id)?.resolve({ text: m.text ?? '', ms: m.ms ?? 0, device: m.device });
        pending.delete(m.id);
      } else if (m.type === 'error') {
        const p = pending.get(m.id);
        pending.delete(m.id);
        p?.reject(m.load ? new engine.ModelLoadError(m.message ?? 'load failed') : new Error(m.message ?? 'transcription failed'));
      }
    };
    w.onerror = (e) => {
      console.warn('[stt-local] worker failed, transcribing on the overlay thread:', e.message);
      workerBroken = true;
      worker = null;
      for (const p of pending.values()) p.reject(new Error('worker failed'));
      pending.clear();
    };
    worker = w;
  } catch (e) {
    console.warn('[stt-local] no worker:', e);
    workerBroken = true;
  }
  return worker;
}

export function preloadLocalModel(model: string): void {
  if (!model) return;
  const w = getWorker();
  if (w) w.postMessage({ type: 'load', model });
  else engine.preloadLocalModel(model);
}

/** Transcribe 16 kHz mono audio; resolves with the text, how long it took and the backend. */
export async function transcribeLocalTimed(pcm16k: Float32Array, model: string, language?: string): Promise<{ text: string; ms: number; device?: string }> {
  const w = getWorker();
  if (w) {
    try {
      return await new Promise((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject });
        const copy = pcm16k.slice();
        w.postMessage({ type: 'transcribe', id, model, language, pcm: copy }, [copy.buffer]);
      });
    } catch (e) {
      if (!workerBroken) throw e;
      // the worker died: fall through to this thread
    }
  }
  const t0 = performance.now();
  const text = await engine.transcribeLocal(pcm16k, model, language);
  return { text, ms: Math.round(performance.now() - t0), device: engine.loadedDevice(model) };
}

export async function transcribeLocal(pcm16k: Float32Array, model: string, language?: string): Promise<string> {
  return (await transcribeLocalTimed(pcm16k, model, language)).text;
}
