import test from 'node:test';
import assert from 'node:assert/strict';
import { addReview, applyQuiz, parseQuizTags, questionText, quizFooter, quizPrompt, resolveReview, stripQuizTags, type QuizState } from '../src/main/quiz-tags.ts';

test('parses questions, grades and the end', () => {
  assert.equal(parseQuizTags('no tags here'), null);
  assert.deepEqual(parseQuizTags('what is 7 x 8? [QUIZ:2/5]'), { question: { n: 2, total: 5 }, grade: null, end: false });
  assert.deepEqual(parseQuizTags('right! [QUIZ:right] next: 9 x 9? [QUIZ:3/5]'), { question: { n: 3, total: 5 }, grade: { right: true, item: '' }, end: false });
  assert.deepEqual(parseQuizTags('not quite. [QUIZ:wrong:7 x 8 is 56] [QUIZ:3 of 5]').grade, { right: false, item: '7 x 8 is 56' });
  // combined, case-insensitive, synonyms
  assert.deepEqual(parseQuizTags('[quiz:3/5:correct]'), { question: { n: 3, total: 5 }, grade: { right: true, item: '' }, end: false });
  assert.deepEqual(parseQuizTags('[QUIZ:incorrect|canberra is the capital|4/5]'), { question: { n: 4, total: 5 }, grade: { right: false, item: 'canberra is the capital' }, end: false });
  assert.deepEqual(parseQuizTags('[QUIZ:Question 1/3]')!.question, { n: 1, total: 3 });
  // the end: a trailing n/m is the score, not a question
  assert.deepEqual(parseQuizTags('4 of 5! [QUIZ:right] [QUIZ:end:4/5]'), { question: null, grade: { right: true, item: '' }, end: true });
  assert.deepEqual(parseQuizTags('[QUIZ:done]'), { question: null, grade: null, end: true });
  // total is at least n
  assert.deepEqual(parseQuizTags('[QUIZ:6/5]')!.question, { n: 6, total: 6 });
  // the first grade wins, the last question wins
  const two = parseQuizTags('[QUIZ:wrong:a] [QUIZ:right] [QUIZ:2/5] [QUIZ:3/5]')!;
  assert.equal(two.grade!.right, false);
  assert.deepEqual(two.question, { n: 3, total: 5 });
});

test('strips tags, and partial ones while streaming', () => {
  assert.equal(stripQuizTags('what is 2 + 2? [QUIZ:1/5]'), 'what is 2 + 2?');
  assert.equal(stripQuizTags('right! [QUIZ:right] next one [QUIZ:2/5]'), 'right! next one');
  assert.equal(stripQuizTags('what is 2 + 2? [QUI', true), 'what is 2 + 2? ');
  assert.equal(stripQuizTags('what is 2 + 2? [QUIZ:1/', true), 'what is 2 + 2? ');
  assert.equal(stripQuizTags('a [link] stays', true), 'a [link] stays');
});

test('questionText picks the question', () => {
  assert.equal(questionText("let's start. what is 7 x 8? take your time."), 'what is 7 x 8?');
  assert.equal(questionText('name the capital of australia.'), 'name the capital of australia.');
});

const run = (replies: string[], chat = 'c1'): { state: QuizState | null; steps: ReturnType<typeof applyQuiz>[] } => {
  let state: QuizState | null = null;
  const steps = replies.map((r) => {
    const s = applyQuiz(state, parseQuizTags(r), r, chat, 1000);
    state = s.state;
    return s;
  });
  return { state, steps };
};

test('a whole quiz: score, missed items, end after the last grade', () => {
  const { state, steps } = run([
    'question one: what is 2 + 2? [QUIZ:1/3]',
    'right! [QUIZ:right] what is 7 x 8? [QUIZ:2/3]',
    'not quite, it is 56. [QUIZ:wrong:7 x 8 is 56] last one: what is 9 - 4? [QUIZ:3/3]',
    'right! 2 of 3 — review: 7 x 8.  [QUIZ:right]',
  ]);
  assert.deepEqual(steps.map((s) => s.event), ['started', 'question', 'question', 'ended']);
  assert.equal(steps[2]!.missed, '7 x 8 is 56');
  assert.deepEqual(steps[3]!.score, { right: 2, total: 3, missed: ['7 x 8 is 56'] });
  assert.equal(state, null);
  assert.equal(quizFooter(steps[0]!), 'question 1 of 3 · esc to end');
  assert.equal(quizFooter(steps[2]!), 'question 3 of 3 · 1 right · esc to end');
  assert.equal(quizFooter(steps[3]!), '2 of 3 right · 1 saved to review');
});

test('grades count once per question; a re-asked question keeps its state', () => {
  const { state } = run(['q? [QUIZ:1/5]', 'right [QUIZ:right]', 'yes right again [QUIZ:right]']);
  assert.equal(state!.right, 1);
  // a side question, then the same question again: still ungraded
  const r = run(['q1? [QUIZ:1/5]', 'that means x. so, q1? [QUIZ:1/5]', 'right [QUIZ:right] q2? [QUIZ:2/5]']);
  assert.equal(r.state!.right, 1);
  assert.equal(r.state!.n, 2);
});

test('a wrong answer with no item saves the question text', () => {
  const { steps } = run(['what is the capital of peru? [QUIZ:1/2]', 'it is lima. [QUIZ:wrong] next: capital of chile? [QUIZ:2/2]']);
  assert.equal(steps[1]!.missed, 'what is the capital of peru?');
});

test('[QUIZ:end] stops early; grades without a quiz are ignored; other chats are separate', () => {
  const { steps } = run(['q? [QUIZ:1/5]', 'ok, stopping. 0 of 0. [QUIZ:end]']);
  assert.equal(steps[1]!.event, 'ended');
  assert.equal(quizFooter(steps[1]!), 'quiz over');
  assert.equal(run(['right! [QUIZ:right]']).state, null);
  const a = applyQuiz(null, parseQuizTags('q? [QUIZ:1/3]'), 'q?', 'a');
  const b = applyQuiz(a.state, parseQuizTags('[QUIZ:right]'), '', 'b');
  assert.equal(b.state, null); // a grade in another chat doesn't touch quiz a
});

test('review list: dedupe, counts, cap, resolve', () => {
  let list = addReview([], '7 x 8 is 56', 1);
  list = addReview(list, 'Canberra is the capital', 2);
  list = addReview(list, '7 × 8 is 56!', 3);
  assert.equal(list.length, 3); // "×" differs from "x"
  list = addReview(list, '7 x 8 is 56.', 4);
  assert.deepEqual(list.map((r) => [r.text, r.misses]), [
    ['Canberra is the capital', 1],
    ['7 × 8 is 56!', 1],
    ['7 x 8 is 56.', 2],
  ]);
  assert.equal(resolveReview(list, 'canberra is the capital').length, 2);
  assert.equal(resolveReview(list, 'capital').length, 2); // contained
  assert.equal(resolveReview(list, 'zz').length, 3); // too short to match
  let many: ReturnType<typeof addReview> = [];
  for (let i = 0; i < 60; i++) many = addReview(many, `item ${i}`, i);
  assert.equal(many.length, 40);
  assert.equal(many[0]!.text, 'item 20');
});

test('prompt lists review items and the live score', () => {
  const p = quizPrompt([], null);
  assert.match(p.stable, /\[QUIZ:n\/m\]/);
  assert.match(p.stable, /\[ASK:/);
  assert.equal(p.dynamic, '');
  const live: QuizState = { chatId: 'c', n: 3, total: 5, right: 2, wrong: 0, graded: false, question: 'q', missed: [], startedAt: 0 };
  const q = quizPrompt([{ text: '7 x 8 is 56', misses: 2, lastMissedAt: 1 }], live);
  assert.match(q.stable, /- 7 x 8 is 56/);
  assert.match(q.dynamic, /question 3 of 5/);
  assert.match(q.dynamic, /2 of 2 right/);
});
