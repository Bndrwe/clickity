import test from 'node:test';
import assert from 'node:assert/strict';
import { TipsPolicy, isPrivateApp, parseTipReply, privacyBlocksScreens, quietReason } from '../src/shared/tips.ts';

const MIN = 60_000;
const active = { idleSec: 2, busy: false, pending: false };
const ctx = (app: string, title: string) => ({ app, title });

test('looks every 45–90 s, only while the user is active and clickity is free', () => {
  const p = new TipsPolicy(0, {}, () => 0.5); // interval 67.5 s
  assert.deepEqual(p.shouldLook(30_000, active), { look: false, reason: 'not-yet' });
  assert.deepEqual(p.shouldLook(70_000, { ...active, busy: true }), { look: false, reason: 'busy' });
  // a "no" for busy keeps the slot short: it looks again ~10 s later
  assert.deepEqual(p.shouldLook(81_000, { ...active, idleSec: 600 }), { look: false, reason: 'idle' });
  assert.deepEqual(p.shouldLook(97_000, active), { look: true });
  assert.deepEqual(p.shouldLook(100_000, active), { look: false, reason: 'not-yet' });
  assert.ok(p.nextLook() >= 97_000 + 45_000 && p.nextLook() <= 97_000 + 90_000);
  // a waiting dot: no new look
  assert.deepEqual(p.shouldLook(200_000, { ...active, pending: true }), { look: false, reason: 'pending' });
});

test('never during calls or video, never for clickity itself or private apps', () => {
  const p = new TipsPolicy(0);
  assert.deepEqual(p.assess(ctx('zoom.us', 'Zoom Meeting'), 1), { ask: false, reason: 'call' });
  assert.deepEqual(p.assess(ctx('Google Chrome', 'Weekly sync - Google Meet'), 2), { ask: false, reason: 'call' });
  assert.deepEqual(p.assess(ctx('firefox', 'Lofi beats - YouTube — Mozilla Firefox'), 3), { ask: false, reason: 'video' });
  assert.deepEqual(p.assess(ctx('vlc', 'movie.mkv'), 4), { ask: false, reason: 'video' });
  assert.deepEqual(p.assess(ctx('clickity', 'settings'), 5), { ask: false, reason: 'clickity' });
  const privacy = { neverScreenshotApps: ['1Password', 'Signal'] };
  assert.deepEqual(p.assess(ctx('1Password', 'Vault'), 6, privacy), { ask: false, reason: 'private' });
  assert.equal(quietReason(ctx('code', 'main.ts — clickity')), null);
});

test('only asks the model when something is new: an error title, a new window, back-and-forth', () => {
  const p = new TipsPolicy(0);
  const a = p.assess(ctx('code', 'build failed — terminal'), 1000);
  assert.equal(a.ask, true);
  assert.deepEqual(a.ask && a.signals, ['error-on-screen', 'new-window']);
  // same window, no alarm: nothing new
  assert.deepEqual(p.assess(ctx('code', 'notes.md'), 2000).ask, true); // new window
  assert.deepEqual(p.assess(ctx('code', 'notes.md'), 3000), { ask: false, reason: 'nothing-new' });
  // switching between two windows over and over
  const q = new TipsPolicy(0);
  let t = 0;
  for (let i = 0; i < 6; i++) q.noteFocus(ctx('excel', i % 2 ? 'budget.xlsx' : 'report.docx'), (t += 20_000));
  assert.equal(q.repeating(t), true);
  const r = q.assess(ctx('excel', 'budget.xlsx'), t + 1000);
  assert.ok(r.ask && r.signals.includes('repeating'));
});

test('model budget per hour', () => {
  const p = new TipsPolicy(0, { modelPerHour: 2 });
  assert.equal(p.assess(ctx('a', 'one'), 1).ask, true);
  assert.equal(p.assess(ctx('a', 'two'), 2).ask, true);
  assert.deepEqual(p.assess(ctx('a', 'three'), 3), { ask: false, reason: 'model-budget' });
  assert.equal(p.assess(ctx('a', 'four'), 3600_000 + 10).ask, true);
});

test('offers: per-hour cap, a gap, no repeats, and "not now" snoozes', () => {
  const p = new TipsPolicy(0, { perHour: 2, minGapMs: 5 * MIN });
  const c = ctx('code', 'error.log');
  assert.deepEqual(p.offer(null, c, 1), { offer: false, reason: 'empty' });
  assert.deepEqual(p.offer('press cmd+shift+t to reopen the tab you just closed', c, 10), { offer: true });
  assert.deepEqual(p.offer('use ctrl+d to duplicate the line', c, 2 * MIN), { offer: false, reason: 'gap' });
  assert.deepEqual(p.offer('use ctrl+d to duplicate the line', c, 6 * MIN), { offer: true });
  assert.deepEqual(p.offer('try the find and replace box', c, 12 * MIN), { offer: false, reason: 'rate' });
  assert.equal(p.offeredLastHour(12 * MIN), 2);
  // the hour rolls; the same tip text never comes back the same day
  assert.deepEqual(p.offer('Press Cmd+Shift+T to reopen the tab you just closed!', c, 70 * MIN), { offer: false, reason: 'repeat' });
  assert.deepEqual(p.offer('a brand new tip about something', c, 71 * MIN), { offer: true });
  p.snooze(72 * MIN);
  assert.deepEqual(p.offer('another genuinely useful tip', c, 90 * MIN), { offer: false, reason: 'snoozed' });
  assert.deepEqual(p.shouldLook(95 * MIN, active).look, false);
});

test('a window the model had nothing for is not asked about again', () => {
  const p = new TipsPolicy(0);
  const c = ctx('code', 'readme.md');
  assert.equal(p.assess(c, 1).ask, true);
  p.offer(null, c, 2);
  p.assess(ctx('code', 'other.md'), 3);
  assert.deepEqual(p.assess(c, 4), { ask: false, reason: 'nothing-new' });
});

test('model replies', () => {
  assert.equal(parseTipReply('{"tip": null}'), null);
  assert.equal(parseTipReply('```json\n{"tip": "none"}\n```'), null);
  assert.equal(parseTipReply('nope'), null);
  assert.equal(parseTipReply('{"tip": "short"}'), null);
  assert.equal(parseTipReply('Sure! {"tip": "the build failed on a missing semicolon in line 12 of app.ts."}'), 'the build failed on a missing semicolon in line 12 of app.ts.');
});

test('privacy field read defensively', () => {
  assert.equal(isPrivateApp('Signal', undefined), false);
  assert.equal(isPrivateApp('Signal', { apps: [{ name: 'signal' }] }), true);
  assert.equal(isPrivateApp('Code', { apps: ['signal'] }), false);
  assert.equal(privacyBlocksScreens({ screenshots: false }), true);
  assert.equal(privacyBlocksScreens('weird'), false);
});
