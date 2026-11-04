import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wantsAction } from '../src/main/action-tags.ts';

test('requests to act', () => {
  for (const t of ['open apple music', 'Open Apple Music', 'can you open spotify', 'please click next', 'clickity, play the next song',
    'go to settings', 'type hello world', 'scroll down', 'search for cats', 'pause the music', 'agent: open my email', 'switch to chrome'])
    assert.equal(wantsAction(t), true, t);
});
test('questions and chat', () => {
  for (const t of ['where is the save button?', 'what is this?', 'how do i export a pdf', 'is music open?', 'thanks!', 'explain this error', ''])
    assert.equal(wantsAction(t), false, t);
});
