// Proactive tips, overlay side: a tiny dot on the companion when a tip is waiting (nothing is
// spoken), a quiet key hint for a few seconds, and a small bubble with the tip plus "not now" /
// "stop tips" once it's opened (tip key, or a click on the dot). Main decides everything (tips.ts).
import type { OverlayApi } from '../../shared/ipc';
import type { OverlayConfig, OverlayTip } from '../../shared/types';

const api: OverlayApi = window.overlay;
const reduced = matchMedia('(prefers-reduced-motion: reduce)');

const css = `
.tp-dot {
  position: fixed; left: 0; top: 0; width: 18px; height: 18px; margin: -9px 0 0 -9px; border-radius: 50%;
  display: grid; place-items: center; pointer-events: none; will-change: transform;
}
.tp-dot i {
  width: 7px; height: 7px; border-radius: 50%; background: var(--buddy, var(--ink)); box-shadow: 0 0 0 2px var(--bg-elev), 0 2px 6px -1px var(--shadow);
  opacity: 0; transform: scale(.3); transition: opacity .5s var(--ease), transform .6s var(--ease);
}
.tp-dot.is-in { pointer-events: auto; cursor: pointer; }
.tp-dot.is-in i { opacity: 1; transform: none; }
.tp-dot.is-in:hover i { transform: scale(1.3); }
.tp-hint {
  position: fixed; left: 0; top: 0; font: 500 11px/1 var(--sans); letter-spacing: .01em; text-transform: lowercase; white-space: nowrap;
  color: var(--ink-muted); background: var(--bg-elev); padding: 5px 9px 6px; border-radius: 999px;
  box-shadow: 0 8px 18px -10px var(--shadow), 0 0 0 1px var(--line); opacity: 0; transition: opacity .4s var(--ease);
}
.tp-hint.is-in { opacity: 1; }
.tp-pos { position: fixed; left: 0; top: 0; will-change: transform; }
.tp-card {
  position: relative; width: max-content; max-width: 340px; padding: 12px 16px 12px; border-radius: 16px;
  background: var(--bg-elev); color: var(--ink-2); font: 400 14.5px/1.5 var(--sans); letter-spacing: -0.006em;
  box-shadow: var(--float, 0 18px 40px -18px var(--shadow)), 0 0 0 1px var(--line);
  opacity: 0; visibility: hidden; transform: translateY(6px) scale(.985); transform-origin: 0 0;
  transition: opacity .32s var(--ease-soft), transform .4s var(--ease-soft), visibility 0s linear .4s;
}
.tp-card.is-in { opacity: 1; visibility: visible; transform: none; transition: opacity .5s var(--ease), transform .65s var(--ease), visibility 0s; pointer-events: auto; }
.tp-card .tp-eyebrow { margin: 0 0 4px; font: 500 11.5px/1.2 var(--sans); color: var(--ink-muted); text-transform: lowercase; letter-spacing: .01em; }
.tp-card .tp-text { margin: 0; }
.tp-card .tp-actions { display: flex; align-items: center; gap: 6px; margin-top: 9px; font: 500 12px/1 var(--sans); color: var(--ink-muted); text-transform: lowercase; }
.tp-card button { all: unset; cursor: pointer; color: var(--ink-muted); padding: 3px 0; pointer-events: auto; position: relative; }
.tp-card button:hover, .tp-card button:focus-visible { color: var(--ink); }
.tp-card .tp-actions span { color: var(--faint); }
.tp-card .tp-close { position: absolute; top: 7px; right: 8px; width: 20px; height: 20px; display: grid; place-items: center; border-radius: 999px; padding: 0; }
.tp-card .tp-close:hover { background: var(--bg-sunken); }
.tp-card .tp-close svg { width: 10px; height: 10px; stroke: currentColor; stroke-width: 1.5; fill: none; stroke-linecap: round; }
.tp-card .tp-text { padding-right: 18px; }
`;
const style = document.createElement('style');
style.textContent = css;
document.head.append(style);

const layer = document.createElement('div');
layer.className = 'x-layer tp-layer';
layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:6';
const dot = document.createElement('div');
dot.className = 'tp-dot';
dot.setAttribute('role', 'button');
dot.setAttribute('aria-label', 'show the tip');
dot.append(document.createElement('i'));
const hint = document.createElement('div');
hint.className = 'tp-hint';
const card = document.createElement('div');
card.className = 'tp-card';
card.setAttribute('role', 'status');
card.setAttribute('aria-live', 'polite');
card.innerHTML =
  '<button class="tp-close" type="button" aria-label="close" data-a="close"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6"/></svg></button>' +
  '<p class="tp-eyebrow">tip</p><p class="tp-text"></p>' +
  '<div class="tp-actions"><button type="button" data-a="not-now">not now</button><span aria-hidden="true">·</span><button type="button" data-a="stop">stop tips</button></div>';
const cardText = card.querySelector<HTMLElement>('.tp-text')!;
const cardPos = document.createElement('div');
cardPos.className = 'tp-pos';
cardPos.append(card);
layer.append(dot, hint, cardPos);
document.body.append(layer);

const companion = document.getElementById('companion');
const stage = document.getElementById('stage');

let config: OverlayConfig | null = null;
let tip: OverlayTip | null = null;
let cursor: { x: number; y: number } | null = null;
let onDisplay = false;
let raf = 0;
let hintTimer = 0;
let interactive = false;

function scale(): number {
  return Number(getComputedStyle(document.documentElement).getPropertyValue('--s')) || 1;
}

/** where the companion's arrow tip is (local px), or the cursor + offset when it isn't drawn */
function anchor(): { x: number; y: number } | null {
  const shown = companion && stage && !stage.classList.contains('is-hidden') && document.documentElement.dataset.show !== 'never';
  if (shown) {
    const r = companion!.getBoundingClientRect();
    if (r.left || r.top) return { x: r.left, y: r.top };
  }
  if (!cursor || !config) return null;
  const b = config.displayBounds;
  return { x: cursor.x - b.x + (config.companion.offsetX ?? 18), y: cursor.y - b.y + (config.companion.offsetY ?? 20) };
}

function place(): void {
  raf = 0;
  if (!tip || !onDisplay) return;
  const a = anchor();
  if (!a) return;
  const s = scale();
  let dx = a.x + 15 * s;
  let dy = a.y + 2 * s;
  // the companion follows the cursor, so a dot glued to it could never be clicked: it rests where
  // it is once the cursor has been still for a moment, and catches up again once you move away
  const local = localCursor();
  if (rest && local && Math.hypot(local.x - rest.x, local.y - rest.y) > 150) rest = null;
  if (!rest && performance.now() - lastMove > 600 && dot.classList.contains('is-in')) rest = { x: dx, y: dy };
  if (rest) {
    dx = rest.x;
    dy = rest.y;
  }
  dot.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
  if (hint.classList.contains('is-in')) {
    const x = Math.min(dx + 12, window.innerWidth - hint.offsetWidth - 8);
    hint.style.transform = `translate3d(${x}px, ${dy - 11}px, 0)`;
  }
  if (card.classList.contains('is-in')) {
    const w = card.offsetWidth || 300;
    const h = card.offsetHeight || 90;
    let x = a.x + 22 * s;
    let y = a.y + 28 * s;
    if (x + w > window.innerWidth - 12) x = a.x - w - 10 * s;
    if (y + h > window.innerHeight - 12) y = a.y - h - 10 * s;
    cardPos.style.transform = `translate3d(${Math.max(12, x)}px, ${Math.max(12, y)}px, 0)`;
  }
  // keep following the companion while something shows
  if (dot.classList.contains('is-in') || card.classList.contains('is-in')) raf = requestAnimationFrame(place);
}

function kick(): void {
  if (!raf) raf = requestAnimationFrame(place);
}

let lastMove = performance.now();
let rest: { x: number; y: number } | null = null;

function localCursor(): { x: number; y: number } | null {
  if (!cursor || !config) return null;
  return { x: cursor.x - config.displayBounds.x, y: cursor.y - config.displayBounds.y };
}

function setInteractive(on: boolean): void {
  if (on === interactive) return;
  interactive = on;
  api.setInteractive(on);
}

/** the overlay is click-through: take clicks only while the pointer is over the dot / card */
function hover(): void {
  if (!cursor || !config || !tip || !onDisplay) return setInteractive(false);
  const b = config.displayBounds;
  const x = cursor.x - b.x;
  const y = cursor.y - b.y;
  const inside = (el: HTMLElement, pad: number) => {
    if (!el.classList.contains('is-in')) return false;
    const r = el.getBoundingClientRect();
    return x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad;
  };
  const overDot = inside(dot, 4);
  setInteractive(overDot || inside(card, 2));
  if (overDot && tip && !tip.open) showHint(2500);
}

function showHint(ms: number): void {
  if (!tip) return;
  hint.textContent = tip.keyLabel ? `tip · ${tip.keyLabel}` : 'tip · click the dot';
  hint.classList.add('is-in');
  clearTimeout(hintTimer);
  hintTimer = window.setTimeout(() => hint.classList.remove('is-in'), ms);
  kick();
}

function render(): void {
  const show = !!tip && onDisplay;
  const open = show && !!tip!.open && !!tip!.text;
  dot.classList.toggle('is-in', show && !open);
  if (open) {
    cardText.textContent = tip!.text!.toLowerCase();
    hint.classList.remove('is-in');
  }
  card.classList.toggle('is-in', open);
  if (!show) {
    hint.classList.remove('is-in');
    setInteractive(false);
  }
  kick();
}

dot.addEventListener('click', () => {
  if (tip && !tip.open) api.tipOpen(tip.id);
});
card.addEventListener('click', (e) => {
  const a = (e.target as HTMLElement).closest<HTMLElement>('[data-a]')?.dataset.a;
  if (a === 'close' || a === 'not-now' || a === 'stop') {
    api.tipAction(a);
    setInteractive(false);
  }
});

api.onConfig((c) => {
  config = c;
});
api.onCursor((p) => {
  if (!cursor || cursor.x !== p.x || cursor.y !== p.y) lastMove = performance.now();
  cursor = p;
  const b = config?.displayBounds;
  const inside = !!b && p.x >= b.x && p.y >= b.y && p.x < b.x + b.width && p.y < b.y + b.height;
  if (inside !== onDisplay) {
    onDisplay = inside;
    render();
  }
  if (tip) {
    hover();
    kick();
  }
});
api.onTip((t) => {
  const fresh = !!t && t.id !== tip?.id;
  if (fresh || !t) rest = null;
  tip = t;
  render();
  if (fresh && !t!.open) showHint(reduced.matches ? 6000 : 4500);
});
