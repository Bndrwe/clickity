// Renders a ChatVisual (a 2D card or a draggable 3D model) as an Opal-styled floating card.
// Shared by the overlay (floating by the bubble) and the chats window (under the message).
// Styles: visuals.css (copied next to each window's own css by scripts/build.mjs).
import * as THREE from 'three';
import { MODEL3D_KINDS, type ChatVisual, type Model3DVisual } from '../../shared/visuals';
import { buildModel, disposeTree, type Palette } from './models3d';

export interface VisualOptions {
  /** edge length of a 3D model's canvas in css px (default 220) */
  size?: number;
  /** show a small × (overlay); called when it is clicked */
  onClose?: () => void;
  /** the user dragged / zoomed / pressed the model (overlay: keeps the card after the bubble goes) */
  onInteract?: () => void;
}

export interface VisualHandle {
  el: HTMLElement;
  /** stop rendering and free the WebGL context */
  dispose(): void;
}

const reduced = (): boolean => matchMedia('(prefers-reduced-motion: reduce)').matches;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function palette(): Palette {
  const root = document.documentElement;
  // Opal windows mark dark mode with .dark; the chats window is always dark (color-scheme: dark)
  const dark = root.classList.contains('dark') || /^dark$/.test(getComputedStyle(root).colorScheme.trim());
  return dark ? { solid: 0xcfcfcb, edge: 0x3b3b39, dark } : { solid: 0xe7e7e3, edge: 0x6a6a67, dark };
}

function closeButton(onClose: () => void): HTMLButtonElement {
  const b = el('button', 'vcard-close');
  b.type = 'button';
  b.setAttribute('aria-label', 'close');
  b.innerHTML = '<svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><path d="M2 2l8 8M10 2l-8 8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClose();
  });
  // a click on × must not start dragging the card
  b.addEventListener('pointerdown', (e) => e.stopPropagation());
  return b;
}

function renderCard(v: Extract<ChatVisual, { type: 'card' }>, opts: VisualOptions): VisualHandle {
  const root = el('div', 'vcard vcard-2d');
  root.dataset.visual = 'card';
  root.append(el('h4', 'vcard-title', v.title));
  const list = el('ul', 'vcard-lines');
  for (const line of v.lines) list.append(el('li', '', line));
  root.append(list);
  if (opts.onClose) root.append(closeButton(opts.onClose));
  return { el: root, dispose() {} };
}

function render3D(v: Model3DVisual, opts: VisualOptions): VisualHandle {
  const size = opts.size ?? 220;
  const root = el('div', 'vcard vcard-3d');
  root.dataset.visual = 'model3d';
  root.dataset.kind = v.kind;
  root.style.setProperty('--vsize', `${size}px`);
  const stage = el('div', 'vcard-stage');
  root.append(stage, el('p', 'vcard-label', v.label));
  if (opts.onClose) root.append(closeButton(opts.onClose));

  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
  } catch {
    stage.classList.add('no-gl');
    stage.append(el('span', 'vcard-fallback', v.kind.replace(/-/g, ' ')));
    return { el: root, dispose() {} };
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(size, size);
  renderer.setClearColor(0x000000, 0);
  const canvas = renderer.domElement;
  canvas.className = 'vcard-canvas';
  canvas.setAttribute('aria-label', `${v.label} (3d model, drag to rotate, scroll to zoom)`);
  canvas.setAttribute('role', 'img');
  stage.append(canvas);

  const scene = new THREE.Scene();
  const p = palette();
  const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 50);
  const built = buildModel(v.kind, p);
  const pivot = new THREE.Group();
  pivot.add(built.group);
  scene.add(pivot);
  scene.add(new THREE.HemisphereLight(0xffffff, p.dark ? 0x444444 : 0x888888, 1.1));
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(3, 4, 5);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xffffff, 0.7);
  rim.position.set(-4, -1, -3);
  scene.add(rim);

  const baseDist = built.distance ?? 5.2;
  let zoom = 1;
  const rot = { x: 0.18, y: -0.5 };
  pivot.rotation.set(rot.x, rot.y, 0);
  const still = reduced();
  let idleSince = performance.now();
  let interacted = false;
  const touch = (): void => {
    idleSince = performance.now();
    if (!interacted) {
      interacted = true;
      opts.onInteract?.();
    }
    dirty = true;
  };

  let dirty = true;
  let raf = 0;
  let last = performance.now();
  const t0 = last;
  const frame = (now: number): void => {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const spinning = !still && !dragging && now - idleSince > 2500;
    if (spinning) {
      rot.y += dt * 0.45;
      pivot.rotation.set(rot.x, rot.y, 0);
    }
    const animated = !!built.update && !still;
    if (!spinning && !animated && !dirty) return;
    dirty = false;
    built.update?.(still ? 0.8 : (now - t0) / 1000);
    camera.position.set(0, 0, baseDist / zoom);
    camera.lookAt(0, 0, 0);
    renderer.render(scene, camera);
  };
  raf = requestAnimationFrame(frame);

  let dragging = false;
  let px = 0;
  let py = 0;
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.stopPropagation(); // the card's own drag (overlay) is for its frame, not the model
    dragging = true;
    px = e.clientX;
    py = e.clientY;
    canvas.setPointerCapture(e.pointerId);
    canvas.classList.add('is-grabbing');
    touch();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    rot.y += (e.clientX - px) * 0.012;
    rot.x = Math.max(-1.4, Math.min(1.4, rot.x + (e.clientY - py) * 0.012));
    px = e.clientX;
    py = e.clientY;
    pivot.rotation.set(rot.x, rot.y, 0);
    touch();
  });
  const end = (e: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    canvas.classList.remove('is-grabbing');
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    idleSince = performance.now();
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      zoom = Math.max(0.55, Math.min(2.4, zoom * Math.exp(-e.deltaY * 0.0014)));
      touch();
    },
    { passive: false },
  );

  return {
    el: root,
    dispose() {
      cancelAnimationFrame(raf);
      disposeTree(scene);
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    },
  };
}

export function renderVisual(v: ChatVisual, opts: VisualOptions = {}): VisualHandle {
  // stored chats come from disk: never trust the shape
  const ok = v && (v.type === 'card' ? typeof v.title === 'string' && Array.isArray(v.lines) : v.type === 'model3d' && (MODEL3D_KINDS as readonly string[]).includes(v.kind));
  if (!ok) return { el: document.createElement('span'), dispose() {} };
  return v.type === 'card' ? renderCard(v, opts) : render3D(v, opts);
}
