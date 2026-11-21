import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksHard, pickVoiceModel } from '../src/main/fast-model.ts';

const on = { enabled: true, agent: true };

test('plain voice questions use the fast model', () => {
  assert.deepEqual(pickVoiceModel('claude-subscription', 'sonnet', 'where is the save button?', on), { model: 'haiku', fast: true, reason: 'plain voice question' });
  assert.equal(pickVoiceModel('openai-api', 'gpt-6.1-sol', 'what does this error mean', on).model, 'gpt-6-luna');
  assert.equal(pickVoiceModel('gemini-api', 'gemini-3.8-flash', 'what is this', on).model, 'gemini-3.5-flash-lite');
});

test('agent requests, hard asks, pinned models and "off" keep the chosen model', () => {
  assert.equal(pickVoiceModel('claude-subscription', 'sonnet', 'open spotify and play jazz', on).model, 'sonnet');
  // with agent mode off "open …" is just a question about opening it
  assert.equal(pickVoiceModel('claude-subscription', 'sonnet', 'open spotify', { enabled: true, agent: false }).model, 'haiku');
  assert.equal(pickVoiceModel('claude-subscription', 'opus', 'explain step by step how this regex works', on).model, 'opus');
  assert.equal(pickVoiceModel('claude-subscription', 'sonnet', 'what is this', { ...on, pinned: true }).model, 'sonnet');
  assert.equal(pickVoiceModel('claude-subscription', 'sonnet', 'what is this', { enabled: false, agent: true }).model, 'sonnet');
  assert.equal(pickVoiceModel('local', 'gemma4:12b', 'what is this', on).model, 'gemma4:12b');
});

test('looksHard', () => {
  assert.ok(looksHard('write me a python script that renames these files'));
  assert.ok(looksHard('x'.repeat(300)));
  assert.ok(!looksHard('what app is this'));
});
