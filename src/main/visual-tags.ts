// [CARD:title|line|line…] and [MODEL3D:kind|label] tags: a 2D card or a draggable 3D model shown
// next to the reply (see ARCHITECTURE.md "Cards and 3D models"). Pure, unit tested.
//
//   [CARD:water|two hydrogens, one oxygen|bent at 104.5 degrees|boils at 100 C]
//   [MODEL3D:molecule-h2o|a water molecule]
//
// Fields are separated by '|'; a literal '|' is written '\|', ']' as '\]', '\' as '\\'.
import { MODEL3D_KINDS, type ChatVisual, type Model3DKind } from '../shared/visuals.ts';

export const MAX_CARD_LINES = 6;
export const MAX_VISUALS = 3;
const MAX_TITLE = 48;
const MAX_LINE = 90;
const MAX_LABEL = 40;
const HEADS = ['CARD', 'MODEL3D'] as const;

interface RawTag {
  head: (typeof HEADS)[number];
  fields: string[];
  start: number;
  end: number; // exclusive; buffer length when unclosed
  closed: boolean;
}

function headAt(text: string, open: number): (typeof HEADS)[number] | null {
  for (const h of HEADS) if (text.slice(open + 1, open + 2 + h.length).toUpperCase() === `${h}:`) return h;
  return null;
}

function scan(text: string): RawTag[] {
  const out: RawTag[] = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('[', i);
    if (open < 0) break;
    const head = headAt(text, open);
    if (!head) {
      i = open + 1;
      continue;
    }
    const fields: string[] = [''];
    let j = open + 2 + head.length;
    let closed = false;
    for (; j < text.length; j++) {
      const c = text[j]!;
      if (c === '\\' && (text[j + 1] === ']' || text[j + 1] === '|' || text[j + 1] === '\\')) {
        fields[fields.length - 1] += text[j + 1];
        j++;
        continue;
      }
      if (c === ']') {
        closed = true;
        break;
      }
      if (c === '|') {
        fields.push('');
        continue;
      }
      fields[fields.length - 1] += c;
    }
    if (!closed) {
      out.push({ head, fields, start: open, end: text.length, closed: false });
      break;
    }
    out.push({ head, fields, start: open, end: j + 1, closed: true });
    i = j + 1;
  }
  return out;
}

/** "[", "[C", "[CAR", "[MODEL" … at the very end while streaming. */
function partialHeadAt(text: string): number {
  const open = text.lastIndexOf('[');
  if (open < 0) return -1;
  const tail = text.slice(open + 1).toUpperCase();
  return HEADS.some((h) => `${h}:`.startsWith(tail)) ? open : -1;
}

/**
 * Remove [CARD:…] / [MODEL3D:…] tags. With `streaming`, also hide a trailing unclosed tag and a
 * partial head like "[MOD". A finished reply drops an unclosed tag too.
 */
export function stripVisualTags(text: string, streaming = false): string {
  const tags = scan(text);
  let out = '';
  let pos = 0;
  for (const t of tags) {
    out += text.slice(pos, t.start);
    pos = t.end;
  }
  let rest = text.slice(pos);
  if (streaming) {
    const p = partialHeadAt(rest);
    if (p >= 0) rest = rest.slice(0, p);
  }
  // tidy only once a tag is complete (or the reply is finished): an unclosed one is still growing
  if (!tags.some((t) => t.closed) && (streaming || !tags.length)) return out + rest;
  return (out + rest).replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trimEnd();
}

function clean(s: string, max: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
}

const ALIASES: Record<string, Model3DKind> = {
  box: 'cube',
  ball: 'sphere',
  globe: 'planet-earth',
  earth: 'planet-earth',
  planet: 'planet-earth',
  water: 'molecule-h2o',
  h2o: 'molecule-h2o',
  'water-molecule': 'molecule-h2o',
  co2: 'molecule-co2',
  'carbon-dioxide': 'molecule-co2',
  dna: 'dna-helix',
  helix: 'dna-helix',
  'double-helix': 'dna-helix',
  axes: 'arrow-axes',
  axis: 'arrow-axes',
  xyz: 'arrow-axes',
  'xyz-axes': 'arrow-axes',
  solar: 'solar-system',
  'solar_system': 'solar-system',
  cogwheel: 'gear',
  donut: 'torus',
  ring: 'torus',
};

/** "Molecule_H2O" → "molecule-h2o" → a known kind, or null. */
export function normalizeKind(raw: string): Model3DKind | null {
  const k = raw.trim().toLowerCase().replace(/[\s_]+/g, '-');
  if ((MODEL3D_KINDS as readonly string[]).includes(k)) return k as Model3DKind;
  return ALIASES[k] ?? null;
}

/**
 * Every usable tag, in order: cards need a title and at least one line (extra lines beyond six
 * are dropped); models need a known kind. Duplicates are dropped, at most three visuals kept.
 */
export function parseVisualTags(text: string): ChatVisual[] {
  const out: ChatVisual[] = [];
  const seen = new Set<string>();
  for (const t of scan(text)) {
    if (!t.closed) continue;
    let v: ChatVisual | null = null;
    if (t.head === 'CARD') {
      const [title = '', ...rest] = t.fields;
      const lines = rest.map((l) => clean(l, MAX_LINE)).filter(Boolean).slice(0, MAX_CARD_LINES);
      const ttl = clean(title, MAX_TITLE);
      if (ttl && lines.length) v = { type: 'card', title: ttl, lines };
    } else {
      const kind = normalizeKind(t.fields[0] ?? '');
      if (kind) v = { type: 'model3d', kind, label: clean(t.fields.slice(1).join(' '), MAX_LABEL) || kind.replace(/-/g, ' ') };
    }
    if (!v) continue;
    const key = v.type === 'card' ? `c:${v.title.toLowerCase()}` : `m:${v.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
    if (out.length >= MAX_VISUALS) break;
  }
  return out;
}

/** True when `text` holds a usable card or model tag. */
export function hasVisualTag(text: string): boolean {
  return parseVisualTags(text).length > 0;
}

/** Note for the model's context: what the user was shown (so "that molecule" makes sense later). */
export function visualContextNote(visuals: ChatVisual[]): string {
  if (!visuals.length) return '';
  const parts = visuals.map((v) => (v.type === 'card' ? `card "${v.title}"` : `3d ${v.kind.replace(/-/g, ' ')}`));
  return ` (showed ${parts.join(', ')})`;
}

/** The system-prompt section for cards and 3D models; conversation.ts appends it. */
export function visualPromptSection(): string {
  return `

CARDS AND 3D MODELS
Sometimes a picture in the air explains better than words. You can attach a small floating card or a draggable 3D model to your reply. Use one only when it truly helps (explaining a concept, a structure, a short list of facts); most replies need neither. Never more than one card and one model per reply.
[CARD:title|line|line|line] - a small card: a short title, then up to 6 short lines (each a few words, no markdown).
[MODEL3D:kind|label] - a model the user can rotate and zoom. kind must be exactly one of: ${MODEL3D_KINDS.join(', ')}. label is a few lowercase words naming it.
- Put the tag at the end of your reply. The tags are removed from what the user reads and hears, so your words must still make sense alone and must not mention the tag, card or model by syntax.
- You can say "here's a model you can turn" or similar, once, naturally.
- If nothing in the list fits, use a card instead of inventing a kind.
Example:
user: explain a water molecule
you: two hydrogens bonded to one oxygen, bent at about 104 degrees, which makes water polar. [MODEL3D:molecule-h2o|a water molecule]`;
}
