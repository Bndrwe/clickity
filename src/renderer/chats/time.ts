// Relative times and sidebar date groups.

const DAY = 86_400_000;

function startOfDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export type Group = 'today' | 'yesterday' | 'previous 7 days' | 'older';
export const GROUPS: Group[] = ['today', 'yesterday', 'previous 7 days', 'older'];

export function groupOf(t: number, now = Date.now()): Group {
  const today = startOfDay(now);
  if (t >= today) return 'today';
  if (t >= today - DAY) return 'yesterday';
  if (t >= today - 7 * DAY) return 'previous 7 days';
  return 'older';
}

export function relTime(t: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return 'now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const hr = Math.round(m / 60);
  if (hr < 24 && t >= startOfDay(now)) return `${hr}h`;
  const d = Math.max(1, Math.round((startOfDay(now) - startOfDay(t)) / DAY));
  if (d < 7) return `${d}d`;
  const date = new Date(t);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date
    .toLocaleDateString(undefined, sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' })
    .toLowerCase();
}

export function clock(t: number): string {
  return new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }).toLowerCase();
}
