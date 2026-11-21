import test from 'node:test';
import assert from 'node:assert/strict';
import { graphemes, planUndo, undoHint, undoPrompt, undoSummary, undoUnsafe, MAX_LOCAL_CHARS, type DoneAction } from '../src/main/undo-plan.ts';
import { describeAction, parseActionTags, type ParsedAction } from '../src/main/action-tags.ts';

const describe = (a: ParsedAction) => describeAction(a, 'past');

/** "[CLICK:…][TYPE:…]" → what runAgent would have performed (coordinates don't matter here) */
function done(tags: string): DoneAction[] {
  return parseActionTags(tags).actions.map((parsed) => {
    switch (parsed.type) {
      case 'click':
        return { parsed, input: { type: 'click', x: parsed.x, y: parsed.y, button: parsed.button, count: parsed.count, label: parsed.label } };
      case 'scroll':
        return { parsed, input: { type: 'scroll', x: parsed.x, y: parsed.y, dy: parsed.dy, dx: parsed.dx } };
      case 'type':
        return { parsed, input: { type: 'type', text: parsed.text } };
      case 'key':
        return { parsed, input: { type: 'key', keys: parsed.keys } };
      case 'wait':
        return { parsed, input: { type: 'wait', ms: parsed.ms } };
    }
  });
}

const backspaces = (n: number) => Array.from({ length: n }, () => ({ type: 'key', keys: ['Backspace'] }));

test('typed text at the end is deleted again, one backspace per character', () => {
  const p = planUndo(done('[CLICK:10,10:search:screen1][TYPE:hello]'));
  assert.deepEqual(p.local, backspaces(5));
  assert.deepEqual(p.localNotes, ['delete “hello” (5 characters)']);
  // the click before it is left for the model
  assert.equal(p.rest.length, 1);
  assert.equal(p.rest[0]!.type, 'click');
});

test('emoji and accents count as one character each', () => {
  assert.equal(graphemes('héllo 👋🏽'), 7);
  const p = planUndo(done('[TYPE:👋🏽 é]'));
  assert.equal(p.local.length, 3);
  assert.equal(p.rest.length, 0);
});

test('several trailing types and scrolls reverse in order, waits are skipped', () => {
  const p = planUndo(done('[TYPE:ab][WAIT:200][TYPE:cd][SCROLL:50,60:down 3:screen1]'));
  assert.deepEqual(p.local, [{ type: 'scroll', x: 50, y: 60, dy: -3, dx: undefined }, ...backspaces(2), ...backspaces(2)]);
  assert.deepEqual(p.localNotes, ['scroll back', 'delete “cd” (2 characters)', 'delete “ab” (2 characters)']);
  assert.equal(p.rest.length, 0);
});

test('a key press after typing (enter = sent) stops the local part: the model is asked', () => {
  const p = planUndo(done('[TYPE:hi there][KEY:enter]'));
  assert.equal(p.local.length, 0);
  assert.deepEqual(p.rest.map((a) => a.type), ['type', 'key']);
  assert.match(undoSummary(p, describe), /then look and try to reverse: typed hi there · pressed enter \(clicks and keys can't always be undone\)/);
});

test('multi-line, very long text, or a stale run is never backspaced', () => {
  assert.equal(planUndo(done('[TYPE:line one\nline two]')).local.length, 0);
  assert.equal(planUndo(done(`[TYPE:${'x'.repeat(MAX_LOCAL_CHARS + 1)}]`)).local.length, 0);
  const stale = planUndo(done('[TYPE:hello]'), false);
  assert.equal(stale.local.length, 0);
  assert.equal(stale.rest.length, 1);
});

test('nothing done → nothing to undo', () => {
  const p = planUndo(done('[WAIT:300]'));
  assert.equal(undoSummary(p, describe), 'nothing to undo');
});

test('the model prompt lists the steps, what was already reversed, and the safety rules', () => {
  const p = planUndo(done('[CLICK:1,1:bold:screen1][TYPE:hey]'));
  const mac = undoPrompt(p, describe, 'darwin');
  assert.match(mac, /1\. clicked bold/);
  assert.match(mac, /already reversed the last part itself \(delete “hey” \(3 characters\)\)/);
  assert.match(mac, /cmd\+z/);
  assert.match(mac, /never send, submit, delete, pay/);
  assert.match(undoPrompt(p, describe, 'win32'), /ctrl\+z/);
});

test('undo runs never chain destructive steps', () => {
  const unsafe = (tags: string) => undoUnsafe(parseActionTags(tags).actions);
  assert.equal(unsafe('[CLICK:1,1:send:screen1]'), 'send');
  assert.equal(unsafe('[CLICK:1,1:Delete draft:screen1]'), 'delete draft');
  assert.equal(unsafe('[KEY:enter]'), 'enter');
  assert.equal(unsafe('[KEY:cmd+backspace]') !== null, true);
  assert.equal(unsafe('[KEY:delete]') !== null, true);
  assert.equal(unsafe('[KEY:cmd+w]') !== null, true);
  assert.equal(unsafe('[TYPE:a\nb]'), 'typing a new line');
  // the ordinary undo moves are fine
  assert.equal(unsafe('[KEY:cmd+z]'), null);
  assert.equal(unsafe('[KEY:ctrl+z][KEY:esc][CLICK:1,1:bold:screen1][KEY:backspace]'), null);
  assert.equal(undoHint('u'), 'u to undo');
  assert.equal(undoHint(''), 'undo');
});
