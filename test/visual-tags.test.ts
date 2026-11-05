import test from 'node:test';
import assert from 'node:assert/strict';
import { hasVisualTag, normalizeKind, parseVisualTags, stripVisualTags, visualContextNote, visualPromptSection } from '../src/main/visual-tags.ts';
import { MODEL3D_KINDS } from '../src/shared/visuals.ts';

test('parses a card', () => {
  assert.deepEqual(parseVisualTags('here you go. [CARD:water|two hydrogens|one oxygen|bent shape]'), [
    { type: 'card', title: 'water', lines: ['two hydrogens', 'one oxygen', 'bent shape'] },
  ]);
});

test('card needs a title and a line, keeps six lines, shortens long ones', () => {
  assert.deepEqual(parseVisualTags('[CARD:only a title]'), []);
  assert.deepEqual(parseVisualTags('[CARD:|a|b]'), []);
  const c = parseVisualTags('[CARD:t|1|2|3|4|5|6|7|8]')[0]!;
  assert.equal(c.type === 'card' && c.lines.length, 6);
  const long = parseVisualTags(`[CARD:t|${'x'.repeat(300)}]`)[0]!;
  assert.ok(long.type === 'card' && long.lines[0]!.length <= 90 && long.lines[0]!.endsWith('…'));
});

test('parses models, with aliases and case-insensitive tags', () => {
  assert.deepEqual(parseVisualTags('[MODEL3D:molecule-h2o|a water molecule]'), [{ type: 'model3d', kind: 'molecule-h2o', label: 'a water molecule' }]);
  assert.deepEqual(parseVisualTags('[model3d: Solar_System ]'), [{ type: 'model3d', kind: 'solar-system', label: 'solar system' }]);
  assert.equal(normalizeKind('Water'), 'molecule-h2o');
  assert.equal(normalizeKind('dragon'), null);
  assert.deepEqual(parseVisualTags('[MODEL3D:dragon|a dragon]'), []);
  for (const k of MODEL3D_KINDS) assert.equal(normalizeKind(k), k);
});

test('escapes, duplicates and the cap', () => {
  assert.deepEqual(parseVisualTags('[CARD:a \\| b|x \\] y|c:\\\\d]'), [{ type: 'card', title: 'a | b', lines: ['x ] y', 'c:\\d'] }]);
  assert.equal(parseVisualTags('[MODEL3D:cube|a][MODEL3D:cube|b]').length, 1);
  assert.equal(parseVisualTags('[MODEL3D:cube|a][MODEL3D:sphere|b][MODEL3D:cone|c][MODEL3D:torus|d]').length, 3);
  assert.equal(hasVisualTag('nothing'), false);
  assert.equal(hasVisualTag('[MODEL3D:gear|a gear]'), true);
});

test('unclosed tags are not parsed', () => {
  assert.deepEqual(parseVisualTags('[MODEL3D:cube|a cu'), []);
});

test('strips tags, unclosed ones and streaming partial heads', () => {
  assert.equal(stripVisualTags('look. [MODEL3D:cube|a cube]'), 'look.');
  assert.equal(stripVisualTags('a [CARD:t|x] b [MODEL3D:gear|g] c'), 'a  b  c');
  assert.equal(stripVisualTags('hmm [CARD:t|x'), 'hmm');
  assert.equal(stripVisualTags('hmm [CARD:t|x', true), 'hmm ');
  assert.equal(stripVisualTags('hmm [MOD', true), 'hmm ');
  assert.equal(stripVisualTags('hmm [MODEL3D', true), 'hmm ');
  assert.equal(stripVisualTags('hmm [', true), 'hmm ');
  assert.equal(stripVisualTags('see [the docs]', true), 'see [the docs]');
  assert.equal(stripVisualTags('a [b] c'), 'a [b] c');
  assert.equal(stripVisualTags('x [CARD:q \\] still|a \\| b] y'), 'x  y');
});

test('context note and prompt section', () => {
  assert.equal(visualContextNote([]), '');
  assert.equal(visualContextNote([{ type: 'card', title: 'water', lines: ['a'] }, { type: 'model3d', kind: 'dna-helix', label: 'x' }]), ' (showed card "water", 3d dna helix)');
  const p = visualPromptSection();
  for (const k of MODEL3D_KINDS) assert.ok(p.includes(k));
  assert.ok(p.includes('[CARD:') && p.includes('[MODEL3D:'));
});
