// node --experimental-strip-types --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyReplacements, detectCorrection, dictionaryPrompt, fixDashes, looksLikeCommandRisk, looksSecret } from '../src/main/dictionary.ts';

test('dictionary prompt: deduped, comma separated, capped', () => {
  assert.equal(dictionaryPrompt(['Clickity', ' Bndrwe ', 'Clickity', '']), 'Clickity, Bndrwe.');
  assert.equal(dictionaryPrompt([]), '');
  assert.ok(dictionaryPrompt(Array.from({ length: 500 }, (_, i) => `word${i}`)).length <= 601);
});

test('replacements: whole words, case-insensitive, longest first, sentence capital kept', () => {
  const r = [{ from: 'clicky tea', to: 'clickity' }, { from: 'tea', to: 'TEA' }];
  assert.equal(applyReplacements('i love clicky tea a lot', r), 'i love clickity a lot');
  assert.equal(applyReplacements('Clicky  tea is great. clicky tea!', r), 'Clickity is great. clickity!');
  assert.equal(applyReplacements('steady tea', r), 'steady TEA');
  assert.equal(applyReplacements('instead', [{ from: 'tea', to: 'x' }]), 'instead');
  assert.equal(applyReplacements('a c++ b', [{ from: 'c++', to: 'cpp' }]), 'a cpp b');
});

test('dashes', () => {
  assert.equal(fixDashes('wait — really', 'comma'), 'wait, really');
  assert.equal(fixDashes('wait — really', 'hyphen'), 'wait - really');
  assert.equal(fixDashes('wait — really', 'keep'), 'wait — really');
});

test('auto-learn: one word (or a short run) replaced by one word', () => {
  assert.deepEqual(detectCorrection('send it to clicky tea please', 'send it to clickity please'), { from: 'clicky tea', to: 'clickity' });
  assert.deepEqual(detectCorrection('meet john tomorrow', 'meet jon tomorrow'), { from: 'john', to: 'jon' });
  assert.deepEqual(detectCorrection('ask clicky about it', 'Clickity.'), { from: 'clicky', to: 'Clickity' });
  assert.equal(detectCorrection('hello there', 'completely different words here'), null);
  assert.equal(detectCorrection('same text', 'same text'), null);
  assert.equal(detectCorrection('one two three four', 'five six'), null);
});

test('secret and command guards', () => {
  assert.ok(looksSecret('sk-abcdefghijklmnopqrstuvwxyz123456'));
  assert.ok(looksSecret('my password: hunter2'));
  assert.ok(looksSecret('4111 1111 1111 1111'));
  assert.ok(!looksSecret('see you at 4 tomorrow, thanks!'));
  assert.ok(looksLikeCommandRisk('rm -rf ~\nls'));
  assert.ok(!looksLikeCommandRisk('hello world'));
});
