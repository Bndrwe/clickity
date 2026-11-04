import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clampToRect, dipToX11, macChord, macKeyCode, normalizeKeyName, splitChord, toWinAbsolute, WIN_EXTENDED,
  winChord, winVk, xdoChord, xdoKeysym,
} from '../src/main/input-keys.ts';

test('normalizeKeyName: canonical names pass through, loose names map', () => {
  for (const k of ['Control', 'Meta', 'KeyS', 'Digit3', 'F12', 'Enter', 'ArrowUp', 'Numpad5', 'BracketLeft']) {
    assert.equal(normalizeKeyName(k), k);
  }
  assert.equal(normalizeKeyName('ctrl'), 'Control');
  assert.equal(normalizeKeyName('cmd'), 'Meta');
  assert.equal(normalizeKeyName('option'), 'Alt');
  assert.equal(normalizeKeyName('a'), 'KeyA');
  assert.equal(normalizeKeyName('7'), 'Digit7');
  assert.equal(normalizeKeyName('return'), 'Enter');
  assert.equal(normalizeKeyName('esc'), 'Escape');
  assert.equal(normalizeKeyName('pagedown'), 'PageDown');
  assert.equal(normalizeKeyName('f5'), 'F5');
  assert.equal(normalizeKeyName('keyq'), 'KeyQ');
  assert.equal(normalizeKeyName('Bogus'), null);
});

test('splitChord orders modifiers and rejects bad chords', () => {
  assert.deepEqual(splitChord(['KeyS', 'Shift', 'Meta']), { mods: ['Shift', 'Meta'], main: 'KeyS' });
  assert.deepEqual(splitChord(['Control', 'Alt']), { mods: ['Control', 'Alt'], main: null });
  assert.throws(() => splitChord([]), /empty/);
  assert.throws(() => splitChord(['KeyA', 'KeyB']), /one non-modifier/);
  assert.throws(() => splitChord(['Nope']), /unknown key: nope|unknown key: Nope/);
});

test('macOS kVK codes', () => {
  assert.equal(macKeyCode('KeyA'), 0);
  assert.equal(macKeyCode('KeyS'), 1);
  assert.equal(macKeyCode('KeyZ'), 6);
  assert.equal(macKeyCode('KeyM'), 46);
  assert.equal(macKeyCode('Digit0'), 29);
  assert.equal(macKeyCode('Digit5'), 23);
  assert.equal(macKeyCode('Digit9'), 25);
  assert.equal(macKeyCode('Enter'), 36);
  assert.equal(macKeyCode('Backspace'), 51);
  assert.equal(macKeyCode('Delete'), 117);
  assert.equal(macKeyCode('Escape'), 53);
  assert.equal(macKeyCode('ArrowUp'), 126);
  assert.equal(macKeyCode('F1'), 122);
  assert.equal(macKeyCode('F12'), 111);
  assert.equal(macKeyCode('Numpad8'), 91);
  for (const l of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') assert.equal(typeof macKeyCode('Key' + l), 'number', l);
  const letters = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map((l) => macKeyCode('Key' + l));
  assert.equal(new Set(letters).size, 26);
  assert.deepEqual(macChord(['Meta', 'KeyS']), { code: 1, mods: ['cmd'] });
  assert.deepEqual(macChord(['cmd', 'shift', 'z']), { code: 6, mods: ['shift', 'cmd'] });
  assert.deepEqual(macChord(['Control', 'Fn']), { code: -1, mods: ['ctrl', 'fn'] });
});

test('windows virtual keys', () => {
  assert.equal(winVk('KeyA'), 0x41);
  assert.equal(winVk('KeyZ'), 0x5a);
  assert.equal(winVk('Digit0'), 0x30);
  assert.equal(winVk('F1'), 0x70);
  assert.equal(winVk('F24'), 0x87);
  assert.equal(winVk('Numpad9'), 0x69);
  assert.equal(winVk('Enter'), 0x0d);
  assert.equal(winVk('ArrowLeft'), 0x25 | WIN_EXTENDED);
  assert.equal(winVk('Delete'), 0x2e | WIN_EXTENDED);
  assert.equal(winVk('Slash'), 0xbf);
  assert.equal(winVk('Fn'), undefined);
  assert.deepEqual(winChord(['KeyS', 'Control']), [0x11, 0x53]);
  assert.deepEqual(winChord(['Meta', 'KeyD']), [0x5b | WIN_EXTENDED, 0x44]);
  assert.deepEqual(winChord(['Control', 'Shift', 'Escape']), [0x11, 0x10, 0x1b]);
});

test('xdotool keysyms', () => {
  assert.equal(xdoKeysym('KeyS'), 's');
  assert.equal(xdoKeysym('Digit4'), '4');
  assert.equal(xdoKeysym('Enter'), 'Return');
  assert.equal(xdoKeysym('Backspace'), 'BackSpace');
  assert.equal(xdoKeysym('PageDown'), 'Page_Down');
  assert.equal(xdoKeysym('Numpad3'), 'KP_3');
  assert.equal(xdoKeysym('F11'), 'F11');
  assert.equal(xdoChord(['Control', 'KeyS']), 'ctrl+s');
  assert.equal(xdoChord(['KeyT', 'Shift', 'Control']), 'ctrl+shift+t');
  assert.equal(xdoChord(['Meta']), 'super');
  assert.equal(xdoChord(['Alt', 'F4']), 'alt+F4');
  assert.equal(xdoChord(['Fn', 'ArrowUp']), 'Up');
  assert.throws(() => xdoChord(['Fn']), /empty/);
});

test('clampToRect keeps points on the display', () => {
  const r = { x: -1920, y: 0, width: 1920, height: 1080 };
  assert.deepEqual(clampToRect({ x: -2000, y: -5 }, r), { x: -1920, y: 0 });
  assert.deepEqual(clampToRect({ x: 50, y: 2000 }, r), { x: -1, y: 1079 });
  assert.deepEqual(clampToRect({ x: -100, y: 100 }, r), { x: -100, y: 100 });
});

test('toWinAbsolute normalises over the virtual desktop', () => {
  const v = { x: 0, y: 0, width: 3840, height: 2160 };
  assert.deepEqual(toWinAbsolute({ x: 0, y: 0 }, v), { x: 0, y: 0 });
  assert.deepEqual(toWinAbsolute({ x: 3839, y: 2159 }, v), { x: 65535, y: 65535 });
  assert.deepEqual(toWinAbsolute({ x: 1920, y: 1080 }, v), { x: Math.round(1920 * 65535 / 3839), y: Math.round(1080 * 65535 / 2159) });
  // second monitor to the left: virtual desktop starts at negative x
  const v2 = { x: -2560, y: -200, width: 2560 + 1920, height: 1440 };
  assert.deepEqual(toWinAbsolute({ x: -2560, y: -200 }, v2), { x: 0, y: 0 });
  assert.equal(toWinAbsolute({ x: 0, y: 0 }, v2).x, Math.round(2560 * 65535 / 4479));
  assert.deepEqual(toWinAbsolute({ x: 99999, y: -99999 }, v2), { x: 65535, y: 0 });
});

test('dipToX11 scales by the display factor', () => {
  assert.deepEqual(dipToX11({ x: 100, y: 50.4 }, 1), { x: 100, y: 50 });
  assert.deepEqual(dipToX11({ x: 100, y: 50 }, 2), { x: 200, y: 100 });
  assert.deepEqual(dipToX11({ x: 101, y: 33 }, 1.5), { x: 152, y: 50 });
  assert.deepEqual(dipToX11({ x: 10, y: 10 }, 0), { x: 10, y: 10 });
});
