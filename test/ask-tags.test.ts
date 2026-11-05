import test from 'node:test';
import assert from 'node:assert/strict';
import { askContextNote, composeAskReply, hasAskTag, parseAskTag, spokenAsk, stripAskTags } from '../src/main/ask-tags.ts';
import { stripActionTags } from '../src/main/action-tags.ts';

test('parses question and options', () => {
  assert.deepEqual(parseAskTag('a few files here. [ASK:which file should i open?|budget.xlsx|report.docx|notes.txt]'), {
    question: 'which file should i open?',
    options: ['budget.xlsx', 'report.docx', 'notes.txt'],
  });
});

test('trims, collapses whitespace, drops empty and duplicate options, keeps at most five', () => {
  const a = parseAskTag('[ask: pick one? | a |  b  b ||A| c|d|e|f|g]');
  assert.deepEqual(a, { question: 'pick one?', options: ['a', 'b b', 'c', 'd', 'e'] });
});

test('escapes: \\| \\] \\\\', () => {
  const a = parseAskTag('[ASK:which one\\]?|left \\| right|c:\\\\temp|[x\\]]');
  assert.deepEqual(a, { question: 'which one]?', options: ['left | right', 'c:\\temp', '[x]'] });
});

test('needs a question and two options', () => {
  assert.equal(parseAskTag('[ASK:just a question?]'), null);
  assert.equal(parseAskTag('[ASK:q?|only one]'), null);
  assert.equal(parseAskTag('[ASK:|a|b]'), null);
  assert.equal(parseAskTag('[ASK:q?|a|b'), null); // unclosed
  assert.equal(hasAskTag('no tag here'), false);
  assert.equal(hasAskTag('[ASK:q?|a|b]'), true);
});

test('the last usable tag wins', () => {
  assert.deepEqual(parseAskTag('[ASK:first?|a|b] then [ASK:second?|c|d]')?.question, 'second?');
  assert.deepEqual(parseAskTag('[ASK:first?|a|b] then [ASK:bad?|c]')?.question, 'first?');
});

test('long options are shortened', () => {
  const long = 'x'.repeat(100);
  const a = parseAskTag(`[ASK:q?|${long}|b]`)!;
  assert.ok(a.options[0].length <= 60);
  assert.ok(a.options[0].endsWith('…'));
});

test('strips complete tags, unclosed ones and streaming partial heads', () => {
  assert.equal(stripAskTags('which one? [ASK:which one?|a|b]'), 'which one?');
  assert.equal(stripAskTags('hmm [ASK:which one?|a|b'), 'hmm');
  assert.equal(stripAskTags('hmm [ASK:which one?|a|b', true), 'hmm ');
  assert.equal(stripAskTags('hmm [AS', true), 'hmm ');
  assert.equal(stripAskTags('hmm [', true), 'hmm ');
  assert.equal(stripAskTags('see [the docs]', true), 'see [the docs]');
  assert.equal(stripAskTags('a [b] c'), 'a [b] c');
  assert.equal(stripAskTags('x [ASK:q \\] still|a \\| b|c] y'), 'x  y');
  assert.equal(stripAskTags('nothing   \n\n\n here'), 'nothing   \n\n\n here'); // untouched without tags
});

test('ask tags survive action-tag stripping untouched (both strippers compose)', () => {
  const raw = 'pick one. [ASK:which?|a|b] [POINT:1,2:x]';
  assert.equal(stripAskTags(stripActionTags(raw)), 'pick one.  [POINT:1,2:x]');
});

test('composeAskReply appends the question unless the prose has it', () => {
  const ask = { question: 'which file should i open?', options: ['a', 'b'] };
  assert.equal(composeAskReply('there are a few.', ask), 'there are a few.\nwhich file should i open?');
  assert.equal(composeAskReply('Which file should I open?', ask), 'Which file should I open?');
  assert.equal(composeAskReply('', ask), 'which file should i open?');
  assert.equal(composeAskReply('want the file manager, or setup first?', ask), 'want the file manager, or setup first?');
});

test('spokenAsk reads short options briefly, skips long lists', () => {
  const ask = { question: 'which file?', options: ['budget.xlsx', 'report.docx', 'notes.txt'] };
  assert.equal(spokenAsk('which file?', ask), 'which file? budget, report, or notes?');
  assert.equal(spokenAsk('which?', { question: 'which?', options: ['yes', 'no'] }), 'which? yes or no?');
  const many = { question: 'q?', options: ['a', 'b', 'c', 'd'] };
  assert.equal(spokenAsk('q?', many), 'q?');
});

test('context note numbers the options', () => {
  assert.equal(askContextNote({ options: ['a', 'b'] }), ' (offered choices: 1. a, 2. b)');
});

test('while streaming, visible text never shrinks until a tag completes', () => {
  const full = 'see it [here] or [ASK:which one?|a|b]';
  let prev = '';
  for (let i = 1; i < full.length; i++) {
    const v = stripAskTags(full.slice(0, i), true);
    assert.ok(v.startsWith(prev) || prev.startsWith(v) && v.length >= prev.trimEnd().length, `shrank at ${i}: ${JSON.stringify(prev)} → ${JSON.stringify(v)}`);
    if (v.length > prev.length) prev = v;
  }
  assert.equal(stripAskTags(full, true), 'see it [here] or');
});
