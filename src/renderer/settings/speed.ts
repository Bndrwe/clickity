// settings › voice "speed" summary (what the pipeline is, about how long until the first words,
// one-click "make it fast" with the keys already saved) and the about › diagnostics latency line
// (the last voice turn's per-stage breakdown).
import type { LatencyInfo } from '../../shared/ipc';
import type { TurnTiming } from '../../shared/types';
import type { ExtrasCtx } from './extras';

const api = window.clicky;
const $ = (id: string): HTMLElement | null => document.getElementById(id);

const secs = (ms: number): string => (ms < 1000 ? `${Math.round(ms / 10) * 10} ms` : `${(ms / 1000).toFixed(1)} s`);

function breakdown(t: TurnTiming): string {
  const parts: string[] = [];
  const add = (label: string, v: number | null) => {
    if (v !== null) parts.push(`${label} ${secs(v)}`);
  };
  add('transcript', t.transcript);
  add('screenshot', t.screenshot);
  add('first token', t.firstToken);
  add('first words', t.firstAudio);
  add('done', t.done);
  return parts.join(' · ');
}

export function initSpeed(ctx: ExtrasCtx): void {
  const pipeline = $('speed-pipeline');
  if (!pipeline) return; // older settings.html
  const estimate = $('speed-estimate')!;
  const fastBtn = $('speed-fast')!;
  const note = $('speed-note')!;
  const hints = $('speed-hints')!;
  const line = $('latency-line');
  const what = $('latency-what');
  const sw = $('sw-fast-replies');
  let info: LatencyInfo | null = null;

  const render = (): void => {
    if (!info) return;
    pipeline.textContent = info.pipeline;
    const last = info.last?.firstAudio ?? null;
    estimate.textContent = `about ${secs(info.estimateMs)} from letting go to the first words${last !== null ? ` · last turn: ${secs(last)}` : ''}${info.kokoro && info.kokoro !== 'ready' && !/^ready/.test(info.kokoro) ? ` · natural voice: ${info.kokoro}` : ''}`;
    fastBtn.hidden = !info.fastest;
    note.textContent = info.fastest ? info.fastestNote : 'already as fast as your keys allow.';
    hints.textContent = info.hints.length ? `faster with a key: ${info.hints.join('; ')}.` : '';
    hints.hidden = !info.hints.length;
    if (line && info.last) {
      line.textContent = breakdown(info.last);
      if (what) what.textContent = `turn ${info.last.turnId}, measured from letting go of the key · ${[info.last.stt, info.last.model, info.last.tts && `voice ${info.last.tts}`].filter(Boolean).join(' · ')}${info.last.notes.length ? ` · ${info.last.notes.join('; ')}` : ''}`;
    }
  };
  const refresh = async (): Promise<void> => {
    try {
      info = await api.latency();
      render();
    } catch {
      /* main not ready */
    }
  };

  fastBtn.addEventListener('click', async () => {
    if (!info?.fastest) return;
    await ctx.save(info.fastest);
    ctx.flash(fastBtn, 'done');
    await refresh();
  });
  if (sw) {
    sw.addEventListener('click', () => {
      const on = ctx.get().speech.fastReplies === false;
      sw.setAttribute('aria-checked', String(on));
      void ctx.save({ speech: { fastReplies: on } }).then(refresh);
    });
  }
  ctx.sync(() => {
    sw?.setAttribute('aria-checked', String(ctx.get().speech.fastReplies !== false));
    void refresh();
  });
  // a voice turn may finish while settings is open
  window.addEventListener('focus', () => void refresh());
  setInterval(() => {
    if (!document.hidden) void refresh();
  }, 5000);
  void refresh();
}
