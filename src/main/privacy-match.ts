// Privacy controls, the pure parts (unit tested: test/privacy.test.ts): matching app names /
// window titles against settings.privacy.neverCapture, which windows cover which display, the
// "didn't look" lines, and the cheap blur-except-the-cursor compositing on raw BGRA bitmaps.
// The platform probes and the private-mode timer live in privacy.ts.

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One top-level window as a platform probe saw it (bounds in global DIP). */
export interface ProbedWindow {
  /** linux: the X window id (for the minimised check) */
  id?: string;
  app: string;
  title: string;
  bounds: Rect | null;
}

/** "1Password.app" → "1password", "KeePassXC.exe" → "keepassxc", "Keychain-Access" → "keychain access" */
export function normalizeName(s: string): string {
  return String(s ?? '')
    .toLowerCase()
    .replace(/\.(app|exe)\b/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** The usable, normalised, deduped list entries. */
export function cleanList(list: unknown): string[] {
  const out: string[] = [];
  for (const e of Array.isArray(list) ? list : []) {
    if (typeof e !== 'string') continue;
    const t = e.trim().slice(0, 80);
    if (t && !out.some((o) => normalizeName(o) === normalizeName(t)) && normalizeName(t)) out.push(t);
    if (out.length >= 100) break;
  }
  return out;
}

/** The list entry that matches `name` as a whole word / phrase, or null. */
export function matchName(list: string[], name: string): string | null {
  const n = normalizeName(name);
  if (!n) return null;
  const padded = ` ${n} `;
  const compact = n.replace(/ /g, '');
  for (const entry of list) {
    const e = normalizeName(entry);
    if (!e) continue;
    if (padded.includes(` ${e} `)) return entry;
    // "1password7", "keepassxc-2": the entry glued to a version number
    if (compact.startsWith(e.replace(/ /g, '')) && /^\d*$/.test(compact.slice(e.replace(/ /g, '').length))) return entry;
  }
  return null;
}

/** Does a window cover a meaningful part of a display? (a sliver at the edge doesn't count) */
export function covers(win: Rect, display: Rect, minPx = 24): boolean {
  const w = Math.min(win.x + win.width, display.x + display.width) - Math.max(win.x, display.x);
  const h = Math.min(win.y + win.height, display.y + display.height) - Math.max(win.y, display.y);
  return w >= minPx && h >= minPx;
}

export interface PrivacyVerdict {
  /** set: no screen at all ("1password is open") */
  all: string | null;
  /** display id → the entry whose window is on it (those screens are left out) */
  displays: Map<number, string>;
}

/**
 * Decide what not to capture. A focused never-capture app hides every screen (we may not know
 * where its window is); a never-capture window (app or title) hides the display(s) it's on, or
 * everything when its position is unknown.
 */
export function privacyVerdict(list: string[], front: string, windows: ProbedWindow[], displays: Array<{ id: number; bounds: Rect }>): PrivacyVerdict {
  const verdict: PrivacyVerdict = { all: null, displays: new Map() };
  if (!list.length) return verdict;
  const hitFront = matchName(list, front);
  if (hitFront) {
    verdict.all = hitFront;
    return verdict;
  }
  for (const w of windows) {
    const hit = matchName(list, w.app) ?? matchName(list, w.title);
    if (!hit) continue;
    if (!w.bounds) {
      verdict.all = hit;
      return verdict;
    }
    for (const d of displays) if (covers(w.bounds, d.bounds) && !verdict.displays.has(d.id)) verdict.displays.set(d.id, hit);
  }
  if (displays.length && displays.every((d) => verdict.displays.has(d.id))) verdict.all = verdict.displays.get(displays[0]!.id)!;
  return verdict;
}

/** The bubble's quiet line. */
export function privacyLine(reason: { kind: 'private'; minutesLeft: number } | { kind: 'app'; name: string; partial?: boolean }): string {
  if (reason.kind === 'private') {
    const m = Math.max(1, Math.ceil(reason.minutesLeft));
    return `didn't look — private for ${m} more min`;
  }
  const name = normalizeName(reason.name) || 'a private app';
  return reason.partial ? `didn't look at one screen — ${name} is open there` : `didn't look — ${name} is open`;
}

/** What the model is told when it gets no (or fewer) screenshots for privacy reasons. */
export function privacyModelNote(partial: boolean): string {
  return partial
    ? '(note: one of the user\'s screens was left out on purpose because a private app is open there. do not guess what is on it.)'
    : '(note: the user\'s screen was NOT shared this turn on purpose (privacy: a private app is open or private mode is on). you cannot see the screen — do not guess or point; answer from the words alone, or ask them to describe it.)';
}

/* ───────── blur except around the cursor ───────── */

/** The sharp box (image pixels) around the cursor: about `box` DIP, clamped inside the image. */
export function sharpRect(img: { width: number; height: number }, display: Rect, cursor: { x: number; y: number }, box = { width: 560, height: 380 }): Rect | null {
  if (cursor.x < display.x || cursor.y < display.y || cursor.x >= display.x + display.width || cursor.y >= display.y + display.height) return null;
  const sx = img.width / display.width;
  const sy = img.height / display.height;
  const w = Math.min(img.width, Math.round(box.width * sx));
  const h = Math.min(img.height, Math.round(box.height * sy));
  const cx = (cursor.x - display.x) * sx;
  const cy = (cursor.y - display.y) * sy;
  const x = Math.round(Math.min(Math.max(0, cx - w / 2), img.width - w));
  const y = Math.round(Math.min(Math.max(0, cy - h / 2), img.height - h));
  return { x, y, width: w, height: h };
}

/** Copy `rect` of a BGRA bitmap `src` into `dst` (same size). Mutates and returns `dst`. */
export function pasteRect(dst: Buffer, src: Buffer, width: number, rect: Rect): Buffer {
  const height = Math.floor(dst.length / 4 / width);
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(width, Math.floor(rect.x + rect.width));
  const y1 = Math.min(height, Math.floor(rect.y + rect.height));
  if (x1 <= x0 || y1 <= y0 || src.length !== dst.length) return dst;
  for (let y = y0; y < y1; y++) {
    const a = (y * width + x0) * 4;
    src.copy(dst, a, a, (y * width + x1) * 4);
  }
  return dst;
}

/** How small the heavy blur shrinks a screen (≈ 56 px wide for a 1568 px screenshot: no text survives). */
export function blurWidth(width: number): number {
  return Math.max(8, Math.round(width / 28));
}
