import test from 'node:test';
import assert from 'node:assert/strict';
import {
  billingFor,
  costOf,
  dayKey,
  emptyStore,
  fixStore,
  formatCost,
  formatTokens,
  monthCost,
  normalizeModel,
  priceFor,
  recordInto,
  shouldWarn,
  speechCost,
  summarize,
  turnUsage,
  usageLabel,
} from '../src/shared/usage-math.ts';

const close = (a: number | undefined, b: number) => assert.ok(a !== undefined && Math.abs(a - b) < 1e-12, `${a} ≈ ${b}`);

test('model ids normalise across providers', () => {
  assert.equal(normalizeModel('anthropic/claude-sonnet-5.5'), 'claude-sonnet-5-5');
  assert.equal(normalizeModel('models/gemini-3.8-flash'), 'gemini-3-8-flash');
  assert.equal(normalizeModel('openai/gpt-6.1-sol:beta'), 'gpt-6-1-sol');
  assert.equal(normalizeModel('  Claude-Opus-5-5 '), 'claude-opus-5-5');
});

test('billing: api keys cost money, subscriptions are included, local is free', () => {
  assert.equal(billingFor('anthropic-api'), 'api');
  assert.equal(billingFor('openrouter'), 'api');
  assert.equal(billingFor('claude-subscription'), 'subscription');
  assert.equal(billingFor('local'), 'local');
  assert.equal(priceFor('claude-subscription', 'sonnet'), null);
  assert.equal(priceFor('local', 'gemma4:12b'), null);
});

test('price lookup: specific rows before family fallbacks, openrouter ids match too', () => {
  assert.equal(priceFor('anthropic-api', 'claude-sonnet-5-5')!.input, 3);
  assert.equal(priceFor('openrouter', 'anthropic/claude-sonnet-5.5')!.output, 15);
  assert.equal(priceFor('gemini-api', 'gemini-3.5-flash-lite')!.input, 0.1);
  assert.equal(priceFor('gemini-api', 'gemini-3.8-flash')!.input, 0.3);
  assert.equal(priceFor('openai-api', 'gpt-6-luna')!.output, 2);
  assert.equal(priceFor('openrouter', 'mystery/thing-7b'), null);
  assert.equal(priceFor('openrouter', 'meta/llama-9:free')!.output, 0);
  // anthropic cache: reads 10%, writes 125% of input
  const p = priceFor('anthropic-api', 'claude-opus-5-5')!;
  close(p.cacheRead, 0.5);
  close(p.cacheWrite, 6.25);
});

test('cost math per 1M tokens, cache priced separately', () => {
  const p = priceFor('anthropic-api', 'claude-sonnet-5-5')!;
  // 2000 in × $3 + 500 out × $15 + 10000 cached × $0.30 + 1000 written × $3.75
  close(costOf({ input: 2000, output: 500, cacheRead: 10000, cacheWrite: 1000 }, p), (2000 * 3 + 500 * 15 + 10000 * 0.3 + 1000 * 3.75) / 1e6);
  assert.equal(costOf({ input: 10, output: 10 }, null), undefined);
  // the provider's own number wins (openrouter usage.cost)
  assert.equal(costOf({ input: 10, output: 10, costUsd: 0.0042 }, p), 0.0042);
  // garbage counts are ignored, never negative
  close(costOf({ input: -5, output: NaN as unknown as number }, p), 0);
});

test('turn usage for each billing kind', () => {
  const api = turnUsage('openai-api', 'gpt-6.1-sol', { input: 1000, output: 100, cacheRead: 3000 });
  assert.equal(api.billing, 'api');
  assert.equal(api.input, 4000);
  assert.equal(api.cached, 3000);
  close(api.cost, (1000 * 1.25 + 100 * 10 + 3000 * 0.125) / 1e6);
  assert.deepEqual(turnUsage('claude-subscription', 'sonnet', { input: 5, output: 5 }).billing, 'subscription');
  assert.equal(turnUsage('claude-subscription', 'sonnet', null).cost, undefined);
  const or = turnUsage('openrouter', 'x/y', { input: 1, output: 1, costUsd: 0.5 });
  assert.equal(or.cost, 0.5);
  assert.equal(or.exact, true);
});

test('labels: quiet and honest', () => {
  assert.equal(usageLabel({ billing: 'api', input: 1234, output: 84, cost: 0.0031 }), '~$0.0031 · 1.2k in · 84 out');
  assert.equal(usageLabel({ billing: 'api', input: 10, output: 2, cost: 0.5, exact: true }), '$0.50 · 10 in · 2 out');
  assert.equal(usageLabel({ billing: 'api', input: 10, output: 2 }), '10 in · 2 out · price unknown');
  assert.equal(usageLabel({ billing: 'subscription' }), 'included in your subscription');
  assert.equal(usageLabel({ billing: 'local', input: 2000, output: 30 }), 'free (local) · 2k in · 30 out');
  assert.equal(usageLabel(undefined), '');
  assert.equal(formatCost(0), '$0');
  assert.equal(formatCost(0.00004), '<$0.0001');
  assert.equal(formatCost(0.0125), '$0.01');
  assert.equal(formatCost(12.3), '$12.30');
  assert.equal(formatCost(1204.4), '$1,204');
  assert.equal(formatTokens(999), '999');
  assert.equal(formatTokens(250_000), '250k');
  assert.equal(formatTokens(1_250_000), '1.25m');
});

test('speech: tts by characters, stt by minutes, on-device free', () => {
  close(speechCost('tts', 'openai', 2000), 0.03);
  close(speechCost('stt', 'deepgram', 120), 0.0154);
  assert.equal(speechCost('tts', 'kokoro', 5000), 0);
  assert.equal(speechCost('stt', 'on-device', 60), 0);
});

test('store: per-day rows, month totals, soft limit warns once a month', () => {
  const s = emptyStore();
  recordInto(s, '2026-11-20', { provider: 'anthropic-api', model: 'claude-sonnet-5-5', billing: 'api', input: 100, output: 10, cost: 2 });
  recordInto(s, '2026-11-21', { provider: 'anthropic-api', model: 'claude-sonnet-5-5', billing: 'api', input: 100, output: 10, cost: 1.5 });
  recordInto(s, '2026-11-21', { provider: 'openrouter', model: 'x/unknown', billing: 'api', input: 5, output: 5 });
  recordInto(s, '2026-11-21', { provider: 'claude-subscription', model: 'sonnet', billing: 'subscription' });
  recordInto(s, '2026-10-31', { provider: 'anthropic-api', model: 'claude-sonnet-5-5', billing: 'api', cost: 9 });
  close(monthCost(s, '2026-11-21'), 3.5);
  assert.equal(shouldWarn(s, '2026-11-21', 5), false);
  assert.equal(shouldWarn(s, '2026-11-21', 3), true);
  s.warned = '2026-11';
  assert.equal(shouldWarn(s, '2026-11-21', 3), false);
  assert.equal(shouldWarn(s, '2026-11-21', 0), false);

  const sum = summarize(s, '2026-11-21', 3, new Date(2026, 10, 21));
  assert.equal(sum.today.calls, 3);
  close(sum.today.cost, 1.5);
  assert.equal(sum.month.calls, 4);
  assert.equal(sum.month.unpriced, 1);
  close(sum.month.cost, 3.5);
  assert.equal(sum.byModel[0]!.model, 'claude-sonnet-5-5');
  assert.equal(sum.byModel[0]!.calls, 2);
  assert.equal(sum.overLimit, true);
  assert.equal(sum.days.length, 30);
  assert.equal(sum.days.at(-1)!.day, '2026-11-21');
  close(sum.days.at(-1)!.cost, 1.5);
  assert.match(sum.priceNote, /estimates/);
});

test('store: old days are dropped, broken files are repaired', () => {
  const s = emptyStore();
  for (let i = 0; i < 405; i++) recordInto(s, dayKey(new Date(2025, 0, 1 + i)), { provider: 'local', model: 'm', billing: 'local' });
  assert.equal(Object.keys(s.days).length, 400);
  const fixed = fixStore({ days: { 'not-a-day': {}, '2026-11-01': { 'a|b': { calls: 2, cost: -1, input: 'x', billing: 'weird' } } }, warned: 7 });
  assert.deepEqual(Object.keys(fixed.days), ['2026-11-01']);
  const row = fixed.days['2026-11-01']!['a|b']!;
  assert.equal(row.calls, 2);
  assert.equal(row.cost, 0);
  assert.equal(row.input, 0);
  assert.equal(row.billing, 'api');
  assert.equal(fixed.warned, undefined);
  assert.deepEqual(fixStore(null), emptyStore());
});
