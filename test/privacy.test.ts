import test from 'node:test';
import assert from 'node:assert/strict';
import { blurWidth, cleanList, covers, matchName, normalizeName, pasteRect, privacyLine, privacyVerdict, sharpRect } from '../src/main/privacy-match.ts';
import { fixSafety } from '../src/main/settings-validate.ts';
import { DEFAULT_NEVER_CAPTURE } from '../src/shared/types.ts';

const LIST = ['1password', 'bitwarden', 'keychain access', 'keepassxc', 'online banking', 'keeper'];

test('app names match whole words, across platforms’ spellings', () => {
  assert.equal(normalizeName('1Password.app'), '1password');
  assert.equal(normalizeName('KeePassXC.exe'), 'keepassxc');
  assert.equal(matchName(LIST, '1Password'), '1password'); // mac / windows process
  assert.equal(matchName(LIST, '1Password 8'), '1password');
  assert.equal(matchName(LIST, '1password7'), '1password'); // glued version
  assert.equal(matchName(LIST, 'Bitwarden bitwarden'), 'bitwarden'); // linux WM_CLASS "bitwarden.Bitwarden"
  assert.equal(matchName(LIST, 'Keychain Access'), 'keychain access');
  assert.equal(matchName(LIST, 'Chase — Online Banking - Google Chrome'), 'online banking'); // a window title
  // no partial-word hits
  assert.equal(matchName(LIST, 'Zookeeper'), null);
  assert.equal(matchName(LIST, 'keepass notes'), null);
  assert.equal(matchName(LIST, ''), null);
  assert.equal(matchName([], '1Password'), null);
});

test('the list is cleaned: trimmed, deduped, capped', () => {
  assert.deepEqual(cleanList([' 1Password ', '1password', '', 7, 'Bit-warden', '!!!']), ['1Password', 'Bit-warden']);
  assert.equal(cleanList(Array.from({ length: 150 }, (_, i) => `app ${i}`)).length, 100);
  assert.deepEqual(cleanList('nope'), []);
});

const D1 = { id: 1, bounds: { x: 0, y: 0, width: 1440, height: 900 } };
const D2 = { id: 2, bounds: { x: 1440, y: 0, width: 1920, height: 1080 } };

test('verdict: a focused private app hides everything', () => {
  const v = privacyVerdict(LIST, '1Password', [], [D1, D2]);
  assert.equal(v.all, '1password');
});

test('verdict: a private window hides only the display it is on', () => {
  const v = privacyVerdict(LIST, 'Code', [{ app: 'Bitwarden', title: 'vault', bounds: { x: 1600, y: 100, width: 800, height: 600 } }, { app: 'Code', title: 'x', bounds: D1.bounds }], [D1, D2]);
  assert.equal(v.all, null);
  assert.equal(v.displays.get(2), 'bitwarden');
  assert.equal(v.displays.has(1), false);
  // a sliver over the edge doesn't count
  assert.equal(covers({ x: 1430, y: 0, width: 20, height: 400 }, D1.bounds), false);
  assert.equal(covers({ x: 1400, y: 0, width: 200, height: 400 }, D1.bounds), true);
});

test('verdict: unknown window position, or every display covered → nothing', () => {
  assert.equal(privacyVerdict(LIST, '', [{ app: 'KeePassXC', title: '', bounds: null }], [D1]).all, 'keepassxc');
  assert.equal(privacyVerdict(LIST, '', [{ app: 'x', title: 'Online Banking', bounds: { x: 0, y: 0, width: 3360, height: 1080 } }], [D1, D2]).all, 'online banking');
  assert.equal(privacyVerdict([], '1Password', [], [D1]).all, null);
});

test('the bubble lines', () => {
  assert.equal(privacyLine({ kind: 'app', name: '1Password' }), "didn't look — 1password is open");
  assert.equal(privacyLine({ kind: 'app', name: 'bitwarden', partial: true }), "didn't look at one screen — bitwarden is open there");
  assert.equal(privacyLine({ kind: 'private', minutesLeft: 8.2 }), "didn't look — private for 9 more min");
  assert.equal(privacyLine({ kind: 'private', minutesLeft: 0.1 }), "didn't look — private for 1 more min");
});

test('sharp box around the cursor, in image pixels, clamped', () => {
  const img = { width: 1568, height: 980 };
  const r = sharpRect(img, D1.bounds, { x: 720, y: 450 })!;
  assert.equal(r.width, Math.round(560 * (1568 / 1440)));
  assert.equal(Math.round(r.x + r.width / 2), 784);
  const corner = sharpRect(img, D1.bounds, { x: 5, y: 5 })!;
  assert.deepEqual([corner.x, corner.y], [0, 0]);
  const edge = sharpRect(img, D1.bounds, { x: 1439, y: 899 })!;
  assert.equal(edge.x + edge.width, 1568);
  assert.equal(edge.y + edge.height, 980);
  assert.equal(sharpRect(img, D1.bounds, { x: 2000, y: 10 }), null); // cursor on another screen
  assert.ok(blurWidth(1568) <= 60);
});

test('pasteRect copies exactly the box', () => {
  const w = 4, h = 3;
  const dst = Buffer.alloc(w * h * 4, 0);
  const src = Buffer.alloc(w * h * 4, 9);
  pasteRect(dst, src, w, { x: 1, y: 1, width: 2, height: 5 });
  const px = (x: number, y: number) => dst[(y * w + x) * 4];
  assert.equal(px(0, 0), 0);
  assert.equal(px(1, 1), 9);
  assert.equal(px(2, 2), 9);
  assert.equal(px(3, 1), 0);
  assert.equal(px(1, 0), 0);
});

test('settings: privacy / usage / undo key validated', () => {
  const d = { privacy: { neverCapture: [...DEFAULT_NEVER_CAPTURE], blur: 'off', privateUntil: 0 }, usage: { monthlyLimit: 0 }, hotkeys: { undo: ['KeyU'] } } as any;
  const now = 1_000_000;
  const s = { privacy: { neverCapture: ['  1Password', 3], blur: 'fuzzy', privateUntil: now + 365 * 86400_000 }, usage: { monthlyLimit: '12.345' }, hotkeys: { undo: ['DoubleTap', 'Control'] } } as any;
  fixSafety(s, d, now);
  assert.deepEqual(s.privacy.neverCapture, ['1Password']);
  assert.equal(s.privacy.blur, 'off');
  assert.equal(s.privacy.privateUntil, now + 24 * 3600_000);
  assert.equal(s.usage.monthlyLimit, 12.345);
  assert.deepEqual(s.hotkeys.undo, ['KeyU']); // taps can't be grabbed: back to u
  const old = { hotkeys: {} } as any; // a settings file from before these existed
  fixSafety(old, d, now);
  assert.equal(old.privacy.neverCapture.length, DEFAULT_NEVER_CAPTURE.length);
  assert.equal(old.usage.monthlyLimit, 0);
  assert.deepEqual(old.hotkeys.undo, ['KeyU']);
  const expired = { privacy: { neverCapture: [], blur: 'cursor', privateUntil: now - 1 }, usage: { monthlyLimit: -4 }, hotkeys: { undo: [] } } as any;
  fixSafety(expired, d, now);
  assert.equal(expired.privacy.privateUntil, 0);
  assert.equal(expired.privacy.blur, 'cursor');
  assert.equal(expired.usage.monthlyLimit, 0);
  assert.deepEqual(expired.hotkeys.undo, []);
});
