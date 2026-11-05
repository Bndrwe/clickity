// Cards and 3D models under an assistant message. 3D canvases are created only while their row is
// on screen (one WebGL context each; browsers drop old ones past ~16), and freed when it scrolls away.
import type { ChatVisual } from '../../shared/visuals';
import { renderVisual, type VisualHandle } from '../shared/visuals';

const live = new Map<string, { box: HTMLElement; io: IntersectionObserver | null; handles: VisualHandle[] }>();

function unmount(id: string): void {
  const e = live.get(id);
  if (!e) return;
  e.io?.disconnect();
  for (const h of e.handles) h.dispose();
  live.delete(id);
}

/** Free everything (the transcript is being replaced). */
export function disposeAllVisuals(): void {
  for (const id of [...live.keys()]) unmount(id);
}

/** Forget one turn's visuals (it is being re-rendered). */
export function disposeVisuals(turnId: string): void {
  unmount(turnId);
}

/** The element to put under the message text. */
export function renderTurnVisuals(turnId: string, visuals: ChatVisual[]): HTMLElement {
  unmount(turnId);
  const box = document.createElement('div');
  box.className = 'msg-visuals';
  const entry = { box, io: null as IntersectionObserver | null, handles: [] as VisualHandle[] };
  live.set(turnId, entry);

  const mount = (): void => {
    if (entry.handles.length) return;
    for (const v of visuals) {
      const h = renderVisual(v, { size: v.type === 'model3d' ? 176 : undefined });
      entry.handles.push(h);
      box.append(h.el);
    }
  };
  const drop = (): void => {
    for (const h of entry.handles) {
      h.dispose();
      h.el.remove();
    }
    entry.handles = [];
  };

  if (typeof IntersectionObserver === 'undefined') mount();
  else {
    entry.io = new IntersectionObserver(
      (es) => {
        for (const e of es) e.isIntersecting ? mount() : drop();
      },
      { rootMargin: '120px' },
    );
    // keep the row's height while its canvases are not mounted, so scrolling does not jump
    box.style.minHeight = visuals.some((v) => v.type === 'model3d') ? '208px' : '0';
    entry.io.observe(box);
  }
  return box;
}
