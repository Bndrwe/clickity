// Quiz mode tags and scoring. Pure, unit tested (test/quiz.test.ts); quiz.ts keeps the live quiz
// and the review list, conversation.ts calls it from finishReply.
//
//   [QUIZ:n/m]                  this reply asks question n of m
//   [QUIZ:right]                the answer to the last question was right
//   [QUIZ:right:item]           …and it was a review item they had missed before (removes it)
//   [QUIZ:wrong:what they missed]  wrong; the item is saved for review
//   [QUIZ:end]                  the quiz is over (after the summary)
//   [QUIZ:3/5:right]            a grade and the next question in one tag (small models)
//
// Like [LESSON] the tags are never shown or spoken.

export const MAX_ITEM_CHARS = 140;
export const MAX_REVIEW = 40;

const TAG_RE = /\[QUIZ:((?:\\.|[^\]\\\n])*)\]/gi;
/** "[", "[Q", "[QUI", "[QUIZ:3/" … at the end while streaming */
const PARTIAL_RE = /\[(?:Q(?:U(?:I(?:Z)?)?)?)(?::[^\]\n]*)?$/i;

export interface QuizGrade {
  right: boolean;
  /** what was missed (wrong) / the review item answered (right); '' when not given */
  item: string;
}

export interface ParsedQuiz {
  /** the question this reply asks (the last one wins) */
  question: { n: number; total: number } | null;
  /** the grade of the previous answer (the first one wins) */
  grade: QuizGrade | null;
  end: boolean;
}

const RIGHT = /^(right|correct|yes|true|ok|good|✓|✔)$/i;
const WRONG = /^(wrong|incorrect|no|false|missed|miss|partly|partial|close|almost|✗|✘)$/i;
const END = /^(end|done|over|finished|finish|stop|stopped|complete|summary)$/i;
const NUM = /^(?:q(?:uestion)?\s*)?(\d{1,2})\s*(?:\/|of)\s*(\d{1,2})$/i;

const unescape = (s: string): string => s.replace(/\\(.)/g, '$1');

export function cleanItem(s: string): string {
  const one = s.replace(/\s+/g, ' ').trim().replace(/^["'“”]+|["'“”]+$/g, '');
  return one.length > MAX_ITEM_CHARS ? `${one.slice(0, MAX_ITEM_CHARS - 1).trimEnd()}…` : one;
}

/** One tag's inner text → its parts. */
function parseInner(inner: string): ParsedQuiz {
  const out: ParsedQuiz = { question: null, grade: null, end: false };
  const parts = unescape(inner).split(/\s*[:|]\s*/);
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!.trim();
    if (!p) continue;
    const q = NUM.exec(p);
    if (q && !out.end) {
      const n = Math.max(1, Number(q[1]));
      out.question = { n, total: Math.max(n, Number(q[2])) };
      continue;
    }
    if (END.test(p)) {
      out.end = true;
      out.question = null; // "[QUIZ:end:4/5]" is a score, not a question
      continue;
    }
    const right = RIGHT.test(p);
    if ((right || WRONG.test(p)) && !out.grade) {
      // everything after the grade is its item ("wrong: 7 x 8 is 56")
      const rest = parts.slice(i + 1).filter((r) => !NUM.test(r.trim()) && !END.test(r.trim()));
      out.grade = { right, item: cleanItem(rest.join(': ')) };
      // a question / end may still follow the item
      for (const r of parts.slice(i + 1)) {
        const m = NUM.exec(r.trim());
        if (m && !out.end) {
          const n = Math.max(1, Number(m[1]));
          out.question = { n, total: Math.max(n, Number(m[2])) };
        }
        if (END.test(r.trim())) {
          out.end = true;
          out.question = null;
        }
      }
      break;
    }
  }
  return out;
}

/** Every [QUIZ:…] tag in a reply, merged; null when there is none. */
export function parseQuizTags(text: string): ParsedQuiz | null {
  let found = false;
  const out: ParsedQuiz = { question: null, grade: null, end: false };
  for (const m of text.matchAll(TAG_RE)) {
    found = true;
    const t = parseInner(m[1] ?? '');
    if (t.question) out.question = t.question;
    if (t.grade && !out.grade) out.grade = t.grade;
    if (t.end) out.end = true;
  }
  if (!found) return null;
  if (out.end) out.question = null;
  return out;
}

/** Remove quiz tags (and, while streaming, a trailing partial one). */
export function stripQuizTags(text: string, streaming = false): string {
  let out = text.replace(TAG_RE, '');
  out = out.replace(PARTIAL_RE, '');
  if (streaming) return out;
  return out.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+\n/g, '\n').trim();
}

/* ───────── the running quiz ───────── */

export interface QuizState {
  chatId: string;
  /** the question being asked */
  n: number;
  total: number;
  right: number;
  wrong: number;
  /** the current question has been graded */
  graded: boolean;
  /** the current question's text (a missed item when the model gives none) */
  question: string;
  /** what was missed in this quiz */
  missed: string[];
  startedAt: number;
}

export interface QuizStep {
  state: QuizState | null;
  /** what happened in this reply */
  event: 'none' | 'started' | 'question' | 'graded' | 'ended';
  /** saved for review */
  missed?: string;
  /** a review item answered right */
  reviewed?: string;
  /** the final score (event 'ended') */
  score?: { right: number; total: number; missed: string[] };
}

/** The question in a reply: its last sentence that asks something, else its last sentence. */
export function questionText(reply: string): string {
  const flat = reply.replace(/\s+/g, ' ').trim();
  const sentences = flat.match(/[^.?!]+[.?!]*/g)?.map((s) => s.trim()).filter(Boolean) ?? [];
  const asks = sentences.filter((s) => s.endsWith('?'));
  return cleanItem(asks[asks.length - 1] ?? sentences[sentences.length - 1] ?? flat);
}

/**
 * Apply one reply's tags. A grade counts once per question; a question starts the quiz when none
 * runs; the quiz ends on [QUIZ:end] or once the last question is graded and nothing new is asked.
 */
export function applyQuiz(state: QuizState | null, tags: ParsedQuiz | null, reply: string, chatId: string, now = Date.now()): QuizStep {
  if (!tags) return { state, event: 'none' };
  let s: QuizState | null = state && state.chatId === chatId ? { ...state, missed: [...state.missed] } : null;
  const step: QuizStep = { state: s, event: 'none' };
  if (tags.grade && s && !s.graded) {
    s.graded = true;
    step.event = 'graded';
    if (tags.grade.right) {
      s.right++;
      if (tags.grade.item) step.reviewed = tags.grade.item;
    } else {
      s.wrong++;
      const item = tags.grade.item || s.question;
      if (item) {
        step.missed = item;
        s.missed.push(item);
      }
    }
  }
  if (tags.question && !tags.end) {
    const started = !s;
    if (!s) s = { chatId, n: tags.question.n, total: tags.question.total, right: 0, wrong: 0, graded: false, question: '', missed: [], startedAt: now };
    // asking the same question again (after a side question) keeps its grade state
    const repeat = !started && s.n === tags.question.n && !s.graded;
    s.n = tags.question.n;
    s.total = Math.max(tags.question.total, tags.question.n);
    s.question = questionText(reply) || s.question;
    if (!repeat) s.graded = false;
    step.event = started ? 'started' : 'question';
  }
  const ended = !!s && (tags.end || (!tags.question && s.graded && s.n >= s.total));
  if (ended && s) {
    step.event = 'ended';
    step.score = { right: s.right, total: s.right + s.wrong, missed: s.missed };
    step.state = null;
    return step;
  }
  step.state = s;
  return step;
}

/** The bubble's quiet footer. */
export function quizFooter(step: QuizStep): string {
  if (step.event === 'ended' && step.score) {
    const { right, total, missed } = step.score;
    if (!total) return 'quiz over';
    return `${right} of ${total} right${missed.length ? ` · ${missed.length} saved to review` : ''}`;
  }
  const s = step.state;
  if (!s) return '';
  const graded = s.right + s.wrong;
  return `question ${s.n} of ${s.total}${graded ? ` · ${s.right} right` : ''} · esc to end`;
}

/* ───────── review items (missed before) ───────── */

export interface ReviewItem {
  text: string;
  /** times missed */
  misses: number;
  lastMissedAt: number;
}

const key = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Add a missed item (deduped, newest last, capped). */
export function addReview(list: readonly ReviewItem[], text: string, now = Date.now()): ReviewItem[] {
  const t = cleanItem(text);
  if (!t) return [...list];
  const k = key(t);
  const hit = list.find((r) => key(r.text) === k);
  const rest = list.filter((r) => r !== hit);
  return [...rest, { text: t, misses: (hit?.misses ?? 0) + 1, lastMissedAt: now }].slice(-MAX_REVIEW);
}

/** A review item answered right: drop the one it names (same text, or one containing the other). */
export function resolveReview(list: readonly ReviewItem[], text: string): ReviewItem[] {
  const k = key(text);
  if (k.length < 3) return [...list];
  const exact = list.findIndex((r) => key(r.text) === k);
  const i = exact >= 0 ? exact : list.findIndex((r) => key(r.text).includes(k) || k.includes(key(r.text)));
  return i < 0 ? [...list] : list.filter((_, j) => j !== i);
}

/** The system prompt section: the protocol, things missed before, and the live score. */
export function quizPrompt(review: readonly ReviewItem[], live: QuizState | null): { stable: string; dynamic: string } {
  let stable = `

QUIZZES
- When the user asks to be quizzed or tested ("quiz me on this", "test me", "make flashcards from this pdf / page / what's on my screen"), or says yes to a quiz you offered, run a short quiz: ONE question per reply, 5 questions unless they ask for another number. Take the questions from what they mean: the lesson you just taught, the attached pdf or page, or what's on the screen.
- End every question with [QUIZ:n/m] (question n of m). Mix multiple choice and short answers. For multiple choice, also add [ASK:the question|option|option|option] with 3 or 4 short options; for a short answer just ask, and they'll say or type it.
- When they answer, grade it first, in a few words: "right!" or a gentle correction with the right answer and one short reason. Mark it [QUIZ:right] or [QUIZ:wrong:what they missed, as a short fact, e.g. "7 x 8 is 56"]. Then ask the next question with its own [QUIZ:n/m]. "skip" or "i don't know" counts as wrong (give the answer).
- After grading the last question, don't ask another: give a one-line summary with the score and what to review ("4 of 5 — review: the chain rule") and add [QUIZ:end]. Do the same if they ask to stop.
- If they ask something else mid-quiz, answer briefly, then repeat the current question with the same [QUIZ:n/m].
- For questions about a function or numbers, a [CHART:…] can go with the question, but never one that gives the answer away.
- Never reveal the answer in the question. Never mention the tags.`;
  if (review.length) {
    const items = [...review].sort((a, b) => b.misses - a.misses || b.lastMissedAt - a.lastMissedAt).slice(0, 12);
    stable += `
Things the user missed in earlier quizzes (when they say "quiz me again" or start a quiz on the same topic, ask about these first, in new words; when they get one right, mark it [QUIZ:right:the item exactly as written here]):
${items.map((r) => `- ${r.text}`).join('\n')}`;
  }
  let dynamic = '';
  if (live) {
    const graded = live.right + live.wrong;
    dynamic = `

QUIZ IN PROGRESS in this chat: question ${live.n} of ${live.total} is waiting for the user's answer${live.graded ? ' (already graded)' : ''}. Score so far: ${live.right} of ${graded} right.${live.graded ? '' : ` Grade their answer to question ${live.n} first.`}`;
  }
  return { stable, dynamic };
}
