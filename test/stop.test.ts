// Stop / pause key: state logic, hints, pause bookkeeping, double-delivery dedupe, validation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PauseControl, PressDedupe, busyState, stopHint, stopKeyProblem, stopStep, type AgentSnap, type BusySnapshot } from '../src/main/stop-logic.ts';
import { ChordEngine, type HotkeyHandlers } from '../src/main/chord-engine.ts';
import { fixEnums } from '../src/main/settings-validate.ts';

const agent = (o: Partial<AgentSnap> = {}): AgentSnap => ({ running: true, pausing: false, paused: false, confirming: false, countdown: false, ...o });
const snap = (turn: BusySnapshot['turn'], dictation = false): BusySnapshot => ({ turn, dictation });

test('idle: nothing busy, nothing to stop', () => {
  assert.equal(busyState(snap(null)), null);
  assert.equal(stopStep(snap(null), 'key'), 'none');
});

test('voice / typed turns: busy and global, the key cancels', () => {
  for (const kind of ['voice', 'type'] as const) {
    assert.deepEqual(busyState(snap({ kind, agent: null })), { mode: 'stop', global: true });
    assert.equal(stopStep(snap({ kind, agent: null }), 'key'), 'cancel-turn');
  }
});

test('chats-window replies: busy but not global; the global key leaves them, stop buttons stop them', () => {
  const s = snap({ kind: 'window', agent: null });
  assert.deepEqual(busyState(s), { mode: 'stop', global: false });
  assert.equal(stopStep(s, 'key'), 'none');
  assert.equal(stopStep(s, 'stop'), 'cancel-turn');
});

test('agent run: the first press pauses, a second stops; explicit stop always stops', () => {
  assert.deepEqual(busyState(snap({ kind: 'voice', agent: agent() })), { mode: 'pause', global: true });
  assert.equal(stopStep(snap({ kind: 'voice', agent: agent() }), 'key'), 'pause-agent');
  assert.equal(stopStep(snap({ kind: 'voice', agent: agent({ pausing: true }) }), 'key'), 'stop-agent');
  assert.equal(stopStep(snap({ kind: 'voice', agent: agent({ paused: true }) }), 'key'), 'stop-agent');
  assert.equal(stopStep(snap({ kind: 'voice', agent: agent() }), 'stop'), 'stop-agent');
  assert.deepEqual(busyState(snap({ kind: 'voice', agent: agent({ paused: true }) })), { mode: 'paused', global: true });
  // an agent run started from the chats window acts on the screen: the global key applies
  assert.deepEqual(busyState(snap({ kind: 'window', agent: agent() })), { mode: 'pause', global: true });
  assert.equal(stopStep(snap({ kind: 'window', agent: agent() }), 'key'), 'pause-agent');
});

test('agent countdown / confirm: the key stops (cancel) instead of pausing', () => {
  assert.deepEqual(busyState(snap({ kind: 'voice', agent: agent({ countdown: true }) })), { mode: 'stop', global: true });
  assert.equal(stopStep(snap({ kind: 'voice', agent: agent({ countdown: true }) }), 'key'), 'stop-agent');
  assert.equal(stopStep(snap({ kind: 'voice', agent: agent({ confirming: true }) }), 'key'), 'stop-agent');
});

test('agent final words (loop over): a plain stop', () => {
  const s = snap({ kind: 'voice', agent: agent({ running: false }) });
  assert.deepEqual(busyState(s), { mode: 'stop', global: true });
  assert.equal(stopStep(s, 'key'), 'cancel-turn');
});

test('dictation / drafts: busy, global, the key cancels them', () => {
  assert.deepEqual(busyState(snap(null, true)), { mode: 'stop', global: true });
  assert.equal(stopStep(snap(null, true), 'key'), 'dictation');
  assert.equal(stopStep(snap({ kind: 'window', agent: null }, true), 'key'), 'dictation');
});

test('hints use the configured key label', () => {
  assert.equal(stopHint('stop', 'esc'), 'esc to stop');
  assert.equal(stopHint('pause', 'esc'), 'esc to pause');
  assert.equal(stopHint('paused', 'f8'), 'paused · enter / f8');
});

test('PauseControl: pause, reach a safe point, resume; second request stops', () => {
  const p = new PauseControl();
  assert.equal(p.reached(), false);
  assert.equal(p.request(), 'pause');
  assert.equal(p.pending, true);
  assert.equal(p.request(), 'stop');
  assert.equal(p.reached(), true);
  assert.equal(p.state, 'paused');
  assert.equal(p.reached(), false);
  assert.equal(p.resume(), true);
  assert.equal(p.state, 'running');
  assert.equal(p.resume(), false);
  assert.equal(p.request(), 'pause');
});

test('PressDedupe: the other path echoing the same press is dropped, real double presses count', () => {
  const d = new PressDedupe(400);
  assert.equal(d.accept('grab', 1000), true);
  assert.equal(d.accept('hook', 1030), false); // echo of the same press
  assert.equal(d.accept('grab', 1250), true); // a second real press (pause → stop)
  assert.equal(d.accept('hook', 1270), false);
  assert.equal(d.accept('hook', 2000), true); // much later: a new press via the hook alone
  assert.equal(d.accept('hook', 2100), true);
  d.note('grab', 3000);
  assert.equal(d.accept('hook', 3100), false);
});

test('stop key validation', () => {
  assert.equal(stopKeyProblem(['Escape']), null);
  assert.equal(stopKeyProblem(['F8']), null);
  assert.equal(stopKeyProblem(['Control', 'KeyQ']), null);
  assert.equal(stopKeyProblem(['Meta', 'Alt', 'Period']), null);
  assert.equal(stopKeyProblem(['Shift', 'Escape']), null);
  assert.match(stopKeyProblem(['KeyQ'])!, /esc/);
  assert.match(stopKeyProblem(['Enter'])!, /esc/);
  assert.match(stopKeyProblem(['Shift', 'KeyQ'])!, /esc/);
  assert.match(stopKeyProblem(['Fn', 'Escape'])!, /fn/);
  assert.match(stopKeyProblem(['DoubleTap', 'Control'])!, /tap/);
  assert.match(stopKeyProblem(['Control', 'Alt'])!, /besides/);
  assert.match(stopKeyProblem(['Control', 'KeyA', 'KeyB'])!, /one key/);
  assert.ok(stopKeyProblem([]));
  assert.ok(stopKeyProblem(undefined));
});

test('settings: a missing or broken stop key becomes esc (migration), a good one stays', () => {
  const base = () => ({
    theme: 'system', speech: { stt: { provider: 'on-device' }, tts: { provider: 'system' } },
    hotkeys: { talk: ['Control', 'Alt'], type: ['Control', 'Alt', 'Space'], mode: 'hold' } as Record<string, unknown>,
    companion: { offsetX: 0, offsetY: 0, show: 'always', actions: 'ask', maxSteps: 8 },
  });
  const d = base() as any;
  d.hotkeys.stop = ['Escape'];
  const older = base() as any; // settings.json from before the stop key
  fixEnums(older, d, 'linux');
  assert.deepEqual(older.hotkeys.stop, ['Escape']);
  const bad = base() as any;
  bad.hotkeys.stop = ['KeyQ'];
  fixEnums(bad, d, 'linux');
  assert.deepEqual(bad.hotkeys.stop, ['Escape']);
  const fn = base() as any;
  fn.hotkeys.stop = ['Fn', 'F1'];
  fixEnums(fn, d, 'darwin');
  assert.deepEqual(fn.hotkeys.stop, ['Escape']);
  const good = base() as any;
  good.hotkeys.stop = ['Control', 'Period'];
  fixEnums(good, d, 'linux');
  assert.deepEqual(good.hotkeys.stop, ['Control', 'Period']);
});

function engine(stop?: string[]) {
  const calls: string[] = [];
  const h: HotkeyHandlers = {
    onTalkDown: () => calls.push('talkDown'),
    onTalkUp: () => calls.push('talkUp'),
    onType: () => calls.push('type'),
    onEscape: () => calls.push('escape'),
    onStop: () => calls.push('stop'),
  };
  const e = new ChordEngine(h, { talk: ['Control', 'Alt'], type: ['Control', 'Alt', 'Space'], mode: 'hold', stop }, 0);
  return { e, calls };
}

test('chord engine: esc is the stop key by default (onStop), plain esc reaches onEscape with a custom stop key', () => {
  const a = engine();
  a.e.keyDown('Escape');
  a.e.keyUp('Escape');
  assert.deepEqual(a.calls, ['stop']);
  const b = engine(['F8']);
  b.e.keyDown('Escape');
  b.e.keyUp('Escape');
  b.e.keyDown('F8');
  b.e.keyUp('F8');
  assert.deepEqual(b.calls, ['escape', 'stop']);
  const c = engine(['Control', 'Period']);
  c.e.keyDown('Control');
  c.e.keyDown('Period');
  c.e.keyUp('Period');
  c.e.keyUp('Control');
  assert.deepEqual(c.calls, ['stop']);
});
