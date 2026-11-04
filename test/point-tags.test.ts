import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePointTags, pickPointScreen, stripForDisplay, stripPointTags } from '../src/main/point-tags.ts';

test('parses tags with labels, colons and screens', () => {
  const pts = parsePointTags('there [POINT:10,20:save button:screen2][POINT:5.5, 6:a: b][POINT:none][POINT:1,2:screen 1][POINT:bad]');
  assert.deepEqual(pts, [
    { x: 10, y: 20, label: 'save button', screen: 2 },
    { x: 5.5, y: 6, label: 'a:b', screen: undefined },
    { x: 1, y: 2, label: 'here', screen: 1 },
  ]);
});

test('strips complete and trailing partial tags', () => {
  assert.equal(stripForDisplay('click this [POINT:1,2:x] [POI'), 'click this');
  assert.equal(stripPointTags('ok  [POINT:1,2:x:screen1]\n\n\n\nbye'), 'ok \n\nbye');
});

test('pickPointScreen: default cursor screen, skips unknown screens, screen0 = first', () => {
  const screens = [
    { index: 1, isCursorScreen: true, id: 'a' },
    { index: 2, isCursorScreen: false, id: 'b' },
  ];
  assert.equal(pickPointScreen({ x: 0, y: 0, label: 'x' }, screens)?.id, 'a');
  assert.equal(pickPointScreen({ x: 0, y: 0, label: 'x', screen: 2 }, screens)?.id, 'b');
  assert.equal(pickPointScreen({ x: 0, y: 0, label: 'x', screen: 3 }, screens), null);
  assert.equal(pickPointScreen({ x: 0, y: 0, label: 'x', screen: 0 }, screens)?.id, 'a');
  assert.equal(pickPointScreen({ x: 0, y: 0, label: 'x' }, []), null);
});
