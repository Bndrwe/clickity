// Overlay renderer: the cursor companion, reply bubble, pointing flight, mic capture and speech playback.
// Talks to main only through window.overlay (see src/shared/ipc.ts).
import type { OverlayApi } from '../../shared/ipc';
import type { CompanionPhase, OverlayConfig, OverlayPoint, OverlayState, PttStopRequest, SpeakCommand } from '../../shared/types';
import { MicRecorder, encodeWav, resampleTo16k } from './audio';
import { Spring2D, clamp, ease, spring } from './motion';
import { Speaker } from './speech';
import { preloadLocalModel, transcribeLocal } from './stt-local';

const api: OverlayApi = window.overlay;

/* ───────── dom ───────── */
const $ = <T extends Element = HTMLElement>(id: string) => document.getElementById(id) as unknown as T;
const root = document.documentElement;
const stage = $('stage');
const companionEl = $('companion');
const bodyEl = $('body');
const arrowEl = $<SVGSVGElement>('arrow');
const shadowEl = companionEl.querySelector<HTMLElement>('.shadow')!;
const waveBars = Array.from($('wave').children) as HTMLElement[];
const ripplesEl = $('ripples');
const pillPos = $('pill-pos');
const pillEl = $('pill');
const bubblePos = $('bubble-pos');
const bubbleEl = $('bubble');
const transcriptWrap = bubbleEl.querySelector<HTMLElement>('.transcript-wrap')!;
const transcriptEl = $('transcript');
const replyEl = $('reply');
const replyTextEl = $('reply-text');
const errorEl = $('error');
const typePos = $('typebox-pos');
const typeForm = $<HTMLFormElement>('typebox');
const typeInput = $<HTMLInputElement>('typebox-input');

/* ───────── config / theme ───────── */
let config: OverlayConfig = {
  companion: { followCursor: true, offsetX: 18, offsetY: 20, scale: 1, color: '', showBubble: true, pointing: true },
  theme: 'system',
  displayBounds: { x: window.screenX, y: window.screenY, width: window.innerWidth, height: window.innerHeight },
  hotkeyLabel: '',
};
let scale = 1;

const darkQuery = matchMedia('(prefers-color-scheme: dark)');
const motionQuery = matchMedia('(prefers-reduced-motion: reduce)');
let reducedMotion = motionQuery.matches;
motionQuery.addEventListener('change', () => (reducedMotion = motionQuery.matches));

function applyTheme(): void {
  const dark = config.theme === 'dark' || (config.theme === 'system' && darkQuery.matches);
  root.classList.toggle('dark', dark);
}
darkQuery.addEventListener('change', applyTheme);

/* ───────── motion state ───────── */
const BASE_TILT = -28; // degrees: arrow leans like a cursor, tip up-left
type Mode = 'follow' | 'flying' | 'pointing' | 'returning';
let mode: Mode = 'follow';

const follow = new Spring2D(16);
const bubbleSpring = new Spring2D(22);
let posX = 0;
let posY = 0;
let velX = 0;
let velY = 0;
let angle = BASE_TILT;

let cursorLocal: { x: number; y: number } | null = null;
let cursorOnDisplay = false;
let visible = false;

interface Flight {
  t0: number;
  dur: number;
  x0: number;
  y0: number;
  cx: number;
  cy: number;
  x1: number;
  y1: number;
  rippled: boolean;
}
let flight: Flight | null = null;
let currentPoint: OverlayPoint | null = null;
let returning: { t0: number; dur: number; x0: number; y0: number } | null = null;
let autoReturnTimer = 0;

/** where the companion's tip wants to be when it follows the cursor */
function followTarget(): { x: number; y: number } {
  const c = config.companion;
  if (!c.followCursor) return { x: window.innerWidth - 72 * scale, y: window.innerHeight - 84 * scale };
  if (!cursorLocal) return { x: posX, y: posY };
  return { x: cursorLocal.x + c.offsetX, y: cursorLocal.y + c.offsetY };
}

/* ───────── phase / bubble state ───────── */
let phase: CompanionPhase = 'idle';
let transcript = '';
let reply = '';
let shownReply = '';
let errorText = '';
let errorTimer = 0;
let lingerTimer = 0;
let lingering = false;
let transcriptTimer = 0;
let transcriptOpen = false;
let bubbleIn = false;
let bubbleW = 0;
let bubbleH = 0;
let bubbleFlip = false;
let bubbleSnap = true;

let typeW = 280;
let typeH = 42;
new ResizeObserver((entries) => {
  const b = entries[0]?.borderBoxSize?.[0];
  if (b) {
    bubbleW = b.inlineSize;
    bubbleH = b.blockSize;
  }
  kick();
}).observe(bubbleEl);

/* ───────── audio ───────── */
const mic = new MicRecorder();
const speaker = new Speaker(() => {
  api.speechDone();
  scheduleAutoReturn();
  kick();
});
const bands = new Float32Array(waveBars.length);
const smoothBands = new Float32Array(waveBars.length);
let speakLevel = 0;

/* ───────── rAF loop ───────── */
let rafId = 0;
let lastT = 0;

function kick(): void {
  if (!rafId) {
    lastT = performance.now();
    rafId = requestAnimationFrame(frame);
  }
}

function setVisible(v: boolean): void {
  if (v === visible) return;
  visible = v;
  stage.classList.toggle('is-hidden', !v);
}

function frame(now: number): void {
  rafId = 0;
  const dt = Math.min(0.05, Math.max(0.001, (now - lastT) / 1000));
  lastT = now;
  const target = followTarget();
  const px = posX;
  const py = posY;

  if (mode === 'follow') {
    if (reducedMotion) follow.snap(target.x, target.y);
    else follow.step(target.x, target.y, dt);
    posX = follow.x;
    posY = follow.y;
  } else if (mode === 'flying' && flight) {
    const f = flight;
    const t = clamp((now - f.t0) / f.dur, 0, 1);
    const p = spring(t);
    const q = 1 - p;
    // quadratic bezier arc; p > 1 extrapolates along the end tangent → overshoot, then settles
    posX = q * q * f.x0 + 2 * q * p * f.cx + p * p * f.x1;
    posY = q * q * f.y0 + 2 * q * p * f.cy + p * p * f.y1;
    if (!f.rippled && t > 0.42) {
      f.rippled = true;
      ripple(f.x1, f.y1);
      showPill();
    }
    if (t >= 1) {
      mode = 'pointing';
      posX = f.x1;
      posY = f.y1;
      flight = null;
    }
  } else if (mode === 'pointing' && currentPoint) {
    posX = currentPoint.x;
    posY = currentPoint.y;
  } else if (mode === 'returning' && returning) {
    const r = returning;
    const t = clamp((now - r.t0) / r.dur, 0, 1);
    const e = ease(t);
    posX = r.x0 + (target.x - r.x0) * e;
    posY = r.y0 + (target.y - r.y0) * e;
    if (t >= 1) {
      mode = 'follow';
      returning = null;
      follow.snap(target.x, target.y);
    }
  }

  // velocity (smoothed) for lean
  const ivx = (posX - px) / dt;
  const ivy = (posY - py) / dt;
  const k = 1 - Math.exp(-dt * 14);
  velX += (ivx - velX) * k;
  velY += (ivy - velY) * k;

  // lean toward movement: horizontal motion tips it, flight leans harder
  const lim = mode === 'flying' ? 20 : 12;
  const lean = reducedMotion ? 0 : clamp(velX * 0.012 + (mode === 'flying' ? velY * 0.004 : 0), -lim, lim);
  angle += (BASE_TILT + lean - angle) * (1 - Math.exp(-dt * 10));

  const t = now / 1000;
  const bobAmt = reducedMotion || mode === 'flying' ? 0 : 1.6 * scale;
  const bob = Math.sin(t * ((Math.PI * 2) / 2.6)) * bobAmt;

  let pulse = 1;
  if (speaker.active) {
    speakLevel += (speaker.level(now) - speakLevel) * (1 - Math.exp(-dt * 18));
    pulse = 1 + speakLevel * 0.14;
  } else speakLevel = 0;

  companionEl.style.transform = `translate3d(${posX.toFixed(2)}px, ${posY.toFixed(2)}px, 0)`;
  bodyEl.style.transform = `translate3d(0, ${bob.toFixed(2)}px, 0) rotate(${angle.toFixed(2)}deg)`;
  arrowEl.style.transform = pulse === 1 ? '' : `scale(${pulse.toFixed(3)})`;
  const lift = bobAmt ? (bob / bobAmt + 1) / 2 : 0.5; // 0 = low, 1 = high
  shadowEl.style.transform = `scale(${(1.04 - lift * 0.12).toFixed(3)})`;
  shadowEl.style.opacity = (0.95 - lift * 0.25).toFixed(3);

  if (phase === 'listening' && mic.active) {
    mic.bands(bands);
    for (let i = 0; i < waveBars.length; i++) {
      smoothBands[i] = smoothBands[i]! + (bands[i]! - smoothBands[i]!) * (1 - Math.exp(-dt * 20));
      waveBars[i]!.style.transform = `scaleY(${(0.18 + smoothBands[i]! * 0.82).toFixed(3)})`;
    }
  }

  placeBubble(dt);

  const settled = mode === 'follow' && follow.settled(target.x, target.y);
  const needLoop = visible ? true : !settled || bubbleIn || speaker.active;
  if (needLoop) rafId = requestAnimationFrame(frame);
}

/** Bubble / type box sit beside the companion, flipped and clamped to stay on screen. */
function slotFor(w: number, h: number): { x: number; y: number; flip: boolean } {
  const W = window.innerWidth;
  const H = window.innerHeight;
  const m = 12;
  let x = posX + 22 * scale;
  let y = posY + 28 * scale;
  let flip = false;
  if (x + w > W - m) {
    x = posX - w - 10 * scale;
    flip = true;
  }
  if (y + h > H - m) y = posY - h - 10 * scale;
  x = clamp(x, m, Math.max(m, W - w - m));
  y = clamp(y, m, Math.max(m, H - h - m));
  return { x, y, flip };
}

function placeBubble(dt: number): void {
  if (bubbleIn) {
    const s = slotFor(bubbleW || 200, bubbleH || 44);
    if (s.flip !== bubbleFlip) {
      bubbleFlip = s.flip;
      bubbleEl.classList.toggle('flip-x', s.flip);
    }
    if (bubbleSnap || reducedMotion) {
      bubbleSpring.snap(s.x, s.y);
      bubbleSnap = false;
    } else bubbleSpring.step(s.x, s.y, dt);
    bubblePos.style.transform = `translate3d(${bubbleSpring.x.toFixed(2)}px, ${bubbleSpring.y.toFixed(2)}px, 0)`;
  }
  if (typeOpen) {
    const s = slotFor(typeW, typeH);
    typePos.style.transform = `translate3d(${s.x.toFixed(2)}px, ${s.y.toFixed(2)}px, 0)`;
  }
}

/* ───────── pointing ───────── */
function ripple(x: number, y: number): void {
  if (reducedMotion) return;
  const r = document.createElement('div');
  r.className = 'ripple';
  r.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  ripplesEl.appendChild(r);
  const anim = r.animate(
    [
      { transform: `translate3d(${x}px, ${y}px, 0) scale(0.2)`, opacity: 0.7 },
      { transform: `translate3d(${x}px, ${y}px, 0) scale(1.6)`, opacity: 0 },
    ],
    { duration: 1100, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
  );
  anim.onfinish = () => r.remove();
}

function showPill(): void {
  const p = currentPoint;
  if (!p || !p.label.trim()) return;
  pillEl.textContent = p.label.trim().toLowerCase();
  const w = pillEl.offsetWidth; // one read per point
  const h = pillEl.offsetHeight;
  // opposite side from where the bubble will sit
  const bubbleRight = !(p.x + 22 * scale + (bubbleW || 320) > window.innerWidth - 12);
  let x = bubbleRight ? p.x - w - 12 * scale : p.x + 26 * scale;
  let y = p.y - h / 2 + 4 * scale;
  x = clamp(x, 8, window.innerWidth - w - 8);
  y = clamp(y, 8, window.innerHeight - h - 8);
  pillPos.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  pillEl.classList.add('is-in');
}

function hidePill(): void {
  pillEl.classList.remove('is-in');
}

function pointAt(p: OverlayPoint): void {
  clearTimeout(autoReturnTimer);
  currentPoint = p;
  returning = null;
  hidePill();
  setVisible(true);
  if (reducedMotion) {
    flight = null;
    mode = 'pointing';
    posX = p.x;
    posY = p.y;
    showPill();
    kick();
    return;
  }
  const x0 = posX;
  const y0 = posY;
  const dx = p.x - x0;
  const dy = p.y - y0;
  const dist = Math.hypot(dx, dy);
  // control point: lift the midpoint perpendicular to the path, always arcing upward
  let nx = -dy / (dist || 1);
  let ny = dx / (dist || 1);
  if (ny > 0) {
    nx = -nx;
    ny = -ny;
  }
  const liftAmt = Math.min(dist * 0.28, 160);
  flight = {
    t0: performance.now(),
    dur: clamp(700 + dist * 0.25, 750, 1000),
    x0,
    y0,
    cx: x0 + dx / 2 + nx * liftAmt,
    cy: y0 + dy / 2 + ny * liftAmt,
    x1: p.x,
    y1: p.y,
    rippled: false,
  };
  mode = 'flying';
  kick();
}

function returnToCursor(): void {
  clearTimeout(autoReturnTimer);
  if (mode === 'follow' || mode === 'returning') return;
  currentPoint = null;
  flight = null;
  hidePill();
  if (reducedMotion) {
    mode = 'follow';
    const t = followTarget();
    follow.snap(t.x, t.y);
  } else {
    returning = { t0: performance.now(), dur: 750, x0: posX, y0: posY };
    mode = 'returning';
  }
  if (!cursorOnDisplay) setVisible(false);
  kick();
}

/** If main never sends point:null after the reply, drift home on our own once things are quiet. */
function scheduleAutoReturn(): void {
  clearTimeout(autoReturnTimer);
  if ((mode === 'pointing' || mode === 'flying') && !speaker.active && (phase === 'idle' || phase === 'error')) {
    autoReturnTimer = window.setTimeout(returnToCursor, 2200);
  }
}

/* ───────── bubble content ───────── */
function setReplyText(text: string): void {
  if (text === shownReply) return;
  if (shownReply && text.startsWith(shownReply)) {
    const span = document.createElement('span');
    span.textContent = text.slice(shownReply.length);
    replyTextEl.appendChild(span);
  } else {
    replyTextEl.textContent = '';
    if (text) {
      const span = document.createElement('span');
      span.textContent = text;
      replyTextEl.appendChild(span);
    }
  }
  shownReply = text;
  // keep the latest line in view
  replyEl.scrollTop = replyEl.scrollHeight;
  replyEl.classList.toggle('is-clipped', replyEl.scrollHeight > replyEl.clientHeight + 1);
}

function renderBubble(): void {
  const showBubble = config.companion.showBubble;
  const isError = phase === 'error' && !!errorText;
  const wantTranscript = showBubble && !!transcript && (phase === 'transcribing' || phase === 'thinking');
  const wantReply = showBubble && !!reply && (phase === 'thinking' || phase === 'speaking' || lingering);

  if (wantTranscript) transcriptEl.textContent = transcript;
  if (wantTranscript !== transcriptOpen) {
    clearTimeout(transcriptTimer);
    if (wantTranscript) {
      transcriptOpen = true;
      transcriptWrap.classList.add('is-open');
    } else {
      // linger briefly before folding away
      transcriptTimer = window.setTimeout(() => {
        transcriptOpen = false;
        transcriptWrap.classList.remove('is-open');
      }, bubbleIn && wantReply ? 1400 : 0);
    }
  }

  if (wantReply || isError) setReplyText(isError ? shownReply : reply);
  bubbleEl.classList.toggle('has-reply', wantReply);
  bubbleEl.classList.toggle('is-error', isError);
  errorEl.textContent = isError ? errorText : '';

  const want = isError || wantTranscript || wantReply;
  if (want !== bubbleIn) {
    bubbleIn = want;
    if (want) bubbleSnap = true;
    bubbleEl.classList.toggle('is-in', want);
    if (!want) {
      transcriptOpen = false;
      transcriptWrap.classList.remove('is-open');
    }
  }
  kick();
}

function onState(s: OverlayState): void {
  const prev = phase;
  phase = s.phase;
  root.dataset.phase = phase;
  transcript = (s.transcript ?? '').trim();

  if (phase === 'listening') {
    // new turn: clear the old reply, head home if we were pointing
    reply = '';
    setReplyText('');
    returnToCursor();
  } else if (s.reply !== undefined || phase !== 'idle') {
    reply = s.reply ?? (phase === 'idle' ? reply : '');
  }

  clearTimeout(errorTimer);
  if (phase === 'error') {
    errorText = (s.error || 'something went wrong').toLowerCase();
    errorTimer = window.setTimeout(() => {
      errorText = '';
      renderBubble();
    }, 4500);
  } else errorText = '';

  clearTimeout(lingerTimer);
  if (phase === 'idle' && prev !== 'idle' && reply) {
    lingering = true;
    lingerTimer = window.setTimeout(() => {
      lingering = false;
      renderBubble();
    }, 2600);
  } else if (phase !== 'idle') lingering = false;

  stage.classList.toggle(
    'show-dots',
    (phase === 'transcribing' || phase === 'thinking') && !reply,
  );
  if (phase !== 'listening') {
    smoothBands.fill(0);
    for (const b of waveBars) b.style.transform = 'scaleY(0.18)';
  }
  if (phase !== 'idle' && phase !== 'error') clearTimeout(autoReturnTimer);
  else scheduleAutoReturn();
  renderBubble();
}

/* ───────── type box ───────── */
let typeOpen = false;
let typeOpenedAt = 0;

new ResizeObserver((entries) => {
  const b = entries[0]?.borderBoxSize?.[0];
  if (b) {
    typeW = b.inlineSize;
    typeH = b.blockSize;
  }
}).observe(typeForm);

function setTypeBox(open: boolean): void {
  typeOpen = open;
  typeForm.classList.toggle('is-in', open);
  if (open) {
    typeOpenedAt = performance.now();
    typeInput.value = '';
    setVisible(true);
    kick();
    const focus = () => typeInput.focus({ preventScroll: true });
    focus();
    setTimeout(focus, 30);
    setTimeout(focus, 150);
  } else {
    typeInput.blur();
    if (!cursorOnDisplay && mode === 'follow') setVisible(false);
  }
}

typeForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = typeInput.value.trim();
  if (!text) return;
  setTypeBox(false);
  api.submitText(text);
});
typeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    setTypeBox(false);
    api.cancelText();
  }
});
window.addEventListener('focus', () => {
  if (typeOpen) typeInput.focus({ preventScroll: true });
});
window.addEventListener('blur', () => {
  // clicked away: treat as cancel (grace period for focus juggling while opening)
  if (typeOpen && performance.now() - typeOpenedAt > 400) {
    setTypeBox(false);
    api.cancelText();
  }
});

/* ───────── mic / push-to-talk ───────── */
let pttStartedAt = 0;
let lastStt: PttStopRequest['stt'] | null = null;
const preloaded = new Set<string>();

function maybePreload(stt: PttStopRequest['stt'] | null): void {
  if (!stt || stt.provider !== 'on-device' || !stt.model || preloaded.has(stt.model)) return;
  preloaded.add(stt.model);
  try {
    preloadLocalModel(stt.model);
  } catch (e) {
    console.warn('[overlay] preload failed', e);
  }
}

function errMessage(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return (m || 'recording failed').toLowerCase();
}

function onPttStart(): void {
  pttStartedAt = performance.now();
  maybePreload(lastStt);
  speaker.stop();
  mic.start().catch((e: unknown) => console.warn('[overlay] mic start failed', e));
  kick();
}

async function onPttStop(req: PttStopRequest): Promise<void> {
  lastStt = req.stt;
  const durationMs = pttStartedAt ? Math.round(performance.now() - pttStartedAt) : 0;
  pttStartedAt = 0;
  try {
    const rec = await mic.stop();
    if (!rec.pcm.length) throw new Error('no audio captured');
    const pcm = await resampleTo16k(rec.pcm, rec.sampleRate);
    if (req.stt.provider === 'on-device') {
      if (durationMs < 250) {
        api.sendPttResult({ text: '', durationMs }); // accidental tap; main ignores it
        return;
      }
      preloaded.add(req.stt.model);
      const text = await transcribeLocal(pcm, req.stt.model, req.stt.language || undefined);
      api.sendPttResult({ text: text.trim(), durationMs });
    } else {
      api.sendPttResult({ wav: encodeWav(pcm, 16000), durationMs });
    }
  } catch (e) {
    api.sendPttResult({ error: errMessage(e), durationMs });
  }
}

/* ───────── wiring ───────── */
api.onConfig((c) => {
  const prevFollow = config.companion.followCursor;
  config = c;
  scale = clamp(c.companion.scale || 1, 0.5, 2.5);
  root.style.setProperty('--s', String(scale));
  if (c.companion.color) root.style.setProperty('--buddy', c.companion.color);
  else root.style.removeProperty('--buddy');
  applyTheme();
  if (prevFollow !== c.companion.followCursor && mode === 'follow') {
    const t = followTarget();
    follow.snap(t.x, t.y);
  }
  if (!c.companion.pointing && mode !== 'follow') returnToCursor();
  renderBubble();
  kick();
});

api.onCursor((p) => {
  const b = config.displayBounds;
  const inside = p.x >= b.x && p.y >= b.y && p.x < b.x + b.width && p.y < b.y + b.height;
  cursorLocal = { x: p.x - b.x, y: p.y - b.y };
  if (inside && !cursorOnDisplay) {
    // arriving from another display: appear in place, don't streak across
    const t = followTarget();
    if (mode === 'follow') {
      follow.snap(t.x, t.y);
      posX = t.x;
      posY = t.y;
      velX = velY = 0;
    }
  }
  cursorOnDisplay = inside;
  setVisible(inside || mode !== 'follow' || typeOpen);
  if (inside || mode !== 'follow') kick();
});

api.onState(onState);

api.onPoint((p) => {
  if (p && config.companion.pointing) pointAt(p);
  else returnToCursor();
});

api.onPttStart(onPttStart);
api.onPttStop((req) => void onPttStop(req));
api.onPttCancel(() => {
  pttStartedAt = 0;
  mic.cancel();
});

api.onSpeak((cmd: SpeakCommand) => {
  clearTimeout(autoReturnTimer);
  speaker.speak(cmd);
  kick();
});
api.onStopSpeaking(() => speaker.stop());
api.onTextInput(setTypeBox);

root.dataset.phase = phase;
applyTheme();
api.ready();
