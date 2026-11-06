// Overlay renderer: the cursor companion, reply bubble, pointing flight, mic capture and speech playback.
// Talks to main only through window.overlay (see src/shared/ipc.ts).
import type { OverlayApi } from '../../shared/ipc';
import type { CompanionPhase, InkCommand, OverlayBusy, OverlayChoice, OverlayConfig, OverlayPoint, OverlayState, PttStopRequest, SpeakCommand } from '../../shared/types';
import { MicRecorder, encodeWav, peakLevel, resampleTo16k } from './audio';
import { Spring2D, clamp, ease, spring } from './motion';
import { Speaker } from './speech';
import { createOverlayVisuals } from './visuals';
import { ModelLoadError, localSttStatus, onLocalSttStatus, preloadLocalModel, transcribeLocal, type LocalSttStatus } from './stt-local';
// cue pill, highlights, captions, walkthrough clicks, hands-free mic (self-contained)
import './extras';

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
const noteEl = $('note');
const stepEl = $('step');
const confirmEl = $('confirm');
const confirmTextEl = $('confirm-text');
const stopHintEl = $('stop-hint');
const stopBtn = $<HTMLButtonElement>('stop-btn');
const stopBtnText = $('stop-btn-t');
const continueBtn = $<HTMLButtonElement>('continue-btn');
const closeBtn = $<HTMLButtonElement>('close-btn');
const choiceWrap = $('choice-wrap');
const choiceOptsEl = $('choice-opts');
const choiceHintEl = $('choice-hint');
const replyBtn = $<HTMLButtonElement>('reply-btn');
const typePos = $('typebox-pos');
const typeForm = $<HTMLFormElement>('typebox');
const typeInput = $<HTMLInputElement>('typebox-input');
const inkCanvas = $<HTMLCanvasElement>('ink');
/** cards / 3D models next to the bubble ([CARD:…] / [MODEL3D:…]) */
const visuals = createOverlayVisuals({ stage: $('stage'), setInteractive: (on) => setHoverInteractive(on), kick: () => kick() });

/* ───────── config / theme ───────── */
let config: OverlayConfig = {
  companion: { followCursor: true, show: 'always', offsetX: 18, offsetY: 20, scale: 1, color: '', showBubble: true, pointing: true, actions: 'ask', maxSteps: 8 },
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
  /** agent mode: quick hop to a click target (no landing ripple; the click draws its own) */
  fast: boolean;
}
let flight: Flight | null = null;
let currentPoint: OverlayPoint | null = null;
let returning: { t0: number; dur: number; x0: number; y0: number } | null = null;
let autoReturnTimer = 0;

/** where the companion's tip wants to be when it follows the cursor */
function followTarget(): { x: number; y: number } {
  const c = config.companion;
  // with no visible companion there's nothing to park: the invisible one always tracks the cursor
  if (!c.followCursor && c.show !== 'never') return { x: window.innerWidth - 72 * scale, y: window.innerHeight - 84 * scale };
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
/** status line from main (OverlayState.note) */
let serverNote = '';
/** status line from this overlay: voice model download / load, mic trouble while listening */
let localNote = '';
/** agent mode: actions waiting for enter / esc (OverlayState.confirm) */
let confirmText = '';
/** agent mode: "step 2 of 8" */
let stepText = '';
/** busy: the stop key works ("esc to stop" + stop button); null = idle */
let busy: OverlayBusy | null = null;
/** the user stopped the last reply: it lingers marked "stopped" */
let stoppedReply = false;
/** the user closed the bubble (× / the stop key): stays hidden until the next turn starts */
let dismissed = false;
/** a choice question waiting for an answer (pills); null = none */
let choice: OverlayChoice | null = null;
/** the type box was opened from the bubble (reply / something else / type chord over a reply): keep the bubble up */
let replyBox = false;
let lingerTimer = 0;
let lingering = false;
let transcriptTimer = 0;
let transcriptOpen = false;
let bubbleIn = false;
let bubbleW = 0;
let bubbleH = 0;
let bubbleFlip = false;
let bubbleSnap = true;
/** where the bubble is pinned (overlay-local px) — set once when it appears, then only moved by dragging */
let bubbleAnchor: { x: number; y: number } | null = null;
/** where the type box is pinned while open */
let typeAnchor: { x: number; y: number } | null = null;
/** last place the type box sat, so the reply bubble opens right where you typed */
let lastTypeSpot: { x: number; y: number; at: number } | null = null;
/** a drag in progress: which box, and the pointer's offset inside it */
let drag: { which: 'bubble' | 'type'; dx: number; dy: number; id: number } | null = null;
let hoverInteractive = false;

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

/** settings › companion › show companion: 'never' = no arrow (pointing shows only ripple + label) */
function arrowless(): boolean {
  return config.companion.show === 'never';
}

/** 'active' mode: the arrow shows while it works (any non-idle phase) or is away pointing. */
let presenceOn = false;
function syncPresence(): void {
  const on = (phase !== 'idle' && phase !== 'error') || mode !== 'follow' || !!currentPoint;
  if (on === presenceOn) return;
  presenceOn = on;
  root.classList.toggle('buddy-on', on);
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
      if (!f.fast) ripple(f.x1, f.y1);
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
  syncPresence();

  const settled = mode === 'follow' && follow.settled(target.x, target.y);
  const needLoop = visible ? true : !settled || bubbleIn || speaker.active || visuals.active;
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

/** keep a pinned box fully on screen (it can grow as the reply streams in) */
function keepOnScreen(a: { x: number; y: number }, w: number, h: number): { x: number; y: number } {
  const m = 12;
  return {
    x: clamp(a.x, m, Math.max(m, window.innerWidth - w - m)),
    y: clamp(a.y, m, Math.max(m, window.innerHeight - h - m)),
  };
}

function placeBubble(dt: number): void {
  if (bubbleIn) {
    // Pin the bubble where it first appears (or where the type box was) instead of
    // chasing the cursor; after that it only moves when the user drags it.
    if (!bubbleAnchor) {
      const recentType = lastTypeSpot && performance.now() - lastTypeSpot.at < 4000 ? lastTypeSpot : null;
      const s = slotFor(bubbleW || 200, bubbleH || 44);
      bubbleAnchor = recentType ? { x: recentType.x, y: recentType.y } : { x: s.x, y: s.y };
      if (s.flip !== bubbleFlip) {
        bubbleFlip = s.flip;
        bubbleEl.classList.toggle('flip-x', s.flip);
      }
    }
    const t = keepOnScreen(bubbleAnchor, bubbleW || 200, bubbleH || 44);
    if (bubbleSnap || reducedMotion || drag?.which === 'bubble') {
      bubbleSpring.snap(t.x, t.y);
      bubbleSnap = false;
    } else bubbleSpring.step(t.x, t.y, dt);
    bubblePos.style.transform = `translate3d(${bubbleSpring.x.toFixed(2)}px, ${bubbleSpring.y.toFixed(2)}px, 0)`;
  }
  if (visuals.active) visuals.place({ x: bubbleSpring.x, y: bubbleSpring.y, w: bubbleW || 200, h: bubbleH || 44, shown: bubbleIn });
  if (typeOpen) {
    if (!typeAnchor) {
      const s = slotFor(typeW, typeH);
      typeAnchor = { x: s.x, y: s.y };
    }
    const t = keepOnScreen(typeAnchor, typeW, typeH);
    typePos.style.transform = `translate3d(${t.x.toFixed(2)}px, ${t.y.toFixed(2)}px, 0)`;
  }
}

/* ───────── pointing ───────── */
function ripple(x: number, y: number, click = false): void {
  if (reducedMotion && !click) return;
  const r = document.createElement('div');
  r.className = click ? 'ripple click' : 'ripple';
  r.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  ripplesEl.appendChild(r);
  const anim = r.animate(
    click
      ? [
          { transform: `translate3d(${x}px, ${y}px, 0) scale(0.35)`, opacity: 0.95 },
          { transform: `translate3d(${x}px, ${y}px, 0) scale(1.5)`, opacity: 0 },
        ]
      : [
          { transform: `translate3d(${x}px, ${y}px, 0) scale(0.2)`, opacity: 0.7 },
          { transform: `translate3d(${x}px, ${y}px, 0) scale(1.6)`, opacity: 0 },
        ],
    { duration: click ? (reducedMotion ? 400 : 650) : 1100, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
  );
  anim.onfinish = () => r.remove();
}

/** agent mode: a click lands at p right now — ripple + a small press of the companion. */
function clickAt(p: OverlayPoint): void {
  ripple(p.x, p.y, true);
  if (!reducedMotion) {
    arrowEl.animate([{ scale: '1' }, { scale: '0.82' }, { scale: '1' }], { duration: 260, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
  }
  kick();
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
  if (arrowless()) {
    // nothing flies: mark the spot (agent clicks draw their own ripple) and label it
    if (mode !== 'follow') {
      mode = 'follow';
      flight = null;
      const t = followTarget();
      follow.snap(t.x, t.y);
    }
    if (phase !== 'acting') ripple(p.x, p.y);
    showPill();
    kick();
    return;
  }
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
  // agent mode: same arc, but a quick hop (main clicks ~380ms after sending the point)
  const fast = phase === 'acting';
  const liftAmt = Math.min(dist * (fast ? 0.14 : 0.28), fast ? 60 : 160);
  flight = {
    t0: performance.now(),
    dur: fast ? clamp(200 + dist * 0.08, 220, 320) : clamp(700 + dist * 0.25, 750, 1000),
    x0,
    y0,
    cx: x0 + dx / 2 + nx * liftAmt,
    cy: y0 + dy / 2 + ny * liftAmt,
    x1: p.x,
    y1: p.y,
    rippled: false,
    fast,
  };
  mode = 'flying';
  kick();
}

function returnToCursor(): void {
  clearTimeout(autoReturnTimer);
  if (mode === 'follow' || mode === 'returning') {
    // arrowless pointing only left a label behind
    if (currentPoint && mode === 'follow') {
      currentPoint = null;
      hidePill();
      if (!cursorOnDisplay && !typeOpen) setVisible(false);
    }
    return;
  }
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
  if ((mode === 'pointing' || mode === 'flying' || currentPoint) && !speaker.active && (phase === 'idle' || phase === 'error')) {
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
    // shrinking (a partial tag got hidden) only trims: no fade-in replay, so it doesn't flicker
    const trimOnly = !!text && shownReply.startsWith(text);
    replyTextEl.textContent = '';
    if (text) {
      const span = document.createElement('span');
      span.textContent = text;
      if (trimOnly) span.className = 'still';
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
  const wantChoice = !!choice;
  const keepForReply = typeOpen && replyBox;
  // a pending choice shows its reply even with the bubble off: the pills are how you answer
  const wantReply = !!reply && ((showBubble && (phase === 'thinking' || phase === 'speaking' || phase === 'acting' || lingering || keepForReply)) || wantChoice);
  // agent mode lines show even with the reply bubble off: they're how the user stays in control
  const wantConfirm = !!confirmText && phase !== 'idle' && phase !== 'error' && phase !== 'listening';
  const wantStep = !!stepText && (phase === 'thinking' || phase === 'speaking' || phase === 'acting');
  confirmTextEl.textContent = wantConfirm ? confirmText : '';
  stepEl.textContent = wantStep ? stepText : '';
  bubbleEl.classList.toggle('has-confirm', wantConfirm);
  bubbleEl.classList.toggle('has-step', wantStep);
  confirmEl.setAttribute('aria-hidden', String(!wantConfirm));
  // status lines are shown even with the reply bubble turned off: they explain why nothing happens
  const note = phase === 'listening' || phase === 'transcribing' ? localNote || serverNote : phase !== 'idle' && phase !== 'error' ? serverNote : stoppedReply && wantReply ? 'stopped' : '';
  const wantNote = !!note;
  noteEl.textContent = note;
  bubbleEl.classList.toggle('has-note', wantNote);

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

  renderChoice(wantChoice);
  // quick follow-up: "reply" under a finished (or speaking) answer, while nothing else is asked
  const wantReplyBtn = wantReply && !wantChoice && !wantConfirm && !typeOpen && (phase === 'speaking' || lingering) && !isError;
  bubbleEl.classList.toggle('has-reply-btn', wantReplyBtn);

  // busy: a quiet "esc to stop" under whatever the bubble shows; a paused agent run always shows
  const paused = busy?.mode === 'paused';
  const wantStop = !!busy && phase !== 'idle' && phase !== 'error' && !wantConfirm && !wantChoice && !typeOpen && (paused || wantTranscript || wantReply || wantNote || wantStep);
  if (wantStop && busy) {
    stopHintEl.textContent = busy.hint;
    stopBtnText.textContent = busy.mode === 'pause' ? 'pause' : 'stop';
    stopBtn.setAttribute('aria-label', busy.mode === 'pause' ? `pause (${busy.key})` : `stop (${busy.key})`);
  }
  bubbleEl.classList.toggle('has-stop', wantStop);
  bubbleEl.classList.toggle('is-paused', wantStop && paused);

  const want = isError || wantTranscript || wantReply || wantNote || wantConfirm || wantStep || wantChoice || wantStop;
  if (want !== bubbleIn) {
    bubbleIn = want;
    if (want) bubbleSnap = true;
    bubbleEl.classList.toggle('is-in', want);
    api.bubbleVisible(want); // while a finished reply lingers, the stop key (esc) dismisses it
    if (!want) {
      transcriptOpen = false;
      transcriptWrap.classList.remove('is-open');
      bubbleAnchor = null; // next turn pins afresh
      visuals.bubbleGone();
      if (drag?.which === 'bubble') drag = null;
      setHoverInteractive(false);
    }
  }
  kick();
}

function onState(s: OverlayState): void {
  const prev = phase;
  phase = s.phase;
  root.dataset.phase = phase;
  transcript = (s.transcript ?? '').trim();
  serverNote = (s.note ?? '').trim();
  confirmText = (s.confirm ?? '').trim();
  bubbleEl.classList.toggle('confirm-always', !!s.confirmAlways); // agent mode: "a = always allow" 
  stepText = (s.step ?? '').trim();
  stoppedReply = phase === 'idle' && !!s.stopped;
  // closed by the user: a new turn (listening / thinking) brings the bubble back; stale states don't
  if (phase === 'listening' || phase === 'transcribing' || phase === 'thinking') dismissed = false;
  if (dismissed) {
    transcript = serverNote = confirmText = stepText = '';
    stoppedReply = false;
  }
  if (phase !== 'listening' && phase !== 'transcribing') micNote = '';
  localNote = modelNote || micNote;

  if (phase === 'listening') {
    // new turn: clear the old reply, head home if we were pointing
    reply = '';
    setReplyText('');
    returnToCursor();
  } else if (s.reply !== undefined || phase !== 'idle') {
    reply = s.reply ?? (phase === 'idle' ? reply : '');
  }
  if (dismissed) reply = '';

  clearTimeout(errorTimer);
  if (phase === 'error') {
    errorText = (s.error || 'something went wrong').toLowerCase();
    errorTimer = window.setTimeout(() => {
      errorText = '';
      renderBubble();
    }, 8000);
  } else errorText = '';

  clearTimeout(lingerTimer);
  if (phase === 'idle' && prev !== 'idle' && reply) {
    startLinger();
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
  syncPresence();
  renderBubble();
}

/** a finished reply stays a moment (longer while the pointer is on it, so "reply" can be reached) */
/** settings › companion › hide replies after: a moment (default) · keep until dismissed · 10 s · 30 s · 1 min */
function lingerMs(): number {
  switch (config.companion.hideReplies) {
    case 'keep': return Infinity;
    case '10s': return 10_000;
    case '30s': return 30_000;
    case '1m': return 60_000;
    default: return 2600;
  }
}

function startLinger(ms = lingerMs()): void {
  clearTimeout(lingerTimer);
  lingering = true;
  if (ms === Infinity) return; // until the × / the stop key / the next turn
  const tick = (): void => {
    if (hoverInteractive || drag) {
      lingerTimer = window.setTimeout(tick, 800);
      return;
    }
    lingering = false;
    renderBubble();
  };
  lingerTimer = window.setTimeout(tick, ms);
}

/* ───────── choices ([ASK:…]) ───────── */
let choiceKey = '';
function renderChoice(open: boolean): void {
  choiceWrap.classList.toggle('is-open', open);
  bubbleEl.classList.toggle('has-choice', open);
  if (!open || !choice) return; // closing: keep the old pills while they fold away
  const c = choice;
  const key = JSON.stringify([c.options, c.keys]);
  if (key !== choiceKey) {
    choiceKey = key;
    const btns = c.options.map((o, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'opt';
      b.tabIndex = -1;
      if (c.keys) {
        const n = document.createElement('span');
        n.className = 'opt-n';
        n.textContent = String(i + 1);
        b.append(n);
      }
      const t = document.createElement('span');
      t.className = 'opt-t';
      t.textContent = o.toLowerCase();
      b.append(t);
      b.addEventListener('click', () => {
        b.classList.add('is-picked');
        api.choose(i);
      });
      return b;
    });
    const other = document.createElement('button');
    other.type = 'button';
    other.className = 'opt other';
    other.tabIndex = -1;
    other.textContent = 'something else…';
    other.addEventListener('click', () => {
      replyBox = true;
      api.openReply();
    });
    choiceOptsEl.replaceChildren(...btns, other);
  }
  const n = c.options.length;
  choiceHintEl.textContent = c.keys ? `press 1–${n} · or just say it · esc to dismiss` : 'or just say it · esc to dismiss';
}

function onChoice(c: OverlayChoice | null): void {
  const had = !!choice;
  choice = c;
  if (c) {
    dismissed = false;
    reply = c.reply;
    lingering = false;
    clearTimeout(lingerTimer);
    setVisible(true);
  } else if (had && phase === 'idle' && reply) {
    // answered elsewhere / timed out / dismissed: the pills fold away, the reply fades like any other
    startLinger();
  }
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
  if (!open && typeOpen && typeAnchor) lastTypeSpot = { ...keepOnScreen(typeAnchor, typeW, typeH), at: performance.now() };
  // opened while a reply is showing (reply button, "something else…", the type chord): sit right under it
  if (open && !typeOpen && bubbleIn && bubbleAnchor) {
    replyBox = true;
    const bx = bubbleSpring.x;
    const below = bubbleSpring.y + (bubbleH || 44) + 8;
    typeAnchor = below + typeH > window.innerHeight - 12 ? { x: bx, y: bubbleSpring.y - typeH - 8 } : { x: bx, y: below };
  }
  typeOpen = open;
  typeForm.classList.toggle('is-in', open);
  if (!open) {
    typeAnchor = null;
    replyBox = false;
  }
  typeInput.placeholder = open && replyBox ? (choice ? 'your answer…' : 'reply…') : 'ask clickity…';
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
    if (!cursorOnDisplay && mode === 'follow' && !choice) setVisible(false);
  }
  renderBubble();
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
const preloaded = new Set<string>();
/** model status line ("downloading the voice model… 42%") while it matters */
let modelNote = '';
/** mic trouble spotted while still listening */
let micNote = '';
/** a ptt result is pending: forward status to main so it keeps waiting */
let awaitingResult = false;

/** Peak below this is digital silence: the OS is feeding zeros (permission not honoured, muted input). */
const SILENT_PEAK = 0.0005;

function log(level: 'info' | 'warn' | 'error', message: string): void {
  try {
    api.log({ level, message });
  } catch {
    /* preload missing in tests */
  }
}

function refreshNote(): void {
  localNote = modelNote || micNote;
  if (awaitingResult && localNote) api.pttProgress(localNote);
  renderBubble();
}

let lastLoggedQuarter = -1;
function onModelStatus(st: LocalSttStatus): void {
  if (config.stt?.provider !== 'on-device' || st.model !== config.stt.model) return;
  if (st.state === 'downloading') modelNote = `downloading the voice model… ${st.progress}%`;
  else if (st.state === 'loading') modelNote = awaitingResult ? 'loading the voice model…' : '';
  else modelNote = '';
  if (st.state === 'downloading' && Math.floor(st.progress / 25) !== lastLoggedQuarter) {
    lastLoggedQuarter = Math.floor(st.progress / 25);
    log('info', `downloading voice model ${st.model}: ${st.progress}%`);
  }
  if (st.state === 'ready') log('info', `voice model ready: ${st.model} on ${st.device} in ${st.ms}ms`);
  if (st.state === 'error') log('error', `voice model failed: ${st.model}: ${st.message}`);
  refreshNote();
}
onLocalSttStatus(onModelStatus);

function maybePreload(stt: OverlayConfig['stt'] | undefined): void {
  if (!stt || stt.provider !== 'on-device' || !stt.model || preloaded.has(stt.model)) return;
  preloaded.add(stt.model);
  log('info', `preloading voice model ${stt.model}`);
  try {
    preloadLocalModel(stt.model);
  } catch (e) {
    console.warn('[overlay] preload failed', e);
  }
}

let preloadTimer = 0;
/** Warm up the on-device model shortly after start, so the first talk isn't a long wait. */
function schedulePreload(): void {
  if (!config.preloadStt || config.stt?.provider !== 'on-device' || preloaded.has(config.stt.model)) return;
  clearTimeout(preloadTimer);
  preloadTimer = window.setTimeout(() => maybePreload(config.stt), 2500);
}

function errMessage(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return (m || 'recording failed').toLowerCase();
}

function onPttStart(): void {
  pttStartedAt = performance.now();
  micNote = '';
  const st = config.stt?.provider === 'on-device' ? localSttStatus(config.stt.model) : undefined;
  if (st?.state === 'downloading') modelNote = `downloading the voice model… ${st.progress}%`;
  speaker.stop();
  // Start the mic FIRST. Loading/compiling Whisper (wasm) blocks this thread for a while, so
  // kicking it off before getUserMedia resolves delayed recording and lost the first words.
  // Once capture runs, audio is buffered by the worklet even while the model loads.
  mic
    .start()
    .then(() => {
      const d = mic.details;
      if (d) log('info', `mic started: "${d.device}" ${d.sampleRate}hz context=${d.contextState} capture=${d.capture}`);
      maybePreload(config.stt);
    })
    .catch((e: unknown) => {
      // tell the user now, not only after they let go
      micNote = errMessage(e);
      log('error', `mic start failed: ${errMessage(e)} (${(e as { name?: string })?.name ?? 'error'})`);
      refreshNote();
    });
  kick();
}

async function onPttStop(req: PttStopRequest): Promise<void> {
  const durationMs = pttStartedAt ? Math.round(performance.now() - pttStartedAt) : 0;
  pttStartedAt = 0;
  awaitingResult = true;
  let peak: number | undefined;
  try {
    let rec: Awaited<ReturnType<MicRecorder['stop']>>;
    try {
      rec = await mic.stop();
    } catch (e) {
      api.sendPttResult({ error: errMessage(e), errorKind: 'mic', durationMs });
      return;
    }
    // a tap shorter than the first worklet/script buffer has no samples yet: that is an accidental
    // press (handled below), not a dead microphone
    if (!rec.pcm.length && durationMs >= 250) {
      const why = rec.contextState === 'suspended' ? 'the audio engine was suspended' : 'no samples arrived';
      log('error', `no audio captured after ${durationMs}ms (${why})`);
      api.sendPttResult({ error: 'no audio from the microphone — check your input device in sound settings', errorKind: 'mic', durationMs, peak: 0 });
      return;
    }
    peak = peakLevel(rec.pcm);
    log('info', `mic stopped: ${durationMs}ms, ${(rec.pcm.length / rec.sampleRate).toFixed(2)}s of audio at ${rec.sampleRate}hz, peak ${peak.toFixed(4)}`);
    if (durationMs < 250 || peak < SILENT_PEAK) {
      // accidental tap or pure silence: nothing to transcribe; main explains
      api.sendPttResult({ text: '', durationMs, peak });
      return;
    }
    const pcm = await resampleTo16k(rec.pcm, rec.sampleRate);
    if (req.stt.provider !== 'on-device') {
      api.sendPttResult({ wav: encodeWav(pcm, 16000), durationMs, peak });
      return;
    }
    const st = localSttStatus(req.stt.model);
    if (!st || st.state !== 'ready') {
      modelNote = st?.state === 'downloading' ? `downloading the voice model… ${st.progress}%` : 'loading the voice model…';
      refreshNote();
    }
    preloaded.add(req.stt.model);
    const t0 = performance.now();
    let text: string;
    try {
      text = await transcribeLocal(pcm, req.stt.model, req.stt.language || undefined);
    } catch (e) {
      const reason = errMessage(e).split('\n')[0].slice(0, 120);
      log('error', `on-device transcription failed: ${reason}`);
      if (e instanceof ModelLoadError) {
        api.sendPttResult({
          error: `voice model failed to load — check your connection or pick another speech-to-text in settings › voice (${reason})`,
          errorKind: 'model',
          durationMs,
          peak,
        });
      } else {
        api.sendPttResult({ error: `transcription failed: ${reason}`, errorKind: 'stt', durationMs, peak });
      }
      return;
    }
    const done = localSttStatus(req.stt.model);
    api.sendPttResult({
      text: text.trim(),
      durationMs,
      peak,
      sttMs: Math.round(performance.now() - t0),
      sttDevice: done?.state === 'ready' ? done.device : undefined,
    });
  } catch (e) {
    api.sendPttResult({ error: errMessage(e), durationMs, peak });
  } finally {
    awaitingResult = false;
    modelNote = '';
    refreshNote();
  }
}

/* ───────── ink trail ─────────
 * While the talk chord is held, every overlay draws the cursor's path (main broadcasts the
 * cursor to all of them), so a circle that crosses displays shows on each. It stays until the
 * screenshots are taken (they may capture it; main also draws it into them), then fades. */
const INK_JITTER = 6; // px of total extent before anything is drawn: a plain talk leaves no scribble
const INK_WIDTH = 3;
const INK_MAX_POINTS = 1200;
const inkCtx = inkCanvas.getContext('2d');
let ink: { pts: Array<{ x: number; y: number }>; recording: boolean; shown: boolean; fading: boolean } | null = null;
let inkColors: { ink: string; halo: string } | null = null;
let inkFade: Animation | null = null;
let inkRaf = 0;
let inkSafety = 0;
let cursorGlobal: { x: number; y: number } | null = null;

function sizeInkCanvas(): void {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(window.innerWidth * dpr);
  const h = Math.round(window.innerHeight * dpr);
  if (inkCanvas.width !== w || inkCanvas.height !== h) {
    inkCanvas.width = w;
    inkCanvas.height = h;
    drawInk();
  }
}
window.addEventListener('resize', sizeInkCanvas);
sizeInkCanvas();

/** Same taper as the screenshot stroke (src/main/gesture.ts): thin tail, full body, slightly thin tip. */
function inkTaper(f: number): number {
  const s = (e0: number, e1: number, x: number) => {
    const t = clamp((x - e0) / (e1 - e0), 0, 1);
    return t * t * (3 - 2 * t);
  };
  return 0.35 + 0.65 * s(0, 0.18, f) * (1 - 0.3 * s(0.9, 1, f));
}

function resetInk(): void {
  clearTimeout(inkSafety);
  inkFade?.cancel();
  inkFade = null;
  ink = null;
  if (inkCtx) inkCtx.clearRect(0, 0, inkCanvas.width, inkCanvas.height);
}

function scheduleInk(): void {
  if (!inkRaf) inkRaf = requestAnimationFrame(() => {
    inkRaf = 0;
    drawInk();
  });
}

function drawInk(): void {
  if (!inkCtx) return;
  const ctx = inkCtx;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, inkCanvas.width, inkCanvas.height);
  if (!ink?.shown || ink.pts.length < 2) return;
  if (!inkColors) {
    const cs = getComputedStyle(root);
    inkColors = {
      ink: cs.getPropertyValue('--buddy').trim() || cs.getPropertyValue('--ink').trim() || '#111',
      halo: cs.getPropertyValue('--bg-elev').trim() || '#fff',
    };
  }
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const b = config.displayBounds;
  const pts = ink.pts.map((p) => ({ x: p.x - b.x, y: p.y - b.y }));
  const n = pts.length;
  const cum = [0];
  for (let i = 1; i < n; i++) cum.push(cum[i - 1]! + Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y));
  const total = cum[n - 1] || 1;
  const mid = (a: { x: number; y: number }, c: { x: number; y: number }) => ({ x: (a.x + c.x) / 2, y: (a.y + c.y) / 2 });
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // two passes: a soft halo so it shows on any background, then the ink.
  // Each piece is a quadratic through the midpoints (smooth), with its own width (taper).
  for (const pass of ['halo', 'ink'] as const) {
    ctx.strokeStyle = pass === 'halo' ? inkColors.halo : inkColors.ink;
    for (let i = 1; i < n; i++) {
      const from = i === 1 ? pts[0]! : mid(pts[i - 1]!, pts[i]!);
      const to = i === n - 1 ? pts[i]! : mid(pts[i]!, pts[i + 1]!);
      const w = INK_WIDTH * inkTaper(cum[i]! / total);
      ctx.lineWidth = pass === 'halo' ? w + 2.5 : w;
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      if (i === n - 1) ctx.lineTo(to.x, to.y);
      else ctx.quadraticCurveTo(pts[i]!.x, pts[i]!.y, to.x, to.y);
      ctx.stroke();
    }
  }
}

function inkCursor(p: { x: number; y: number }): void {
  cursorGlobal = { x: p.x, y: p.y };
  if (!ink?.recording) return;
  const last = ink.pts[ink.pts.length - 1];
  if (last && Math.hypot(p.x - last.x, p.y - last.y) < 1.5) return;
  ink.pts.push({ x: p.x, y: p.y });
  if (ink.pts.length > INK_MAX_POINTS) ink.pts = ink.pts.filter((_, i, a) => i === 0 || i === a.length - 1 || i % 2 === 0);
  if (!ink.shown) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const q of ink.pts) {
      minX = Math.min(minX, q.x);
      minY = Math.min(minY, q.y);
      maxX = Math.max(maxX, q.x);
      maxY = Math.max(maxY, q.y);
    }
    if (Math.max(maxX - minX, maxY - minY) < INK_JITTER) return;
    ink.shown = true;
  }
  scheduleInk();
}

function onInk(cmd: InkCommand): void {
  if (cmd === 'start') {
    resetInk();
    inkColors = null;
    ink = { pts: cursorGlobal ? [cursorGlobal] : [], recording: true, shown: false, fading: false };
    return;
  }
  if (!ink) return;
  if (cmd === 'end') {
    ink.recording = false;
    // main clears it once the screenshots are taken; never leave a stray trail behind
    clearTimeout(inkSafety);
    inkSafety = window.setTimeout(() => onInk('clear'), 15_000);
    return;
  }
  // 'clear'
  if (ink.fading) return;
  ink.recording = false;
  if (!ink.shown || reducedMotion) return resetInk();
  ink.fading = true;
  clearTimeout(inkSafety);
  inkFade = inkCanvas.animate([{ opacity: 0.85 }, { opacity: 0 }], { duration: 1500, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)', fill: 'forwards' });
  inkFade.onfinish = () => resetInk();
}

/* ───────── wiring ───────── */
api.onConfig((c) => {
  const prevFollow = config.companion.followCursor;
  const prevShow = config.companion.show;
  config = c;
  mic.setDevice(c.stt?.micId); // settings › voice › microphone (falls back to the default)
  root.dataset.show = c.companion.show || 'always';
  scale = clamp(c.companion.scale || 1, 0.5, 2.5);
  root.style.setProperty('--s', String(scale));
  if (c.companion.color) root.style.setProperty('--buddy', c.companion.color);
  else root.style.removeProperty('--buddy');
  applyTheme();
  if ((prevFollow !== c.companion.followCursor || prevShow !== c.companion.show) && mode === 'follow') {
    const t = followTarget();
    follow.snap(t.x, t.y);
  }
  if (!c.companion.pointing && (mode !== 'follow' || currentPoint)) returnToCursor();
  if (c.companion.show === 'never' && mode !== 'follow' && currentPoint) pointAt(currentPoint);
  if (ink) inkColors = null;
  schedulePreload();
  renderBubble();
  kick();
});

api.onCursor((p) => {
  inkCursor(p);
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
  setVisible(inside || mode !== 'follow' || typeOpen || !!currentPoint || !!choice);
  if (inside || mode !== 'follow') kick();
});

api.onState(onState);

api.onPoint((p) => {
  // agent mode flies to its click targets even when "point at things" is off
  if (p && (config.companion.pointing || phase === 'acting')) pointAt(p);
  else returnToCursor();
});
api.onClick(clickAt);
api.onInk(onInk);
api.onVisuals((v) => {
  visuals.set(v);
  kick();
});
api.onChoice(onChoice);
api.onBusy((b) => {
  busy = b;
  renderBubble();
});
stopBtn.addEventListener('click', () => api.stop());
closeBtn.addEventListener('click', () => dismissBubble(true));
api.onDismiss(() => dismissBubble(false));

/**
 * Get rid of the bubble now (× or the stop key over a lingering reply). A turn still running
 * (speaking, streaming, walkthrough, agent run) or a waiting choice is stopped too; its cards /
 * 3D models close with it, and the next bubble opens fresh at the cursor.
 */
function dismissBubble(byClick: boolean): void {
  const running = (phase !== 'idle' && phase !== 'error') || !!choice || !!busy;
  if (byClick && running) api.stop(true);
  dismissed = true;
  reply = transcript = errorText = serverNote = stepText = confirmText = '';
  stoppedReply = false;
  lingering = false;
  clearTimeout(lingerTimer);
  clearTimeout(errorTimer);
  setReplyText('');
  visuals.set(null);
  if (drag?.which === 'bubble') drag = null;
  bubbleAnchor = null;
  renderBubble();
  if (!typeOpen) setHoverInteractive(false);
}
continueBtn.addEventListener('click', () => api.resume());
replyBtn.addEventListener('click', () => {
  replyBox = true;
  api.openReply();
});

api.onPttStart(onPttStart);
api.onPttStop((req) => void onPttStop(req));
api.onPttCancel(() => {
  pttStartedAt = 0;
  micNote = '';
  mic.cancel();
});

// Uncaught renderer errors end up in clickity.log too (console errors are forwarded by main).
window.addEventListener('unhandledrejection', (e) => log('error', `unhandled rejection: ${errMessage(e.reason)}`));

api.onSpeak((cmd: SpeakCommand) => {
  clearTimeout(autoReturnTimer);
  speaker.speak(cmd);
  kick();
});
api.onStopSpeaking(() => speaker.stop());
api.onTextInput(setTypeBox);

root.dataset.phase = phase;
root.dataset.show = 'always';
applyTheme();
api.ready();

/* ───────── dragging the bubble / type box ─────────
 * The overlay is click-through. While the pointer is over the bubble (mouse moves are
 * forwarded on macOS/Windows), ask main to make the window accept clicks so the bubble can
 * be dragged; give the clicks back to the apps underneath as soon as it leaves. */
function setHoverInteractive(on: boolean): void {
  if (on === hoverInteractive) return;
  hoverInteractive = on;
  api.setInteractive(on);
}
function startDrag(which: 'bubble' | 'type', e: PointerEvent): void {
  if (e.button !== 0) return;
  const anchor = which === 'bubble' ? bubbleAnchor : typeAnchor;
  if (!anchor) return;
  const cur = which === 'bubble' ? { x: bubbleSpring.x, y: bubbleSpring.y } : keepOnScreen(anchor, typeW, typeH);
  drag = { which, dx: e.clientX - cur.x, dy: e.clientY - cur.y, id: e.pointerId };
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  document.documentElement.classList.add('dragging');
  e.preventDefault();
}
function moveDrag(e: PointerEvent): void {
  if (!drag || e.pointerId !== drag.id) return;
  const p = { x: e.clientX - drag.dx, y: e.clientY - drag.dy };
  if (drag.which === 'bubble') bubbleAnchor = p;
  else typeAnchor = p;
  kick();
}
function endDrag(e: PointerEvent): void {
  if (!drag || e.pointerId !== drag.id) return;
  drag = null;
  document.documentElement.classList.remove('dragging');
  const el = e.currentTarget as HTMLElement;
  if (!el.matches(':hover') && !typeOpen) setHoverInteractive(false);
}
bubbleEl.addEventListener('pointerenter', () => setHoverInteractive(true));
bubbleEl.addEventListener('pointerleave', () => {
  if (!drag && !typeOpen) setHoverInteractive(false);
});
bubbleEl.addEventListener('pointerdown', (e) => {
  if ((e.target as Element | null)?.closest('button')) return; // pills / reply are clicks, not drags
  if ((e.target as Element | null)?.closest('.reply-text')) return; // the reply text can be selected (and copied)
  startDrag('bubble', e);
});
bubbleEl.addEventListener('pointermove', moveDrag);
bubbleEl.addEventListener('pointerup', endDrag);
bubbleEl.addEventListener('pointercancel', endDrag);
// the type box drags by its frame (not the text field, so selecting text still works)
typeForm.addEventListener('pointerdown', (e) => {
  if (e.target === typeInput) return;
  startDrag('type', e);
});
typeForm.addEventListener('pointermove', moveDrag);
typeForm.addEventListener('pointerup', endDrag);
typeForm.addEventListener('pointercancel', endDrag);
