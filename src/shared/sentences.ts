// Sentence chunking for speak-as-you-go: as a reply streams in, hand complete sentences to the
// voice one at a time so the first one is heard while the model is still writing the rest.
// Pure (no imports): unit tested in test/sentences.test.ts.

/** words that end with a dot but don't end a sentence */
const ABBREV = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc', 'eg', 'e.g', 'ie', 'i.e', 'inc', 'ltd', 'co', 'approx',
  'no', 'fig', 'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec', 'mt', 'ft',
]);

/** Index just past the end of the first sentence in `text` from `from`, or -1 (needs more text). */
export function sentenceEnd(text: string, from = 0, final = false): number {
  for (let i = from; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '\n') {
      if (text.slice(from, i).trim()) return i + 1;
      continue;
    }
    if (ch !== '.' && ch !== '!' && ch !== '?' && ch !== '…' && ch !== ';' && ch !== ':') continue;
    // run of terminators and closing quotes / brackets
    let j = i + 1;
    while (j < text.length && /[.!?…"'”’)\]]/.test(text[j]!)) j++;
    if (j >= text.length) {
      if (final) return j;
      return -1; // can't tell yet ("3." might become "3.5")
    }
    if (!/\s/.test(text[j]!)) {
      i = j - 1;
      continue; // "3.5", "e.g.", "file.txt"
    }
    if (ch === ':' || ch === ';') {
      // only a clause break: good enough to start speaking when it's long already
      if (i - from < 40) continue;
    }
    if (ch === '.') {
      const word = /([A-Za-z.]+)\.$/.exec(text.slice(Math.max(from, i - 12), i + 1))?.[1]?.toLowerCase().replace(/\.$/, '');
      if (word && (ABBREV.has(word) || /^[a-z]$/i.test(word))) continue;
    }
    return j;
  }
  return -1;
}

export interface ChunkerOptions {
  /** a first sentence longer than this without a full stop is cut at a comma (start speaking sooner) */
  firstMax?: number;
  /** later pieces shorter than this are joined with the next one (fewer, smoother synth calls) */
  minLater?: number;
}

/**
 * Feed it the growing visible reply text; it returns newly completed sentences, in order.
 * The text may shrink or change at the tail (a partial tag being hidden): only text before the
 * last emitted position is assumed stable.
 */
export class SentenceChunker {
  private pos = 0;
  private emitted = 0;
  private text = '';
  private opts: ChunkerOptions;
  constructor(opts: ChunkerOptions = {}) {
    this.opts = opts;
  }

  /** characters of the text already handed out */
  get spokenUpTo(): number {
    return this.pos;
  }

  update(text: string): string[] {
    this.text = text;
    if (this.pos > text.length) this.pos = text.length;
    return this.take(false);
  }

  /** The reply is complete: everything that's left (as one or more pieces). */
  flush(text = this.text): string[] {
    this.text = text;
    if (this.pos > text.length) this.pos = text.length;
    return this.take(true);
  }

  private take(final: boolean): string[] {
    const out: string[] = [];
    const firstMax = this.opts.firstMax ?? 90;
    const minLater = this.opts.minLater ?? 24;
    const t = this.text;
    for (;;) {
      let end = sentenceEnd(t, this.pos, final);
      // join a short later piece ("okay.") with the sentence after it
      while (end > 0 && this.emitted > 0 && t.slice(this.pos, end).trim().length < minLater) {
        const next = sentenceEnd(t, end, final);
        if (next < 0) {
          end = final ? t.length : -1;
          break;
        }
        end = next;
      }
      if (end < 0 && this.emitted === 0 && !final) {
        // a long opening sentence: cut at a comma so the voice can start
        const seg = t.slice(this.pos);
        if (seg.length > firstMax) {
          const comma = seg.lastIndexOf(', ', firstMax);
          if (comma > 20) end = this.pos + comma + 1;
        }
      }
      if (end > 0 && this.emitted === 0 && end - this.pos > firstMax) {
        // a long complete opening sentence: say its first clause on its own (sooner first sound)
        const comma = t.slice(this.pos, end).indexOf(', ', 6);
        if (comma > 0 && comma < end - this.pos - 12) end = this.pos + comma + 1;
      }
      if (end < 0) {
        if (final) {
          const rest = t.slice(this.pos).trim();
          this.pos = t.length;
          if (rest) out.push(rest);
        }
        break;
      }
      const piece = t.slice(this.pos, end).trim();
      this.pos = end;
      if (!piece) continue;
      out.push(piece);
      this.emitted++;
    }
    return out.filter((p) => /[\p{L}\p{N}]/u.test(p));
  }
}
