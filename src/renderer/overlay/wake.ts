// Wake word listener ("hey clickity"), overlay side. Self-contained like extras.ts: a continuous
// mic → energy voice-activity gate → for each short voiced segment (rate capped by WakeGate),
// transcribe the first ~2.4 s on-device and look for the wake word (src/shared/wake.ts). A match
// is sent to main (wake-word.ts) with the whole segment's transcript; nothing else ever leaves
// this window, and transcripts that don't match are dropped without being logged.
//
// Indicator: a small hollow ring beside the companion while armed; it fills while a segment is
// being checked and while waiting for the question after a bare "hey clickity".
import type { OverlayApi } from '../../shared/ipc';
import type { WakeState, WakeStatus } from '../../shared/types';
import { EnergyVad, rmsOf } from '../../shared/vad';
import { WAKE_HEAD_MS, WAKE_TUNING, WakeGate, matchWake } from '../../shared/wake';
import { MicRecorder, encodeWav, peakLevel, resampleTo16k } from './audio';
import { localSttStatus, onLocalSttStatus, preloadLocalModel, transcribeLocalTimed } from './stt-local';

const api: OverlayApi = window.overlay;

const css = `
.wk-ring {
  position: absolute; left: calc(11px * var(--s)); top: calc(20px * var(--s));
  width: 7px; height: 7px; border-radius: 50%; box-sizing: border-box;
  border: 1.25px solid var(--buddy, var(--ink-muted)); background: transparent;
  opacity: 0; transform: scale(.6); transition: opacity .5s var(--ease), transform .5s var(--ease), background-color .3s var(--ease);
}
html[data-wake=armed] .wk-ring { opacity: .55; transform: none; }
html[data-wake=checking] .wk-ring { opacity: .9; transform: none; background: color-mix(in srgb, var(--buddy, var(--ink)) 40%, transparent); }
html[data-wake=follow] .wk-ring { opacity: 1; transform: none; background: var(--buddy, var(--ink)); animation: wk-breathe 1.6s var(--ease-soft) infinite; }
html[data-wake=blocked] .wk-ring { opacity: .5; transform: none; border-style: dashed; }
@keyframes wk-breathe { 0%,100% { transform: scale(.9) } 50% { transform: scale(1.15) } }
@media (prefers-reduced-motion: reduce) { .wk-ring { transition: none; animation: none !important; } }
`;
const style = document.createElement('style');
style.textContent = css;
document.head.append(style);

const root = document.documentElement;
const ring = document.createElement('i');
ring.className = 'wk-ring';
ring.setAttribute('aria-hidden', 'true');
document.getElementById('companion')?.append(ring);

function log(level: 'info' | 'warn' | 'error', message: string): void {
  try {
    api.log({ level, message: `wake: ${message}` });
  } catch {
    /* tests */
  }
}

const mic = new MicRecorder();
const gate = new WakeGate();
let vad = new EnergyVad({ threshold: WAKE_TUNING.medium.vadThreshold, minSpeechMs: 300, silenceMs: 700, maxMs: 20_000 });
let st: WakeState | null = null;
let running = false;
let loop = 0;
let clock = 0;
let checking = false;
let preroll: Float32Array[] = [];
let utter: Float32Array[] = [];
let sensitivity = '';
let micError = '';
let micFailedAt = -Infinity;
/** check timings (ms) over the last 10 minutes, for the honest cpu line in settings */
const checks: Array<{ at: number; ms: number }> = [];
let skippedRecent: number[] = [];
const FRAME_MS = 20;

function render(): void {
  let v = '';
  // every display's companion shows the ring; only the mic's overlay knows about checks / mic errors
  if (st?.on) v = st.mic && micError ? 'blocked' : st.followUp ? 'follow' : checking ? 'checking' : 'armed';
  if (v) root.dataset.wake = v;
  else delete root.dataset.wake;
}

/** the model downloads once (then works offline); it retries on the next bit of speech */
function modelError(message: string | undefined): string {
  const msg = (message || '').toLowerCase();
  return /fetch|network|download|load/.test(msg) || !msg ? "couldn't download the on-device voice model — check your connection; it retries by itself" : msg.slice(0, 120);
}

function report(state: WakeStatus['state'], detail?: string): void {
  // a blocked / missing microphone is the thing to fix first: model news doesn't replace it
  if (micError && state !== 'no-mic' && state !== 'error') return;
  if (micError && !detail) return;
  const now = Date.now();
  while (checks.length && now - checks[0]!.at > 600_000) checks.shift();
  skippedRecent = skippedRecent.filter((t) => now - t < 600_000);
  const avg = checks.length ? Math.round(checks.reduce((a, c) => a + c.ms, 0) / checks.length) : undefined;
  try {
    api.wakeStatus({ state, detail, checks: checks.length, skipped: skippedRecent.length, avgMs: avg });
  } catch {
    /* tests */
  }
}

const modelReady = (): boolean => !!st && localSttStatus(st.model)?.state === 'ready';

function tune(): void {
  if (!st || st.sensitivity === sensitivity) return;
  sensitivity = st.sensitivity;
  const t = WAKE_TUNING[st.sensitivity] ?? WAKE_TUNING.medium;
  vad = new EnergyVad({ threshold: t.vadThreshold, minSpeechMs: 300, silenceMs: 700, maxMs: 20_000 });
  gate.set({ perMinute: t.perMinute });
}

async function start(): Promise<void> {
  if (running) return;
  // a failed microphone is retried at most every 30 s (state updates arrive often)
  if (micError && performance.now() - micFailedAt < 30_000) return;
  running = true;
  micError = '';
  tune();
  report('starting');
  mic.setDevice(st?.stt?.micId);
  try {
    await mic.start();
  } catch (e) {
    running = false;
    micError = (e as Error).message || 'microphone failed';
    micFailedAt = performance.now();
    log('warn', `mic failed: ${micError}`);
    report(/blocked/.test(micError) ? 'no-mic' : 'error', micError);
    render();
    return;
  }
  if (!running) return mic.cancel(); // turned off while the mic was starting
  log('info', `mic started (${mic.details?.device ?? '?'}), sensitivity ${sensitivity}`);
  vad.reset();
  preroll = [];
  utter = [];
  clock = performance.now();
  loop = window.setInterval(tick, 60);
  // only now (the mic works) fetch / load the on-device model
  if (st) {
    preloadLocalModel(st.model);
    const ms = localSttStatus(st.model);
    report(ms?.state === 'ready' ? 'armed' : 'loading', ms?.state === 'downloading' ? `downloading the voice model… ${Math.round(ms.progress)}%` : undefined);
  }
  render();
}

function stop(): void {
  if (!running) return;
  running = false;
  clearInterval(loop);
  mic.cancel();
  vad.reset();
  utter = [];
  preroll = [];
  render();
}

function concat(chunks: Float32Array[]): Float32Array {
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

function tick(): void {
  const pcm = mic.drain();
  const rate = mic.rate;
  if (!pcm.length) return;
  // not our turn to listen (clickity is busy, push-to-talk / dictation has the mic): drop audio
  if (!st?.listening) {
    if (vad.speaking) vad.reset();
    utter = [];
    preroll = [];
    clock = performance.now();
    return;
  }
  const frame = Math.max(1, Math.round((rate * FRAME_MS) / 1000));
  for (let i = 0; i < pcm.length; i += frame) {
    const f = pcm.subarray(i, Math.min(pcm.length, i + frame));
    clock += (f.length / rate) * 1000;
    const wasSpeaking = vad.speaking;
    const ev = vad.push(rmsOf(f), clock);
    if (vad.speaking || wasSpeaking) utter.push(f);
    else {
      preroll.push(f);
      while (preroll.length > 15) preroll.shift(); // ~300ms before the start
    }
    if (ev?.type === 'start') {
      utter = [...preroll, ...utter];
      preroll = [];
    } else if (ev?.type === 'end') {
      const samples = concat(utter);
      utter = [];
      void onSegment(samples, rate, ev.end - ev.start);
    } else if (ev?.type === 'discard') utter = [];
  }
}

async function to16k(pcm: Float32Array, rate: number): Promise<Float32Array> {
  // a little silence around the words: whisper hallucinates less on clips that don't start mid-sound
  const pad = new Float32Array(Math.round(rate * 0.3));
  return resampleTo16k(concat([pad, pcm, pad]), rate);
}

/** a segment that ended while a check was running: handled right after (it may be the question) */
let queued: { pcm: Float32Array; rate: number; durationMs: number } | null = null;

function drainQueue(): void {
  const q = queued;
  queued = null;
  if (q && st?.listening) window.setTimeout(() => void onSegment(q.pcm, q.rate, q.durationMs), 0);
}

async function onSegment(pcm: Float32Array, rate: number, durationMs: number): Promise<void> {
  if (!st) return;
  if (checking) {
    queued = { pcm, rate, durationMs };
    return;
  }
  const peak = peakLevel(pcm);
  // the question after a bare "hey clickity": sent whole, through the user's speech-to-text setting
  if (st.followUp) {
    checking = true;
    render();
    try {
      const pcm16 = await to16k(pcm, rate);
      if (st.stt?.provider === 'on-device') {
        const r = await transcribeLocalTimed(pcm16, st.stt.model || st.model, st.stt.language || undefined);
        api.wakeHeard({ kind: 'followup', text: r.text, durationMs, peak });
      } else api.wakeHeard({ kind: 'followup', wav: encodeWav(pcm16, 16000), durationMs, peak });
    } catch (e) {
      api.wakeHeard({ kind: 'followup', error: (e as Error).message || 'transcription failed', durationMs });
    } finally {
      checking = false;
      render();
      queued = null;
    }
    return;
  }
  const now = performance.now();
  const v = gate.admit(durationMs, now);
  if (!v.ok) {
    if (v.reason !== 'too-short') {
      skippedRecent.push(Date.now());
      log('info', `skipped a ${Math.round(durationMs)}ms segment (${v.reason})`);
    }
    return;
  }
  checking = true;
  render();
  const t0 = performance.now();
  try {
    const headLen = Math.min(pcm.length, Math.round((rate * WAKE_HEAD_MS) / 1000));
    const head = await to16k(pcm.subarray(0, headLen), rate);
    const r = await transcribeLocalTimed(head, st.model, 'en');
    checks.push({ at: Date.now(), ms: r.ms });
    const m = matchWake(r.text, st.targets, st.sensitivity);
    if (!m) {
      // never log what was said when it wasn't meant for us
      log('info', `checked ${Math.round(durationMs)}ms of speech in ${r.ms}ms: no wake word${st.debug ? ` [test: "${r.text.trim()}"]` : ''}`);
      report(st.listening ? 'armed' : 'paused');
      return;
    }
    // the segment goes on past the head: transcribe all of it for the question
    let text = r.text;
    if (headLen < pcm.length) {
      const full = await transcribeLocalTimed(await to16k(pcm, rate), st.model, 'en');
      text = full.text;
    }
    log('info', `wake word heard (score ${m.score}) in ${Math.round(performance.now() - t0)}ms`);
    api.wakeHeard({ kind: 'wake', text, durationMs, peak });
    report('armed');
  } catch (e) {
    log('warn', `check failed: ${(e as Error).message}`);
    report('error', modelError((e as Error).message));
  } finally {
    gate.done(performance.now());
    checking = false;
    render();
    // main gets ~250 ms to arm the follow-up before a queued segment is looked at
    if (queued) window.setTimeout(drainQueue, 350);
  }
}

onLocalSttStatus((s) => {
  if (!st?.on || !st.mic || s.model !== st.model) return;
  if (s.state === 'downloading') report('loading', `downloading the voice model… ${Math.round(s.progress)}%`);
  else if (s.state === 'loading') report('loading', 'loading the voice model…');
  else if (s.state === 'ready') report('armed');
  else if (s.state === 'error' && !micError) report('error', modelError(s.message));
});

api.onWake((s) => {
  const prev = st;
  st = s;
  tune();
  if (s.on && s.mic) {
    if (prev?.stt?.micId !== s.stt?.micId && running) {
      stop();
    }
    void start();
    if (running && !micError) report(!s.listening ? 'paused' : modelReady() ? 'armed' : 'loading');
  } else {
    stop();
  }
  render();
});
