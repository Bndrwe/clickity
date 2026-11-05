// Routine schedule math ("every mon–fri at 09:00"). Pure, local time, unit tested.

export interface Schedule {
  /** 0 = sunday … 6 = saturday */
  days: number[];
  /** "HH:MM" 24h local time */
  time: string;
}

/** A run missed while the computer slept still happens on wake if it is at most this late. */
export const MISSED_GRACE_MS = 6 * 60 * 60 * 1000;

function hm(time: string): { h: number; m: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? { h, m: min } : null;
}

/** The next scheduled time strictly after `from` (null if the schedule is empty / invalid). */
export function nextRun(s: Schedule, from: Date): Date | null {
  const t = hm(s.time);
  const days = new Set(s.days.filter((d) => Number.isInteger(d) && d >= 0 && d < 7));
  if (!t || !days.size) return null;
  for (let i = 0; i < 8; i++) {
    const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i, t.h, t.m, 0, 0);
    if (d.getTime() > from.getTime() && days.has(d.getDay())) return d;
  }
  return null;
}

/** The most recent scheduled time at or before `now` (within the last 8 days), or null. */
export function lastSlot(s: Schedule, now: Date): Date | null {
  const t = hm(s.time);
  const days = new Set(s.days);
  if (!t || !days.size) return null;
  for (let i = 0; i < 8; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i, t.h, t.m, 0, 0);
    if (d.getTime() <= now.getTime() && days.has(d.getDay())) return d;
  }
  return null;
}

/**
 * Should the routine run now? Yes when a scheduled slot has passed since it last ran (or since
 * it was created) and that slot is no more than `grace` ago — so a laptop that slept through
 * 9:00 runs it once on wake, but a week-old miss doesn't fire.
 */
export function isDue(s: Schedule & { lastRun?: number; createdAt?: number }, now: Date, grace = MISSED_GRACE_MS): boolean {
  const slot = lastSlot(s, now);
  if (!slot) return false;
  const since = Math.max(s.lastRun ?? 0, s.createdAt ?? 0);
  return slot.getTime() > since && now.getTime() - slot.getTime() <= grace;
}

const NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** "weekdays at 09:00", "every day at 18:30", "mon, wed at 07:15" */
export function describeSchedule(s: Schedule): string {
  const d = [...new Set(s.days)].sort();
  let days: string;
  if (d.length === 7) days = 'every day';
  else if (d.join() === '1,2,3,4,5') days = 'weekdays';
  else if (d.join() === '0,6') days = 'weekends';
  else days = d.map((x) => NAMES[x]).join(', ');
  return `${days} at ${s.time}`;
}
