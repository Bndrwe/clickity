// Motion for the chats window, built on anime.js (v4).
// One signature moment — the mark's three "click" ticks fire whenever clickity
// starts answering — and otherwise quiet, quick entrances. Everything is skipped
// (final state applied instantly) under prefers-reduced-motion.
import { animate, spring, stagger } from 'animejs';

const reduced = (): boolean => matchMedia('(prefers-reduced-motion: reduce)').matches;
const EASE = 'outExpo';

/** A new message rises into the transcript. */
export function enterMessage(node: HTMLElement): void {
  if (reduced()) return;
  node.style.opacity = '0';
  animate(node, {
    opacity: [0, 1],
    translateY: [node.classList.contains('user') ? 14 : 8, 0],
    duration: 620,
    ease: EASE,
    onComplete: () => {
      node.style.removeProperty('opacity');
      node.style.removeProperty('transform');
    },
  });
}

/**
 * The signature: the tick marks around the cursor tip burst outward and settle,
 * like the cursor just clicked. Works on any rendered Clickity mark <svg>.
 */
export function clickTicks(svg: Element | null | undefined): void {
  if (!svg || reduced()) return;
  const ticks = svg.querySelectorAll('line');
  const arrow = svg.querySelector('polygon');
  if (!ticks.length) return;
  animate(ticks, {
    opacity: [0, 1],
    scale: [0.2, 1.25, 1],
    duration: 560,
    delay: stagger(55),
    ease: 'outQuart',
  });
  if (arrow) {
    animate(arrow, {
      scale: [1, 0.86, 1],
      duration: 380,
      ease: 'inOutQuad',
    });
  }
}

/** Empty state: greeting, composer and hint arrive in sequence. */
export function enterEmptyState(parts: Array<Element | null>): void {
  const els = parts.filter((p): p is Element => !!p);
  if (reduced() || !els.length) return;
  animate(els, {
    opacity: [0, 1],
    translateY: [18, 0],
    duration: 900,
    delay: stagger(90),
    ease: EASE,
  });
}

/** Sidebar rows settle in, one after another. */
export function enterList(rows: ArrayLike<Element>): void {
  if (reduced() || !rows.length) return;
  animate(rows, {
    opacity: [0, 1],
    translateX: [-6, 0],
    duration: 420,
    delay: stagger(28, { start: 60 }),
    ease: EASE,
  });
}

/** The send button gives a small springy push when a message goes out. */
export function pressSend(btn: HTMLElement): void {
  if (reduced()) return;
  animate(btn, {
    scale: [0.84, 1],
    ease: spring({ stiffness: 320, damping: 14 }),
  });
}

/** Popovers open from their anchor. */
export function openPopover(el: HTMLElement): void {
  if (reduced()) return;
  animate(el, {
    opacity: [0, 1],
    scale: [0.96, 1],
    translateY: [-4, 0],
    duration: 260,
    ease: 'outCubic',
  });
}
