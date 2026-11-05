// [ASK:question|option|option…] choice tags (see ARCHITECTURE.md "Choices"). Pure, unit tested.
//
// The model ends a reply with one tag when it needs the user to decide something:
//   [ASK:which file should i open?|budget.xlsx|report.docx|notes.txt]
// question first, then 2–5 short options. A literal '|' is written '\|', ']' as '\]', '\' as '\\'.

export interface ParsedAsk {
  question: string;
  options: string[];
}

export const MAX_ASK_OPTIONS = 5;
const MAX_OPTION_CHARS = 60;
const MAX_QUESTION_CHARS = 200;

interface RawAsk {
  /** the tag's fields, unescaped (question, options…) */
  fields: string[];
  start: number;
  end: number; // exclusive; buffer length when unclosed
  closed: boolean;
}

/** Every [ASK:…] tag in `text`, plus a trailing unclosed one (closed: false). */
function scanAsk(text: string): RawAsk[] {
  const out: RawAsk[] = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('[', i);
    if (open < 0) break;
    if (text.slice(open + 1, open + 5).toUpperCase() !== 'ASK:') {
      i = open + 1;
      continue;
    }
    const fields: string[] = [''];
    let j = open + 5;
    let closed = false;
    for (; j < text.length; j++) {
      const c = text[j];
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
      out.push({ fields, start: open, end: text.length, closed: false });
      break;
    }
    out.push({ fields, start: open, end: j + 1, closed: true });
    i = j + 1;
  }
  return out;
}

/** "[", "[A", "[AS", "[ASK" at the very end while streaming. */
function partialHeadAt(text: string): number {
  const open = text.lastIndexOf('[');
  if (open < 0) return -1;
  const tail = text.slice(open + 1).toUpperCase();
  return 'ASK'.startsWith(tail) ? open : -1;
}

/**
 * Remove [ASK:…] tags. With `streaming`, also hide a trailing unclosed tag / partial "[AS".
 * A finished reply drops an unclosed tag too.
 */
export function stripAskTags(text: string, streaming = false): string {
  const tags = scanAsk(text);
  let out = '';
  let pos = 0;
  for (const t of tags) {
    out += text.slice(pos, t.start);
    pos = t.end;
  }
  let rest = text.slice(pos);
  if (streaming) {
    // only a lone "[" / "[A" / "[AS" / "[ASK" can still become a tag (an unclosed one was cut
    // above). Just cut it, with no other tidying: the visible text must only ever grow while it
    // streams, or the bubble re-renders (flickers) each time a "[" arrives.
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

/**
 * The reply's choice question: the LAST complete [ASK:…] tag with a question and at least two
 * options (empty / duplicate options dropped, at most five kept). Null when there is none.
 */
export function parseAskTag(text: string): ParsedAsk | null {
  const tags = scanAsk(text).filter((t) => t.closed);
  for (let k = tags.length - 1; k >= 0; k--) {
    const [q = '', ...rest] = tags[k].fields;
    const question = clean(q, MAX_QUESTION_CHARS);
    const seen = new Set<string>();
    const options: string[] = [];
    for (const raw of rest) {
      const o = clean(raw, MAX_OPTION_CHARS);
      const key = o.toLowerCase();
      if (!o || seen.has(key)) continue;
      seen.add(key);
      options.push(o);
      if (options.length >= MAX_ASK_OPTIONS) break;
    }
    if (question && options.length >= 2) return { question, options };
  }
  return null;
}

/** True when `text` holds a usable [ASK:…] tag. */
export function hasAskTag(text: string): boolean {
  return parseAskTag(text) !== null;
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/**
 * The visible reply with the question in it: models usually write the question only inside the
 * tag, so append it (on its own line) unless the prose already contains it or ends with a
 * question of its own.
 */
export function composeAskReply(visible: string, ask: ParsedAsk): string {
  const v = visible.trim();
  const q = norm(ask.question);
  if (q && norm(v).includes(q)) return v;
  // the prose already ends by asking (in its own words): don't ask twice
  if (/\?["'”’)]*$/.test(v)) return v;
  return v ? `${v}\n${ask.question}` : ask.question;
}

/** "budget.xlsx" → "budget": file extensions and brackets aren't worth saying aloud. */
function sayable(option: string): string {
  return option
    .replace(/\.(?:[a-z0-9]{1,5})$/i, '')
    .replace(/[_]+/g, ' ')
    .replace(/[()[\]{}"“”]/g, '')
    .trim();
}

/**
 * What to say for a reply that asks: the reply (which ends with the question), then the options
 * briefly ("budget, report, or notes?") when there are at most three short ones.
 */
export function spokenAsk(reply: string, ask: ParsedAsk): string {
  const opts = ask.options.map(sayable).filter(Boolean);
  const short = opts.length >= 2 && opts.length <= 3 && opts.every((o) => o.split(/\s+/).length <= 4);
  if (!short) return reply;
  const list = opts.length === 2 ? `${opts[0]} or ${opts[1]}` : `${opts.slice(0, -1).join(', ')}, or ${opts[opts.length - 1]}`;
  return `${reply.trim()} ${list}?`;
}

/** Note for the model's context: what was offered (so "the second one" makes sense later). */
export function askContextNote(ask: { options: string[]; answered?: string }): string {
  return ` (offered choices: ${ask.options.map((o, i) => `${i + 1}. ${o}`).join(', ')})`;
}
