// Web Worker running on-device whisper (stt-engine.ts) off the overlay's UI thread.
// Protocol (stt-local.ts is the other side):
//   in:  { type: 'load', model } | { type: 'transcribe', id, model, language?, pcm: Float32Array }
//   out: { type: 'status', status: LocalSttStatus } | { type: 'result', id, text, ms, device? }
//        | { type: 'error', id, message, load: boolean } | { type: 'ready' }
import { ModelLoadError, loadedDevice, onLocalSttStatus, preloadLocalModel, transcribeLocal } from './stt-engine';

const ctx = self as unknown as { postMessage(m: unknown): void; onmessage: ((e: MessageEvent) => void) | null };

onLocalSttStatus((status) => ctx.postMessage({ type: 'status', status }));

ctx.onmessage = (e: MessageEvent) => {
  const m = e.data as { type: string; id?: number; model?: string; language?: string; pcm?: Float32Array };
  if (m.type === 'load' && m.model) {
    preloadLocalModel(m.model);
    return;
  }
  if (m.type === 'transcribe' && m.model && m.pcm) {
    const t0 = performance.now();
    transcribeLocal(m.pcm, m.model, m.language)
      .then((text) => ctx.postMessage({ type: 'result', id: m.id, text, ms: Math.round(performance.now() - t0), device: loadedDevice(m.model!) }))
      .catch((err: unknown) =>
        ctx.postMessage({ type: 'error', id: m.id, message: err instanceof Error ? err.message : String(err), load: err instanceof ModelLoadError }),
      );
  }
};
ctx.postMessage({ type: 'ready' });
