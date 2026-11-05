import test from 'node:test';
import assert from 'node:assert/strict';
import { GREETINGS, allGreetings, chooseContext, cleanName, fillName, hasNameSlot, pickGreeting, timeOfDay, dayPool, type GreetingContext } from '../src/shared/greetings.ts';

const norm = (l: string) => l.toLowerCase().replace(/\{name\}/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const words = (l: string) => l.replace(/\{name\}/g, 'name').split(/\s+/).filter(Boolean);

test('at least 350 greetings, every context filled', () => {
  assert.ok(allGreetings().length >= 350, `only ${allGreetings().length}`);
  for (const [ctx, lines] of Object.entries(GREETINGS)) assert.ok(lines.length >= 20, `${ctx} has ${lines.length}`);
});

test('no exact or near duplicates', () => {
  const lines = allGreetings();
  assert.equal(new Set(lines).size, lines.length, 'exact duplicates');
  // "Good morning." and "Good morning, {name}." are deliberate twins (the fallback when no name is set),
  // so the near-duplicate checks run within the named and the unnamed lines separately.
  const seen = new Map<string, string>();
  for (const l of lines) {
    const n = (hasNameSlot(l) ? 'N:' : 'U:') + norm(l);
    assert.ok(!seen.has(n), `near duplicate: "${l}" ~ "${seen.get(n)}"`);
    seen.set(n, l);
  }
  // word-overlap check
  const sets = lines.map((l) => ({ l, w: new Set(norm(l).split(' ').filter((x) => x.length > 2)) }));
  for (let i = 0; i < sets.length; i++)
    for (let j = i + 1; j < sets.length; j++) {
      const a = sets[i]!, b = sets[j]!;
      if (hasNameSlot(a.l) !== hasNameSlot(b.l)) continue;
      if (a.w.size < 3 || b.w.size < 3) continue;
      let inter = 0;
      for (const x of a.w) if (b.w.has(x)) inter++;
      const jac = inter / (a.w.size + b.w.size - inter);
      assert.ok(jac < 0.75, `too similar: "${a.l}" / "${b.l}"`);
    }
});

test('style: 2-7 words, sentence case, no emoji, no exclamation, ends with punctuation', () => {
  for (const l of allGreetings()) {
    const n = words(l).length;
    assert.ok(n >= 2 && n <= 7, `"${l}" has ${n} words`);
    assert.ok(l.length <= 48, `"${l}" too long`);
    assert.ok(/^[A-Z]/.test(l), `"${l}" must start uppercase`);
    assert.ok(/[.?]$/.test(l), `"${l}" must end with . or ?`);
    assert.ok(!/!/.test(l), `"${l}" exclamation`);
    assert.ok(!/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE0F}]/u.test(l), `"${l}" emoji`);
    assert.ok(!/\{(?!name\})/.test(l.replace(/\{name\}/g, '')), `"${l}" stray brace`);
  }
});

test('some lines carry a {name} slot, but most do not need one', () => {
  const named = allGreetings().filter(hasNameSlot).length;
  assert.ok(named >= 25 && named < allGreetings().length / 2);
  assert.ok(allGreetings().includes('What can I help you see?'));
});

test('time of day and day-of-week contexts', () => {
  assert.equal(timeOfDay(new Date(2026, 10, 5, 7)), 'morning');
  assert.equal(timeOfDay(new Date(2026, 10, 5, 13)), 'afternoon');
  assert.equal(timeOfDay(new Date(2026, 10, 5, 20)), 'evening');
  assert.equal(timeOfDay(new Date(2026, 10, 5, 2)), 'lateNight');
  assert.equal(dayPool(new Date(2026, 10, 7)), 'weekend'); // saturday
  assert.equal(dayPool(new Date(2026, 10, 9)), 'monday');
  assert.equal(dayPool(new Date(2026, 10, 6)), 'friday');
  assert.equal(dayPool(new Date(2026, 10, 5)), null);
  assert.equal(chooseContext(new Date(2026, 10, 5, 9), () => 0.1), 'any');
  assert.equal(chooseContext(new Date(2026, 10, 5, 9), () => 0.9), 'morning');
  assert.equal(chooseContext(new Date(2026, 10, 9, 9), () => 0.35), 'monday');
});

function store() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
}

test('never repeats until the whole pool has been shown, then starts over', () => {
  const storage = store();
  const ctx: GreetingContext = 'monday';
  const unnamed = GREETINGS[ctx].filter((l) => !hasNameSlot(l));
  const seen = new Set<string>();
  for (let i = 0; i < unnamed.length; i++) {
    const g = pickGreeting({ storage, context: ctx, scope: 't' });
    assert.ok(!seen.has(g), `repeated "${g}" after ${i}`);
    assert.ok(!g.includes('{'));
    seen.add(g);
  }
  assert.equal(seen.size, unnamed.length);
  assert.ok(unnamed.includes(pickGreeting({ storage, context: ctx, scope: 't' }))); // next round begins
});

test('{name} is only filled when a name is set', () => {
  const storage = store();
  for (let i = 0; i < 80; i++) assert.ok(!pickGreeting({ storage, context: 'any', name: '  ', scope: 'a' }).includes('{'));
  const out = new Set<string>();
  for (let i = 0; i < GREETINGS.evening.length; i++) out.add(pickGreeting({ storage, context: 'evening', name: 'Maya', scope: 'b' }));
  assert.equal(out.size, GREETINGS.evening.length);
  assert.ok([...out].some((l) => l.includes('Maya')));
  assert.ok([...out].every((l) => !l.includes('{')));
});

test('scopes rotate independently, and bad or missing storage still works', () => {
  const storage = store();
  const a = pickGreeting({ storage, context: 'friday', scope: 'x', random: () => 0.5 });
  const b = pickGreeting({ storage, context: 'friday', scope: 'y', random: () => 0.5 });
  assert.equal(a, b);
  const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
  assert.ok(pickGreeting({ storage: broken, context: 'any', scope: 'z' }).length > 0);
  assert.ok(pickGreeting({ storage: null, context: 'any', scope: 'z2' }).length > 0);
  const garbage = { getItem: () => '{nope', setItem: () => {} };
  assert.ok(pickGreeting({ storage: garbage, context: 'any', scope: 'g' }).length > 0);
});

test('names are cleaned', () => {
  assert.equal(cleanName('  Ada  {x}\n'), 'Ada x');
  assert.equal(cleanName('x'.repeat(100)).length, 40);
  assert.equal(cleanName(undefined), '');
  assert.equal(fillName('Hi, {name}.', 'Bo'), 'Hi, Bo.');
});
