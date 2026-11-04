// [POINT:x,y:label:screenN] tags (see ARCHITECTURE.md "Pointing protocol"). Pure, unit tested.

const POINT_TAG_RE = /\[POINT:[^\]\n]*\]/gi;
/** A tag that has started streaming but isn't closed yet, at the very end of the buffer. */
const PARTIAL_TAG_RE = /\[(?:P(?:O(?:I(?:N(?:T(?::[^\]\n]*)?)?)?)?)?)?$/i;

export interface ParsedPoint {
  x: number;
  y: number;
  label: string;
  /** 1-based screen index, undefined = cursor screen */
  screen?: number;
}

/** Visible text while streaming: complete tags removed, a trailing partial tag hidden. */
export function stripForDisplay(buffer: string): string {
  return buffer.replace(POINT_TAG_RE, '').replace(PARTIAL_TAG_RE, '').replace(/[ \t]+\n/g, '\n').trimEnd();
}

/** Final text: every tag (and any dangling fragment) removed, whitespace tidied. */
export function stripPointTags(text: string): string {
  return text
    .replace(POINT_TAG_RE, '')
    .replace(PARTIAL_TAG_RE, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Parse `[POINT:x,y:label:screenN]` tags. `[POINT:none]` and malformed tags are skipped. */
export function parsePointTags(text: string): ParsedPoint[] {
  const out: ParsedPoint[] = [];
  for (const m of text.matchAll(POINT_TAG_RE)) {
    const inner = m[0].slice('[POINT:'.length, -1).trim();
    if (!inner || /^none$/i.test(inner)) continue;
    const parts = inner.split(':').map((p) => p.trim());
    const coords = /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/.exec(parts[0]);
    if (!coords) continue;
    let screenIdx: number | undefined;
    const last = parts[parts.length - 1];
    const screenMatch = parts.length > 1 ? /^screen\s*(\d+)$/i.exec(last) : null;
    if (screenMatch) {
      screenIdx = Number(screenMatch[1]);
      parts.pop();
    }
    const label = parts.slice(1).join(':').trim() || 'here';
    out.push({ x: Number(coords[1]), y: Number(coords[2]), label, screen: screenIdx });
  }
  return out;
}


/**
 * The screenshot a point refers to. No :screenN → the cursor's screen. A screen number that
 * wasn't sent is skipped (null) rather than mapped onto the cursor screen at a wrong spot;
 * ":screen0" is read as the first screen (models sometimes count from 0).
 */
export function pickPointScreen<S extends { index: number; isCursorScreen: boolean }>(p: ParsedPoint, screens: S[]): S | null {
  if (p.screen === undefined) return screens.find((s) => s.isCursorScreen) ?? screens[0] ?? null;
  const n = p.screen === 0 ? 1 : p.screen;
  return screens.find((s) => s.index === n) ?? null;
}
