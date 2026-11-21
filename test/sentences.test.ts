import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SentenceChunker, sentenceEnd } from '../src/shared/sentences.ts';

function stream(text: string, step = 3): string[] {
  const c = new SentenceChunker();
  const out: string[] = [];
  for (let i = step; i < text.length; i += step) out.push(...c.update(text.slice(0, i)));
  out.push(...c.flush(text));
  return out;
}

test('splits a streamed reply into sentences, in order, losing nothing', () => {
  const text = "Sure! The save button is in the top right corner. Click it and you're done.";
  const out = stream(text);
  // a tiny opener is spoken on its own: it's the fastest way to the first sound
  assert.deepEqual(out, ['Sure!', 'The save button is in the top right corner.', "Click it and you're done."]);
  assert.equal(out.join(' '), text);
});

test('the first sentence is emitted before the reply is finished', () => {
  const c = new SentenceChunker();
  assert.deepEqual(c.update('Paris is the capital of France.'), []); // could still be "France.com"
  assert.deepEqual(c.update('Paris is the capital of France. It'), ['Paris is the capital of France.']);
});

test('decimals, abbreviations and file names do not end a sentence', () => {
  assert.equal(sentenceEnd('version 3.5 is out. yes', 0), 19);
  assert.equal(sentenceEnd('ask Dr. Smith now. ok', 0), 18);
  assert.equal(sentenceEnd('open notes.txt please. ok', 0), 22);
  assert.equal(sentenceEnd('e.g. this one. ok', 0), 14);
});

test('a long first sentence is cut at a comma so speech starts early', () => {
  const c = new SentenceChunker();
  const long = 'so the thing you are looking for, which is honestly a little hidden in this app, lives under the view menu near the';
  const out = c.update(long);
  assert.equal(out.length, 1);
  assert.ok(long.startsWith(out[0]!));
  assert.ok(out[0]!.endsWith(','));
});

test('short later sentences are joined with the next one', () => {
  const out = stream('Here it is. Okay. Now click the blue button to continue.');
  assert.deepEqual(out, ['Here it is.', 'Okay. Now click the blue button to continue.']);
});

test('flush returns the unterminated tail; empty / symbol-only pieces are dropped', () => {
  const c = new SentenceChunker();
  assert.deepEqual(c.flush('it is right here'), ['it is right here']);
  assert.deepEqual(new SentenceChunker().flush('  …  '), []);
  assert.equal(c.spokenUpTo, 'it is right here'.length);
});

test('newlines end a piece', () => {
  assert.deepEqual(stream('first line\nsecond line is a bit longer than the first'), ['first line', 'second line is a bit longer than the first']);
});

test('a long complete first sentence starts with its first clause', () => {
  const c = new SentenceChunker({ firstMax: 60 });
  const out = c.update("Paris again, and the screen hasn't changed, so the sign-in still isn't done. The");
  assert.deepEqual(out, ['Paris again,', "and the screen hasn't changed, so the sign-in still isn't done."]);
});
