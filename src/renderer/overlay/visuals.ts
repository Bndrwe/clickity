// Cards and 3D models floating by the reply bubble. They sit under it (or above, if there is no
// room), are pinned like the bubble, can be dragged by their frame, and leave with the bubble
// unless the user touched them (rotated, zoomed, dragged). The overlay is click-through, so
// hovering a card asks main to accept clicks (the same mechanism the bubble uses).
import type { ChatVisual } from '../../shared/visuals';
import { renderVisual, type VisualHandle } from '../shared/visuals';

interface Hooks {
  stage: HTMLElement;
  /** accept clicks while the pointer is over a card (overlay.ts setHoverInteractive) */
  setInteractive(on: boolean): void;
  /** schedule a frame */
  kick(): void;
}

const GAP = 10;
const MARGIN = 12;

export interface OverlayVisuals {
  /** show these (null / empty = remove all) */
  set(visuals: ChatVisual[] | null): void;
  /** called every frame with the bubble's box; moves the stack next to it */
  place(bubble: { x: number; y: number; w: number; h: number; shown: boolean }): void;
  /** the reply bubble went away: drop the cards unless the user touched them */
  bubbleGone(): void;
  readonly active: boolean;
}

export function createOverlayVisuals(hooks: Hooks): OverlayVisuals {
  const pos = document.createElement('div');
  pos.className = 'pos visuals-pos';
  pos.setAttribute('aria-hidden', 'true');
  const stack = document.createElement('div');
  stack.className = 'visuals-stack';
  pos.append(stack);
  hooks.stage.append(pos);

  let handles: { h: VisualHandle; v: ChatVisual }[] = [];
  let interacted = false;
  /** where the user dragged the stack to (overlay-local px) */
  let manual: { x: number; y: number } | null = null;
  let hovering = false;
  let drag: { dx: number; dy: number; id: number } | null = null;
  let shownKey = '';

  function clear(): void {
    for (const { h } of handles) h.dispose();
    handles = [];
    stack.replaceChildren();
    interacted = false;
    manual = null;
    shownKey = '';
    pos.style.visibility = 'hidden';
    if (hovering && !drag) {
      hovering = false;
      hooks.setInteractive(false);
    }
  }

  function remove(entry: { h: VisualHandle; v: ChatVisual }): void {
    entry.h.dispose();
    entry.h.el.remove();
    handles = handles.filter((x) => x !== entry);
    if (!handles.length) clear();
    hooks.kick();
  }

  function set(visuals: ChatVisual[] | null): void {
    const list = visuals ?? [];
    const key = JSON.stringify(list);
    if (key === shownKey && handles.length) return;
    clear();
    if (!list.length) return;
    shownKey = key;
    for (const v of list) {
      const entry = { v, h: null as unknown as VisualHandle };
      entry.h = renderVisual(v, {
        size: 220,
        onClose: () => remove(entry),
        onInteract: () => {
          interacted = true;
        },
      });
      handles.push(entry);
      stack.append(entry.h.el);
    }
    pos.style.visibility = 'visible';
    hooks.kick();
  }

  function place(b: { x: number; y: number; w: number; h: number; shown: boolean }): void {
    if (!handles.length) return;
    const w = stack.offsetWidth || 240;
    const h = stack.offsetHeight || 240;
    const W = window.innerWidth;
    const H = window.innerHeight;
    let x: number;
    let y: number;
    if (manual) {
      x = manual.x;
      y = manual.y;
    } else if (b.shown) {
      x = b.x;
      y = b.y + b.h + GAP;
      if (y + h > H - MARGIN) {
        // no room below: try above the bubble, then beside it
        if (b.y - GAP - h >= MARGIN) y = b.y - GAP - h;
        else {
          x = b.x + b.w + GAP + w <= W - MARGIN ? b.x + b.w + GAP : b.x - GAP - w;
          y = b.y;
        }
      }
    } else {
      x = MARGIN;
      y = MARGIN;
    }
    x = Math.min(Math.max(MARGIN, x), Math.max(MARGIN, W - w - MARGIN));
    y = Math.min(Math.max(MARGIN, y), Math.max(MARGIN, H - h - MARGIN));
    pos.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
    last = { x, y };
  }
  let last = { x: 0, y: 0 };

  function bubbleGone(): void {
    if (!interacted) clear();
  }

  // click-through: accept clicks while hovering a card
  pos.addEventListener('pointerover', (e) => {
    if (!(e.target as Element).closest('.vcard') || hovering) return;
    hovering = true;
    hooks.setInteractive(true);
  });
  pos.addEventListener('pointerleave', () => {
    if (drag) return;
    hovering = false;
    hooks.setInteractive(false);
  });
  pos.addEventListener('pointerout', (e) => {
    // moving from a card onto empty stack padding / gap
    const to = e.relatedTarget as Element | null;
    if (!drag && hovering && (!to || !pos.contains(to) || !to.closest('.vcard'))) {
      hovering = false;
      hooks.setInteractive(false);
    }
  });

  // drag the stack by a card's frame (the canvas rotates the model instead, buttons click)
  pos.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !(e.target as Element).closest('.vcard')) return;
    if ((e.target as Element).closest('button')) return;
    drag = { dx: e.clientX - last.x, dy: e.clientY - last.y, id: e.pointerId };
    pos.setPointerCapture(e.pointerId);
    interacted = true;
    document.documentElement.classList.add('dragging');
    e.preventDefault();
  });
  pos.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    manual = { x: e.clientX - drag.dx, y: e.clientY - drag.dy };
    hooks.kick();
  });
  const end = (e: PointerEvent): void => {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    document.documentElement.classList.remove('dragging');
    if (!pos.matches(':hover')) {
      hovering = false;
      hooks.setInteractive(false);
    }
  };
  pos.addEventListener('pointerup', end);
  pos.addEventListener('pointercancel', end);

  pos.style.visibility = 'hidden';
  return {
    set,
    place,
    bubbleGone,
    get active() {
      return handles.length > 0;
    },
  };
}
