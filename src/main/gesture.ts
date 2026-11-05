// Cursor gestures while talking: the path the cursor takes while the talk chord is held
// (global DIP, timestamped), a loose classification (circled / underlined / pointed), a short
// description in screenshot pixels for the model, and an ink stroke drawn into the screenshot.
// Pure (no electron imports) so it can be unit tested with `node --experimental-strip-types --test`.

export interface TimedPoint {
  x: number;
  y: number;
  /** ms (any monotonic clock) */
  t: number;
}

export interface GesturePath {
  points: TimedPoint[];
  /** when recording stopped (talk up); a cursor resting at the end dwells until then */
  endT: number;
}

/** The slice of capture.ts' CapturedScreen this module needs. */
export interface GestureScreen {
  index: number;
  bounds: { x: number; y: number; width: number; height: number };
  image: { width: number; height: number };
}

export type GestureKind = 'still' | 'circle' | 'line' | 'point' | 'area';

export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface Gesture {
  kind: GestureKind;
  bbox: Box;
  start: { x: number; y: number };
  end: { x: number; y: number };
  /** longest rest of the cursor (center, ms), when it rested ≥ DWELL_MS */
  dwell?: { x: number; y: number; ms: number };
  /** path length in the input's units */
  length: number;
}

/** keep at most this many points (older ones are thinned out, never the first / last) */
export const MAX_POINTS = 600;
/** below this total extent (DIP) the cursor didn't really move: nothing is drawn */
export const JITTER_PX = 6;
/** below this extent (DIP) the path is too small to be a gesture */
export const MEANINGFUL_PX = 24;
/** a rest this long counts as pointing */
export const DWELL_MS = 600;
const DWELL_RADIUS = 10;
const MIN_STEP = 2;

/* ───────────────────────── recording ───────────────────────── */

export function newPath(p: { x: number; y: number }, t: number): GesturePath {
  return { points: [{ x: p.x, y: p.y, t }], endT: t };
}

/** Append a cursor sample: tiny moves are skipped, and past MAX_POINTS every other point goes. */
export function addPoint(path: GesturePath, x: number, y: number, t: number): void {
  const pts = path.points;
  const last = pts[pts.length - 1];
  path.endT = Math.max(path.endT, t);
  if (last && Math.hypot(x - last.x, y - last.y) < MIN_STEP) return;
  pts.push({ x, y, t });
  if (pts.length > MAX_POINTS) decimate(pts);
}

/** Drop every other interior point (first and last stay). Mutates. */
export function decimate(pts: TimedPoint[]): void {
  if (pts.length < 3) return;
  const kept: TimedPoint[] = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) if (i % 2 === 0) kept.push(pts[i]);
  kept.push(pts[pts.length - 1]);
  pts.splice(0, pts.length, ...kept);
}

/** Stop recording at `t`, with the cursor's final position. */
export function finishPath(path: GesturePath, x: number, y: number, t: number): GesturePath {
  addPoint(path, x, y, t);
  path.endT = Math.max(path.endT, t);
  return path;
}

/* ───────────────────────── geometry ───────────────────────── */

export function bboxOf(pts: Array<{ x: number; y: number }>): Box {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

/** Largest side of the path's bounding box (0 for < 2 points). */
export function extentOf(pts: Array<{ x: number; y: number }>): number {
  if (pts.length < 2) return 0;
  const b = bboxOf(pts);
  return Math.max(b.maxX - b.minX, b.maxY - b.minY);
}

function pathLength(pts: Array<{ x: number; y: number }>): number {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return len;
}

/** Total signed turning of the path around its bbox center, in radians. */
function winding(pts: Array<{ x: number; y: number }>, b: Box): number {
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  let total = 0;
  let prev = Math.atan2(pts[0].y - cy, pts[0].x - cx);
  for (let i = 1; i < pts.length; i++) {
    const a = Math.atan2(pts[i].y - cy, pts[i].x - cx);
    let d = a - prev;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    total += d;
    prev = a;
  }
  return total;
}

/** Longest stretch where the cursor stayed within DWELL_RADIUS (≥ DWELL_MS), else undefined. */
function longestDwell(pts: TimedPoint[], endT: number): Gesture['dwell'] {
  let best: Gesture['dwell'];
  for (let i = 0; i < pts.length; i++) {
    let j = i;
    while (j + 1 < pts.length && Math.hypot(pts[j + 1].x - pts[i].x, pts[j + 1].y - pts[i].y) <= DWELL_RADIUS) j++;
    // it rested from arriving at i until it left (the next point's time) or recording stopped
    const leftAt = j + 1 < pts.length ? pts[j + 1].t : endT;
    const ms = leftAt - pts[i].t;
    if (ms >= DWELL_MS && (!best || ms > best.ms)) {
      let sx = 0;
      let sy = 0;
      for (let k = i; k <= j; k++) {
        sx += pts[k].x;
        sy += pts[k].y;
      }
      best = { x: sx / (j - i + 1), y: sy / (j - i + 1), ms };
    }
  }
  return best;
}

/**
 * Loosely classify a path:
 *  - still: it barely moved (extent < MEANINGFUL_PX)
 *  - circle: it goes (nearly) all the way around something, or closes on itself
 *  - point: it moved somewhere and then rested there (or rested anywhere, if it isn't a line)
 *  - line: mostly straight (underline / swipe)
 *  - area: anything else (scribbled over / moved around an area)
 */
export function classify(path: GesturePath): Gesture {
  const pts = path.points;
  const bbox = bboxOf(pts);
  const start = { x: pts[0].x, y: pts[0].y };
  const end = { x: pts[pts.length - 1].x, y: pts[pts.length - 1].y };
  const length = pathLength(pts);
  const w = bbox.maxX - bbox.minX;
  const h = bbox.maxY - bbox.minY;
  const dwell = longestDwell(pts, path.endT);
  const base = { bbox, start, end, length, dwell };
  if (pts.length < 2 || Math.max(w, h) < MEANINGFUL_PX) return { kind: 'still', ...base };

  const diag = Math.hypot(w, h);
  const gap = Math.hypot(end.x - start.x, end.y - start.y);
  const turned = Math.abs(winding(pts, bbox));
  // a wide ellipse around a heading still counts; a flat back-and-forth line doesn't
  const roundish = Math.min(w, h) >= Math.max(16, 0.12 * Math.max(w, h));
  if (roundish && (turned >= 1.6 * Math.PI || (gap <= 0.3 * diag && length >= 1.8 * diag && turned >= 1.1 * Math.PI))) {
    return { kind: 'circle', ...base };
  }

  const straight = length > 0 ? gap / length : 0;
  // moved to a spot and kept the cursor there: that's pointing, not underlining
  const restsAtEnd = !!dwell && Math.hypot(dwell.x - end.x, dwell.y - end.y) <= DWELL_RADIUS * 1.5;
  if (straight >= 0.8 && !restsAtEnd) return { kind: 'line', ...base };
  if (dwell && (restsAtEnd || straight < 0.8)) return { kind: 'point', ...base };
  if (straight >= 0.8) return { kind: 'line', ...base };
  return { kind: 'area', ...base };
}

/* ───────────────────────── screens ───────────────────────── */

function distToRect(p: { x: number; y: number }, b: GestureScreen['bounds']): number {
  const dx = Math.max(b.x - p.x, 0, p.x - (b.x + b.width - 1));
  const dy = Math.max(b.y - p.y, 0, p.y - (b.y + b.height - 1));
  return Math.hypot(dx, dy);
}

/** The screen a global DIP point is on (or nearest to). */
export function screenFor<S extends GestureScreen>(p: { x: number; y: number }, screens: S[]): S | undefined {
  let best: S | undefined;
  let bestD = Infinity;
  for (const s of screens) {
    const d = distToRect(p, s.bounds);
    if (d < bestD) {
      best = s;
      bestD = d;
    }
  }
  return best;
}

/** Global DIP → pixel in that screen's screenshot (inverse of capture.screenshotToGlobal), unclamped. */
export function globalToScreenshot(s: GestureScreen, x: number, y: number): { x: number; y: number } {
  return {
    x: ((x - s.bounds.x) * s.image.width) / s.bounds.width,
    y: ((y - s.bounds.y) * s.image.height) / s.bounds.height,
  };
}

function clampToImage(s: GestureScreen, p: { x: number; y: number }): { x: number; y: number } {
  return {
    x: Math.round(Math.min(s.image.width - 1, Math.max(0, p.x))),
    y: Math.round(Math.min(s.image.height - 1, Math.max(0, p.y))),
  };
}

export interface GestureSummary {
  /** one or two sentences for the model ('' if nothing to say) */
  text: string;
  /** tiny note stored with the user turn ("circled an area on screen 1"), '' when the cursor stayed put */
  note: string;
  /** the per-screen gestures that were described (kind !== 'still') */
  parts: Array<{ screen: number; kind: GestureKind; box: Box }>;
}

/**
 * Describe what the cursor did, per screen, in screenshot pixels, plus where it ended.
 * Path points are global DIP; screens are the turn's screenshots.
 */
export function summarizeGesture(path: GesturePath | null, final: { x: number; y: number }, screens: GestureScreen[]): GestureSummary {
  const none: GestureSummary = { text: '', note: '', parts: [] };
  if (!screens.length) return none;
  const endScreen = screenFor(final, screens);
  if (!endScreen) return none;
  const endPx = clampToImage(endScreen, globalToScreenshot(endScreen, final.x, final.y));
  const endText = `${endPx.x},${endPx.y} on screen ${endScreen.index}`;

  const sentences: string[] = [];
  const notes: string[] = [];
  const parts: GestureSummary['parts'] = [];
  if (path && path.points.length >= 2) {
    // group points by the screen they're on, keeping order
    const groups = new Map<GestureScreen, TimedPoint[]>();
    for (const p of path.points) {
      const s = screenFor(p, screens);
      if (!s) continue;
      if (!groups.has(s)) groups.set(s, []);
      groups.get(s)!.push(p);
    }
    for (const [s, pts] of groups) {
      if (pts.length < 2) continue;
      const g = classify({ points: pts, endT: s === endScreen ? path.endT : pts[pts.length - 1].t });
      if (g.kind === 'still') continue;
      const a = clampToImage(s, globalToScreenshot(s, g.bbox.minX, g.bbox.minY));
      const b = clampToImage(s, globalToScreenshot(s, g.bbox.maxX, g.bbox.maxY));
      const box: Box = { minX: a.x, minY: a.y, maxX: b.x, maxY: b.y };
      parts.push({ screen: s.index, kind: g.kind, box });
      const area = `x ${a.x}–${b.x}, y ${a.y}–${b.y} on screen ${s.index}`;
      const st = clampToImage(s, globalToScreenshot(s, g.start.x, g.start.y));
      const en = clampToImage(s, globalToScreenshot(s, g.end.x, g.end.y));
      switch (g.kind) {
        case 'circle':
          sentences.push(`While speaking, the user circled the area ${area} (drawn as an ink outline in the screenshot).`);
          notes.push(`circled an area on screen ${s.index}`);
          break;
        case 'line': {
          const flat = Math.abs(g.end.y - g.start.y) < 0.35 * Math.abs(g.end.x - g.start.x);
          const verb = flat ? 'underlined' : 'swiped';
          sentences.push(`While speaking, the user ${verb} from ${st.x},${st.y} to ${en.x},${en.y} on screen ${s.index} (drawn as an ink line in the screenshot).`);
          notes.push(`${verb} something on screen ${s.index}`);
          break;
        }
        case 'point': {
          const d = clampToImage(s, globalToScreenshot(s, g.dwell!.x, g.dwell!.y));
          sentences.push(`While speaking, the user pointed at ${d.x},${d.y} on screen ${s.index} by resting the cursor there (its path is drawn as an ink line in the screenshot).`);
          notes.push(`pointed at something on screen ${s.index}`);
          break;
        }
        case 'area':
          sentences.push(`While speaking, the user moved the cursor around the area ${area} (drawn as an ink line in the screenshot).`);
          notes.push(`gestured over an area on screen ${s.index}`);
          break;
      }
    }
  }
  if (sentences.length) {
    const what = parts.some((p) => p.kind === 'circle') ? 'what they circled' : parts.some((p) => p.kind === 'line') ? 'what they marked' : 'what they pointed at';
    sentences.push(`Their cursor ended at ${endText}. When they say "this", "that" or "here", they mean ${what} or what is under the cursor.`);
  } else {
    sentences.push(`The user's mouse cursor is at ${endText}. If they say "this", "that" or "here" without naming anything, they probably mean what is under the cursor.`);
  }
  return { text: sentences.join(' '), note: notes.join(', '), parts };
}

/* ───────────────────────── drawing into a screenshot ───────────────────────── */

export interface StrokeStyle {
  /** stroke width in image pixels (the middle of the stroke; the ends taper) */
  width: number;
  /** ink color [r, g, b] */
  color: [number, number, number];
  /** halo color drawn under the ink so it shows on any background */
  halo: [number, number, number];
  /** ink opacity 0..1 */
  alpha: number;
}

/** Chaikin corner cutting: a smoother polyline with the same ends. */
export function smoothPath(pts: Array<{ x: number; y: number }>, iterations = 2): Array<{ x: number; y: number }> {
  let cur = pts;
  for (let it = 0; it < iterations && cur.length > 2; it++) {
    const next: Array<{ x: number; y: number }> = [cur[0]];
    for (let i = 0; i < cur.length - 1; i++) {
      const a = cur[i];
      const b = cur[i + 1];
      next.push({ x: 0.75 * a.x + 0.25 * b.x, y: 0.75 * a.y + 0.25 * b.y }, { x: 0.25 * a.x + 0.75 * b.x, y: 0.25 * a.y + 0.75 * b.y });
    }
    next.push(cur[cur.length - 1]);
    cur = next;
  }
  return cur;
}

/** Stroke radius multiplier along the path (0..1 = start..end): thin tail, full body, slightly thin tip. */
export function taper(f: number): number {
  const s = (e0: number, e1: number, x: number) => {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  };
  return 0.35 + 0.65 * s(0, 0.18, f) * (1 - 0.3 * s(0.9, 1, f));
}

/**
 * Draw an antialiased, tapered stroke with a halo into a raw 4-byte-per-pixel bitmap
 * (BGRA by default, as Electron's NativeImage.toBitmap()). Points are image pixels.
 * Returns false when nothing was drawn.
 */
export function drawStroke(
  buf: Uint8Array,
  width: number,
  height: number,
  points: Array<{ x: number; y: number }>,
  style: StrokeStyle,
  order: 'bgra' | 'rgba' = 'bgra',
): boolean {
  if (points.length < 2 || width <= 0 || height <= 0 || buf.length < width * height * 4) return false;
  const pts = smoothPath(points);
  const n = pts.length;
  // cumulative length → taper fraction per point
  const cum = new Float64Array(n);
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  const total = cum[n - 1] || 1;
  const r0 = Math.max(0.5, style.width / 2);
  const haloExtra = Math.max(1.2, style.width * 0.6);
  const ink = new Float32Array(width * height);
  const halo = new Float32Array(width * height);
  let drew = false;

  for (let i = 1; i < n; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const ra = r0 * taper(cum[i - 1] / total);
    const rb = r0 * taper(cum[i] / total);
    const reach = Math.max(ra, rb) + haloExtra + 1;
    const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x) - reach));
    const x1 = Math.min(width - 1, Math.ceil(Math.max(a.x, b.x) + reach));
    const y0 = Math.max(0, Math.floor(Math.min(a.y, b.y) - reach));
    const y1 = Math.min(height - 1, Math.ceil(Math.max(a.y, b.y) + reach));
    if (x0 > x1 || y0 > y1) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5;
        const py = y + 0.5;
        const t = len2 > 0 ? Math.min(1, Math.max(0, ((px - a.x) * dx + (py - a.y) * dy) / len2)) : 0;
        const d = Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
        const r = ra + (rb - ra) * t;
        const k = y * width + x;
        const ci = Math.min(1, Math.max(0, r - d + 0.5));
        if (ci > ink[k]) ink[k] = ci;
        const ch = Math.min(1, Math.max(0, r + haloExtra - d + 0.5));
        if (ch > halo[k]) halo[k] = ch;
        if (ci > 0) drew = true;
      }
    }
  }
  if (!drew) return false;

  const [ri, gi, bi] = style.color;
  const [rh, gh, bh] = style.halo;
  const [R, G, B] = order === 'bgra' ? [2, 1, 0] : [0, 1, 2];
  const haloAlpha = 0.7 * style.alpha;
  for (let k = 0; k < ink.length; k++) {
    const h = halo[k] * haloAlpha;
    const c = ink[k] * style.alpha;
    if (h <= 0 && c <= 0) continue;
    const o = k * 4;
    let r = buf[o + R];
    let g = buf[o + G];
    let b = buf[o + B];
    if (h > 0) {
      r += (rh - r) * h;
      g += (gh - g) * h;
      b += (bh - b) * h;
    }
    if (c > 0) {
      r += (ri - r) * c;
      g += (gi - g) * c;
      b += (bi - b) * c;
    }
    buf[o + R] = Math.round(r);
    buf[o + G] = Math.round(g);
    buf[o + B] = Math.round(b);
  }
  return true;
}

/** '#rrggbb' → [r, g, b] (fallback for anything else). */
export function hexToRgb(hex: string, fallback: [number, number, number]): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return fallback;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
