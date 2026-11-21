import test from 'node:test';
import assert from 'node:assert/strict';
import { parseExtraTags, parseLesson, stripExtraTags } from '../src/main/extra-tags.ts';
import { looksHard } from '../src/main/fast-model.ts';

test('parseLesson reads n/m and "n of m"', () => {
  assert.deepEqual(parseLesson('2/5'), { n: 2, total: 5 });
  assert.deepEqual(parseLesson(' 3 of 7 '), { n: 3, total: 7 });
  assert.deepEqual(parseLesson('step 1/4'), { n: 1, total: 4 });
  assert.deepEqual(parseLesson('6/4'), { n: 6, total: 6 }); // total grows to n
  assert.equal(parseLesson('soon'), null);
});

test('a lesson tag is parsed, stripped, and disables [STEP] walkthroughs', () => {
  const raw = 'first, find the y-intercept: where the line crosses the y axis. what is it here? [LESSON:1/4]';
  const tags = parseExtraTags(raw);
  assert.deepEqual(tags.lesson, { n: 1, total: 4 });
  assert.equal(stripExtraTags(raw).trim(), 'first, find the y-intercept: where the line crosses the y axis. what is it here?');
  // a half-streamed tag is hidden too
  assert.equal(stripExtraTags('nice work. [LESS', true).trim(), 'nice work.');
});

test('teaching requests keep the full model', () => {
  assert.ok(looksHard('teach me how pivot tables work'));
  assert.ok(looksHard('walk me through this equation'));
  assert.ok(looksHard('next step'));
});
