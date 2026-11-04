import test from 'node:test';
import assert from 'node:assert/strict';
import { hasActionTags, parseActionTags, parseKeyChord, stripActionTags, summarizeActions } from '../src/main/action-tags.ts';

test('parses clicks, double / right clicks with labels and screens', () => {
  const { actions, done } = parseActionTags(
    'clicking save. [CLICK:10,20:save button:screen2][DOUBLECLICK:5.5, 6:file: a.txt][RIGHTCLICK:1,2][CLICK:bad]',
  );
  assert.equal(done, false);
  assert.deepEqual(actions, [
    { type: 'click', x: 10, y: 20, label: 'save button', screen: 2, button: 'left', count: 1 },
    { type: 'click', x: 5.5, y: 6, label: 'file:a.txt', screen: undefined, button: 'left', count: 2 },
    { type: 'click', x: 1, y: 2, label: 'here', screen: undefined, button: 'right', count: 1 },
  ]);
});

test('TYPE keeps anything, supports \\] and \\\\ escapes, newlines', () => {
  const { actions } = parseActionTags('[TYPE:a [b\\] c: d\\\\e\nf] [TYPE:]');
  assert.deepEqual(actions, [{ type: 'type', text: 'a [b] c: d\\e\nf' }]);
});

test('KEY: human names → canonical chords', () => {
  assert.deepEqual(parseKeyChord('cmd+s', 'darwin'), ['Meta', 'KeyS']);
  assert.deepEqual(parseKeyChord('Enter'), ['Enter']);
  assert.deepEqual(parseKeyChord('return'), ['Enter']);
  assert.deepEqual(parseKeyChord('ctrl + shift + t'), ['Control', 'Shift', 'KeyT']);
  assert.deepEqual(parseKeyChord('shift+ctrl+tab'), ['Control', 'Shift', 'Tab']);
  assert.deepEqual(parseKeyChord('ctrl-c'), ['Control', 'KeyC']);
  assert.deepEqual(parseKeyChord('mod+a', 'darwin'), ['Meta', 'KeyA']);
  assert.deepEqual(parseKeyChord('mod+a', 'linux'), ['Control', 'KeyA']);
  assert.deepEqual(parseKeyChord('option+left'), ['Alt', 'ArrowLeft']);
  assert.deepEqual(parseKeyChord('F5'), ['F5']);
  assert.deepEqual(parseKeyChord('esc'), ['Escape']);
  assert.deepEqual(parseKeyChord('-'), ['Minus']);
  assert.equal(parseKeyChord('a+b'), null);
  assert.equal(parseKeyChord('hyper+q'), null);
  assert.equal(parseKeyChord(''), null);
  const { actions } = parseActionTags('[KEY:cmd+s][KEY:enter][KEY:nonsense]', 'darwin');
  assert.deepEqual(actions, [
    { type: 'key', keys: ['Meta', 'KeyS'], label: 'cmd+s' },
    { type: 'key', keys: ['Enter'], label: 'enter' },
  ]);
});

test('SCROLL, WAIT and DONE', () => {
  const r = parseActionTags('[SCROLL:100,200:down 5:screen1][SCROLL:1,2:up][SCROLL:1,2:3 left][WAIT:500][WAIT:2s][WAIT:99999][DONE]');
  assert.equal(r.done, true);
  assert.deepEqual(r.actions, [
    { type: 'scroll', x: 100, y: 200, screen: 1, dx: 0, dy: 5, label: 'down 5' },
    { type: 'scroll', x: 1, y: 2, screen: undefined, dx: 0, dy: -3, label: 'up 3' },
    { type: 'scroll', x: 1, y: 2, screen: undefined, dx: -3, dy: 0, label: 'left 3' },
    { type: 'wait', ms: 500 },
    { type: 'wait', ms: 2000 },
    { type: 'wait', ms: 10000 },
  ]);
  assert.equal(parseActionTags('all set [done]').done, true);
});

test('strips tags for display and speech, including partial ones while streaming', () => {
  assert.equal(stripActionTags('saving it now. [CLICK:1,2:save][TYPE:hi \\] there][KEY:cmd+s]'), 'saving it now. ');
  assert.equal(stripActionTags('ok [TYPE:hello wor', true), 'ok ');
  assert.equal(stripActionTags('ok [CLI', true), 'ok ');
  assert.equal(stripActionTags('ok [', true), 'ok ');
  assert.equal(stripActionTags('see [note] here'), 'see [note] here');
  assert.equal(stripActionTags('see [note', true), 'see [note');
  assert.equal(stripActionTags('a [KEY: no close\nnext line'), 'a [KEY: no close\nnext line');
  assert.equal(stripActionTags('done [TYPE:dangling'), 'done ');
  assert.equal(stripActionTags('[POINT:1,2:x] stays for point-tags'), '[POINT:1,2:x] stays for point-tags');
  assert.equal(hasActionTags('nothing [here]'), false);
  assert.equal(hasActionTags('x [DONE]'), true);
});

test('summaries', () => {
  const { actions } = parseActionTags('[CLICK:1,2:Save][TYPE:hello][KEY:cmd+s][WAIT:300]', 'darwin');
  assert.equal(summarizeActions(actions), 'click “save” · type “hello” · press cmd+s');
  assert.equal(summarizeActions(actions, 'past'), 'clicked save · typed hello · pressed cmd+s');
  assert.equal(summarizeActions([{ type: 'wait', ms: 1500 }]), 'wait 1.5s');
});
