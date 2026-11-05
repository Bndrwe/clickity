// Overlay extras: the tiny cue pill at the cursor (dictation), soft highlight outlines,
// captions, the guided-walkthrough click, and hands-free mode (continuous mic + energy VAD).
// Self-contained: it listens on window.overlay next to overlay.ts and draws its own elements.
import type { OverlayApi } from '../../shared/ipc';
import type { HandsFreeState, OverlayConfig, OverlayCue, OverlayHighlight, OverlayState, SpeakCommand } from '../../shared/types';
import { EnergyVad, looksLikeHeadphones, rmsOf } from '../../shared/vad';
import { MicRecorder, encodeWav, peakLevel, resampleTo16k } from './audio';
import { splitSentences } from './speech';
import { transcribeLocal } from './stt-local';

const api: OverlayApi = window.overlay;
const root = document.documentElement;
const reduced = matchMedia('(prefers-reduced-motion: reduce)');

const css = `
.x-layer { position: fixed; inset: 0; pointer-events: none; z-index: 5; }
.x-cue {
  position: fixed; left: 0; top: 0; font: 500 11.5px/1 var(--sans); letter-spacing: 0.01em; text-transform: lowercase;
  white-space: nowrap; color: var(--ink); background: var(--bg-elev); padding: 6px 10px 7px; border-radius: 999px;
  box-shadow: 0 10px 22px -10px var(--shadow), 0 0 0 1px var(--line); opacity: 0; transition: opacity .35s var(--ease);
  display: flex; align-items: center; gap: 6px;
}
.x-cue.is-in { opacity: 1; }
.x-cue i { width: 6px; height: 6px; border-radius: 50%; background: var(--ink-muted); display: none; }
.x-cue[data-kind=listening] i { display: block; background: var(--danger); animation: x-pulse 1.1s var(--ease-soft) infinite; }
.x-cue[data-kind=working] i { display: block; animation: x-pulse .9s var(--ease-soft) infinite; }
.x-cue[data-kind=done] i { display: block; background: #2e9e5b; }
.x-cue[data-kind=error] { color: var(--danger); }
@keyframes x-pulse { 0%,100% { opacity: .35; transform: scale(.8) } 50% { opacity: 1; transform: scale(1.1) } }
.x-hl {
  position: fixed; border-radius: 12px; border: 2px solid var(--buddy, var(--ink));
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--bg-elev) 70%, transparent), 0 8px 30px -8px var(--shadow);
  opacity: 0; transform: scale(1.04); transition: opacity .5s var(--ease), transform .5s var(--ease);
}
.x-hl.is-in { opacity: .95; transform: none; }
.x-hl b {
  position: absolute; left: -2px; top: -26px; font: 500 11px/1 var(--sans); text-transform: lowercase; white-space: nowrap;
  color: var(--bg-elev); background: var(--buddy, var(--ink)); padding: 5px 8px 6px; border-radius: 999px;
}
.x-caption {
  position: fixed; left: 0; top: 0; max-width: 420px; font: 500 15px/1.4 var(--sans); color: var(--ink);
  background: color-mix(in srgb, var(--bg-elev) 92%, transparent); padding: 8px 12px 9px; border-radius: 12px;
  box-shadow: 0 10px 24px -12px var(--shadow), 0 0 0 1px var(--line); opacity: 0; transition: opacity .3s var(--ease);
}
.x-caption.is-in { opacity: 1; }
.x-hf {
  position: fixed; top: 10px; left: 50%; transform: translateX(-50%); font: 500 11.5px/1 var(--sans); text-transform: lowercase;
  color: var(--ink-2); background: var(--bg-elev); padding: 6px 11px 7px; border-radius: 999px; display: none; align-items: center; gap: 7px;
  box-shadow: 0 10px 22px -12px var(--shadow), 0 0 0 1px var(--line);
}
.x-hf.is-on { display: flex; }
.x-hf i { width: 7px; height: 7px; border-radius: 50%; background: var(--ink-muted); }
.x-hf.is-listening i { background: var(--danger); animation: x-pulse 1.4s var(--ease-soft) infinite; }
.x-hf.is-hearing i { background: var(--danger); animation: x-pulse .5s var(--ease-soft) infinite; }
.x-hf small { color: var(--ink-muted); font-size: 11px; }
html[data-walk] .bubble, html[data-walk] .bubble * { cursor: pointer; }
`;
const style = document.createElement('style');
style.textContent = css;
document.head.append(style);

const layer = document.createElement('div');
layer.className = 'x-layer';
const cueEl = document.createElement('div');
cueEl.className = 'x-cue';
cueEl.setAttribute('role', 'status');
const cueDot = document.createElement('i');
const cueText = document.createElement('span');
cueEl.append(cueDot, cueText);
const captionEl = document.createElement('div');
captionEl.className = 'x-caption';
captionEl.setAttribute('aria-live', 'polite');
const hfEl = document.createElement('div');
hfEl.className = 'x-hf';
hfEl.innerHTML = '<i></i><span>hands-free</span><small></small>';
const hfNote = hfEl.querySelector('small')!;
layer.append(cueEl, captionEl, hfEl);
document.body.append(layer);

let config: OverlayConfig | null = null;
let cursor: { x: number; y: number } | null = null;
let onDisplay = false;

function log(level: 'info' | 'warn' | 'error', message: string): void {
  try {
    api.log({ level, message });
  } catch {
    /* tests */
  }
}

/* ───────── cue at the cursor ───────── */
let cueTimer = 0;
function placeNearCursor(el: HTMLElement, dx: number, dy: number): void {
  if (!cursor || !config) return;
  const b = config.displayBounds;
  const w = el.offsetWidth || 120;
  const h = el.offsetHeight || 24;
  const x = Math.min(Math.max(8, cursor.x - b.x + dx), window.innerWidth - w - 8);
  const y = Math.min(Math.max(8, cursor.y - b.y + dy), window.innerHeight - h - 8);
  el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
}

function showCue(c: OverlayCue | null): void {
  clearTimeout(cueTimer);
  if (!c || !onDisplay) {
    cueEl.classList.remove('is-in');
    return;
  }
  cueEl.dataset.kind = c.kind;
  cueText.textContent = c.text.toLowerCase();
  placeNearCursor(cueEl, 16, 26);
  cueEl.classList.add('is-in');
  if (c.ttl > 0) cueTimer = window.setTimeout(() => cueEl.classList.remove('is-in'), c.ttl);
}

/* ───────── highlights ───────── */
let hlEls: HTMLElement[] = [];
let hlSafety = 0;
function showHighlights(list: OverlayHighlight[] | null): void {
  clearTimeout(hlSafety);
  const old = hlEls;
  hlEls = [];
  for (const el of old) {
    el.classList.remove('is-in');
    setTimeout(() => el.remove(), reduced.matches ? 0 : 600);
  }
  if (!list?.length) return;
  for (const h of list.slice(0, 8)) {
    const el = document.createElement('div');
    el.className = 'x-hl';
    const pad = 6;
    el.style.left = `${h.x - pad}px`;
    el.style.top = `${h.y - pad}px`;
    el.style.width = `${h.width + pad * 2}px`;
    el.style.height = `${h.height + pad * 2}px`;
    if (h.label) {
      const b = document.createElement('b');
      b.textContent = h.label.toLowerCase();
      el.append(b);
    }
    layer.append(el);
    hlEls.push(el);
    requestAnimationFrame(() => el.classList.add('is-in'));
  }
  hlSafety = window.setTimeout(() => showHighlights(null), 45_000); // never leave one behind
}

/* ───────── captions ───────── */
let lastReply = '';
let captionTimers: number[] = [];
function stopCaptions(): void {
  captionTimers.forEach((t) => clearTimeout(t));
  captionTimers = [];
  captionEl.classList.remove('is-in');
}
function startCaptions(cmd: SpeakCommand): void {
  stopCaptions();
  const c = config?.companion;
  if (!c?.captions || c.showBubble || !onDisplay) return;
  const text = cmd.mode === 'system' ? cmd.text : lastReply;
  const rate = cmd.mode === 'system' ? cmd.rate || 1 : 1;
  let at = 0;
  for (const sentence of splitSentences(text)) {
    captionTimers.push(
      window.setTimeout(() => {
        captionEl.textContent = sentence;
        placeNearCursor(captionEl, 18, 30);
        captionEl.classList.add('is-in');
      }, at),
    );
    at += Math.max(1200, (sentence.split(/\s+/).length / (2.6 * rate)) * 1000 + 250);
  }
  captionTimers.push(window.setTimeout(stopCaptions, at + 400));
}

/* ───────── walkthrough: click the bubble for the next step ───────── */
let walking = false;
document.getElementById('bubble')?.addEventListener('click', (e) => {
  if (!walking) return;
  if ((e.target as HTMLElement).closest('button')) return;
  api.walkNext();
});

/* ───────── hands-free: continuous mic + voice activity ───────── */
const hfMic = new MicRecorder();
const vad = new EnergyVad();
let hf: HandsFreeState = { on: false, mic: false, listening: false };
let hfRunning = false;
let hfLoop = 0;
let headphones = true;
let warned = false;
/** samples (at the mic rate) since the current utterance began, plus a little pre-roll */
let preroll: Float32Array[] = [];
let utter: Float32Array[] = [];
let clock = 0;
let busy = false;
const FRAME_MS = 20;

async function checkHeadphones(): Promise<void> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const outs = devices.filter((d) => d.kind === 'audiooutput');
    const def = outs.find((d) => d.deviceId === 'default') ?? outs[0];
    const label = def?.label ?? '';
    headphones = !!label && looksLikeHeadphones(label);
    log('info', `hands-free output: "${label || '?'}" → ${headphones ? 'headphones' : 'speakers'}`);
  } catch {
    headphones = false;
  }
}

function renderHf(hearing = false): void {
  const show = hf.on && onDisplay;
  hfEl.classList.toggle('is-on', show);
  hfEl.classList.toggle('is-listening', hf.on && hf.listening);
  hfEl.classList.toggle('is-hearing', hearing);
  hfNote.textContent = !hf.mic ? '' : hf.listening ? (hearing ? '· hearing you' : '· listening') : busy ? '· working' : '· paused';
}

async function hfStart(): Promise<void> {
  if (hfRunning) return;
  hfRunning = true;
  await checkHeadphones();
  if (!headphones && !warned) {
    warned = true;
    showCue({ text: "no headphones? i'll stop listening while i talk", kind: 'info', ttl: 5000 });
  }
  hfMic.setDevice(config?.stt?.micId);
  try {
    await hfMic.start();
  } catch (e) {
    hfRunning = false;
    showCue({ text: `hands-free: ${(e as Error).message || 'microphone failed'}`.toLowerCase(), kind: 'error', ttl: 5000 });
    return;
  }
  log('info', `hands-free mic started (${hfMic.details?.device ?? '?'})`);
  vad.reset();
  preroll = [];
  utter = [];
  clock = performance.now();
  hfLoop = window.setInterval(hfTick, 50);
}

function hfStop(): void {
  if (!hfRunning) return;
  hfRunning = false;
  clearInterval(hfLoop);
  hfMic.cancel();
  vad.reset();
  utter = [];
  preroll = [];
  renderHf();
}

/** may the detector run now? (main's mic arbiter, or barge-in with headphones) */
function mayListen(): boolean {
  return hf.listening || (!!hf.bargeIn && headphones);
}

function hfTick(): void {
  const pcm = hfMic.drain();
  const rate = hfMic.rate;
  if (!pcm.length || busy) return;
  if (!mayListen()) {
    if (vad.speaking) vad.reset();
    utter = [];
    preroll = [];
    clock = performance.now();
    renderHf();
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
      while (preroll.length > 25) preroll.shift(); // ~500ms before the start
    }
    if (ev?.type === 'start') {
      utter = [...preroll, ...utter];
      preroll = [];
      renderHf(true);
      if (hf.bargeIn) api.handsFreeSpeech();
    } else if (ev?.type === 'end') {
      log('info', `hands-free: heard ${Math.round(ev.end - ev.start)}ms of speech`);
      const samples = concat(utter);
      utter = [];
      renderHf();
      void sendUtterance(samples, rate, ev.end - ev.start);
    } else if (ev?.type === 'discard') {
      log('info', `hands-free: ignored ${Math.round(ev.end - ev.start)}ms of noise`);
      utter = [];
      renderHf();
    }
  }
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

async function sendUtterance(pcm: Float32Array, rate: number, durationMs: number): Promise<void> {
  busy = true;
  renderHf();
  try {
    const peak = peakLevel(pcm);
    // a little silence around the words: whisper hallucinates less on clips that don't start mid-sound
    const pad = new Float32Array(Math.round(rate * 0.4));
    const pcm16 = await resampleTo16k(concat([pad, pcm, pad]), rate);
    const stt = config?.stt;
    if (stt?.provider === 'on-device') {
      const text = await transcribeLocal(pcm16, stt.model, stt.language || undefined);
      api.handsFreeUtterance({ text, durationMs, peak });
    } else api.handsFreeUtterance({ wav: encodeWav(pcm16, 16000), durationMs, peak });
  } catch (e) {
    api.handsFreeUtterance({ error: (e as Error).message || 'transcription failed', durationMs });
  } finally {
    busy = false;
    renderHf();
  }
}

/* ───────── wiring ───────── */
api.onConfig((c) => {
  config = c;
  if (hfRunning) hfMic.setDevice(c.stt?.micId);
});
api.onCursor((p) => {
  cursor = p;
  const b = config?.displayBounds;
  const inside = !!b && p.x >= b.x && p.y >= b.y && p.x < b.x + b.width && p.y < b.y + b.height;
  if (inside !== onDisplay) {
    onDisplay = inside;
    if (!inside) cueEl.classList.remove('is-in');
    renderHf();
  }
  if (cueEl.classList.contains('is-in')) placeNearCursor(cueEl, 16, 26);
});
api.onCue(showCue);
api.onHighlight(showHighlights);
api.onWalkthrough((on) => {
  walking = on;
  if (on) root.dataset.walk = '1';
  else delete root.dataset.walk;
});
api.onState((s: OverlayState) => {
  if (s.reply) lastReply = s.reply;
  if (s.phase === 'idle' || s.phase === 'listening' || s.phase === 'error') stopCaptions();
});
api.onSpeak(startCaptions);
api.onStopSpeaking(stopCaptions);
api.onHandsFree((st) => {
  hf = st;
  if (st.on && st.mic) void hfStart();
  else hfStop();
  renderHf();
});
