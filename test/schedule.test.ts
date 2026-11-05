import test from 'node:test';
import assert from 'node:assert/strict';
import { describeSchedule, isDue, lastSlot, nextRun } from '../src/main/schedule.ts';

// 2026-11-04 is a wednesday
const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m);

test('nextRun / lastSlot', () => {
  const s = { days: [1, 2, 3, 4, 5], time: '09:00' };
  assert.equal(nextRun(s, at(4, 8))!.getTime(), at(4, 9).getTime());
  assert.equal(nextRun(s, at(4, 9))!.getTime(), at(5, 9).getTime());
  assert.equal(nextRun(s, at(6, 10))!.getTime(), at(9, 9).getTime()); // friday → monday
  assert.equal(lastSlot(s, at(8, 12))!.getTime(), at(6, 9).getTime()); // sunday → friday
  assert.equal(nextRun({ days: [], time: '09:00' }, at(4, 8)), null);
});

test('isDue: once per slot, missed runs within the grace window, not before creation', () => {
  const s = { days: [3], time: '09:00' };
  assert.ok(isDue({ ...s, createdAt: at(4, 8).getTime() }, at(4, 9, 0)));
  assert.ok(!isDue({ ...s, createdAt: at(4, 8).getTime(), lastRun: at(4, 9, 0).getTime() }, at(4, 9, 1)));
  assert.ok(isDue({ ...s, createdAt: at(1, 8).getTime() }, at(4, 13))); // slept through 9:00
  assert.ok(!isDue({ ...s, createdAt: at(1, 8).getTime() }, at(4, 20))); // too late
  assert.ok(!isDue({ ...s, createdAt: at(4, 10).getTime() }, at(4, 10, 30))); // created after the slot
});

test('describe', () => {
  assert.equal(describeSchedule({ days: [1, 2, 3, 4, 5], time: '09:00' }), 'weekdays at 09:00');
  assert.equal(describeSchedule({ days: [1, 3], time: '07:15' }), 'mon, wed at 07:15');
});
