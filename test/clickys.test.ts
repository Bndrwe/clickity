import test from 'node:test';
import assert from 'node:assert/strict';
import { activeClicky, chatClickyId, clickyIdFor, fixClickys, parseSuggestions, parseSwitchCommand, settingsForClicky } from '../src/shared/clickys.ts';

const base = () =>
  ({
    provider: 'claude-subscription',
    models: { 'claude-subscription': 'sonnet', 'openai-api': 'gpt-x' },
    speech: { stt: {}, tts: { provider: 'system', voice: '', rate: 1 } },
    companion: { color: '#2f6bff', notch: 'off' },
    clickys: [],
    activeClicky: 'clickity',
  }) as any;

test('older settings get one default clicky carrying the companion color', () => {
  const s = fixClickys(base());
  assert.equal(s.clickys.length, 1);
  assert.deepEqual(s.clickys[0], { id: 'clickity', name: 'clickity', color: '#2f6bff', persona: '' });
  assert.equal(s.activeClicky, 'clickity');
});

test('broken / duplicate clickys are dropped and a missing active one falls back', () => {
  const s = base();
  s.clickys = [{ id: 'study', name: 'study buddy', color: 'blue', persona: 'x', provider: 'nope' }, { id: 'study', name: 'dupe' }, { id: 'Bad Id!' }, null, { id: 'code', name: '', persona: 5, voice: { provider: 'openai', voice: 'nova' } }];
  s.activeClicky = 'gone';
  s.companion.notch = 'sideways';
  fixClickys(s);
  assert.deepEqual(s.clickys.map((c: any) => c.id), ['study', 'code']);
  assert.equal(s.clickys[0].color, '');
  assert.equal(s.clickys[0].provider, undefined);
  assert.equal(s.clickys[1].name, 'code');
  assert.deepEqual(s.clickys[1].voice, { provider: 'openai', voice: 'nova' });
  assert.equal(s.activeClicky, 'study');
  assert.equal(s.companion.notch, 'off');
});

test('settingsForClicky applies brain + voice overrides and marks the clicky active', () => {
  const s = fixClickys(base());
  s.clickys.push({ id: 'coder', name: 'coding sidekick', color: '', persona: 'terse', provider: 'openai-api', model: 'gpt-5', voice: { provider: 'openai', voice: 'onyx' } });
  const e = settingsForClicky(s, 'coder');
  assert.equal(e.activeClicky, 'coder');
  assert.equal(e.provider, 'openai-api');
  assert.equal(e.models['openai-api'], 'gpt-5');
  assert.equal(e.speech.tts.voice, 'onyx');
  assert.equal(s.provider, 'claude-subscription'); // not mutated
  assert.equal(settingsForClicky(s, 'clickity').provider, 'claude-subscription');
  assert.equal(activeClicky(s).id, 'clickity');
});

test('switch commands', () => {
  const list = [
    { id: 'clickity', name: 'clickity', color: '', persona: '' },
    { id: 'study-buddy', name: 'study buddy', color: '', persona: '' },
    { id: 'coder', name: 'Coding Sidekick', color: '', persona: '' },
  ];
  assert.equal(parseSwitchCommand('switch to study buddy', list)?.id, 'study-buddy');
  assert.equal(parseSwitchCommand('Hey, switch to Study Buddy.', list)?.id, 'study-buddy');
  assert.equal(parseSwitchCommand('change to coding sidekick please', list)?.id, 'coder');
  assert.equal(parseSwitchCommand('switch back to clickity', list)?.id, 'clickity');
  assert.equal(parseSwitchCommand('talk to my study buddy', list)?.id, 'study-buddy');
  assert.equal(parseSwitchCommand('switch to the sidekick clicky', list)?.id, 'coder');
  assert.equal(parseSwitchCommand('switch to dark mode', list), null);
  assert.equal(parseSwitchCommand('how do i switch to study buddy mode in this app and keep my files', list), null);
  assert.equal(parseSwitchCommand('what is a study buddy', list), null);
});

test('ids, chat ownership', () => {
  assert.equal(clickyIdFor('Study Buddy!', []), 'study-buddy');
  assert.equal(clickyIdFor('study buddy', ['study-buddy']), 'study-buddy-2');
  assert.equal(clickyIdFor('✨', []), 'clicky');
  assert.equal(chatClickyId({}), 'clickity');
  assert.equal(chatClickyId({ clickyId: 'coder' }), 'coder');
});

test('suggestions parse from prose / fences and skip taken names', () => {
  const raw = 'sure!\n```json\n[{"name":"Spreadsheet Helper","persona":"You help with sheets.","why":"you live in excel"},{"name":"clickity","persona":"dupe"},{"name":"study buddy","persona":"You quiz me.","color":"#7c4dff"},{"name":"x"},{"name":"coding sidekick","persona":"You pair."},{"name":"fourth","persona":"no"}]\n```';
  const out = parseSuggestions(raw, ['clickity']);
  assert.deepEqual(out.map((s) => s.name), ['spreadsheet helper', 'study buddy', 'coding sidekick']);
  assert.equal(out[1].color, '#7c4dff');
  assert.match(out[0].color, /^#[0-9a-f]{6}$/);
  assert.equal(out[0].why, 'you live in excel');
  assert.deepEqual(parseSuggestions('no json here'), []);
});
