// Routines: "every [days] at [time]: [prompt]". A 30 s scheduler runs each due routine as a
// normal turn in a new chat titled after it (screenshots only if asked, voice only if enabled),
// then shows a notification. Never while a turn or a choice question is in progress (queued for
// the next tick); runs missed while asleep fire once on wake (≤ 6 h late); offline = wait;
// 3 failures in a row pause the routine.
import { Notification, net, powerMonitor } from 'electron';
import type { Routine } from '../shared/types';
import { getSettings, updateSettings } from './settings-store';
import { describeSchedule, isDue } from './schedule';
import { log } from './log';

const TICK_MS = 30_000;
const MAX_FAILURES = 3;

export interface RoutineResult {
  ok: boolean;
  reply?: string;
  error?: string;
  chatId?: string;
}

interface Deps {
  /** a turn / choice / dictation is in progress: try again on the next tick */
  busy(): boolean;
  run(r: Routine): Promise<RoutineResult>;
}

let deps: Deps | null = null;
let timer: NodeJS.Timeout | null = null;
let running: string | null = null;
const queue: string[] = [];

function patchRoutine(id: string, patch: Partial<Routine>): void {
  const list = getSettings().routines;
  if (!list.some((r) => r.id === id)) return;
  updateSettings({ routines: list.map((r) => (r.id === id ? { ...r, ...patch } : r)) });
}

async function runOne(r: Routine, manual: boolean): Promise<void> {
  if (!deps) return;
  running = r.id;
  log('routines', `${manual ? 'running now' : 'due'}: "${r.prompt.slice(0, 60)}" (${describeSchedule(r)})`);
  // mark first: a crash mid-run must not make it fire again in a loop
  patchRoutine(r.id, { lastRun: Date.now() });
  let res: RoutineResult;
  try {
    res = await deps.run(r);
  } catch (err) {
    res = { ok: false, error: err instanceof Error ? err.message.split('\n')[0].toLowerCase() : String(err) };
  } finally {
    running = null;
  }
  const failures = res.ok ? 0 : (getSettings().routines.find((x) => x.id === r.id)?.failures ?? 0) + 1;
  const paused = !res.ok && failures >= MAX_FAILURES;
  patchRoutine(r.id, { failures, lastError: res.ok ? undefined : res.error, ...(paused ? { enabled: false, paused: true } : {}) });
  log('routines', res.ok ? 'finished' : `failed (${failures}): ${res.error}${paused ? ' — paused' : ''}`);
  try {
    if (Notification.isSupported()) {
      new Notification({
        title: res.ok ? `clickity · ${r.prompt.slice(0, 40)}` : 'clickity · routine failed',
        body: (res.ok ? res.reply ?? 'done' : `${res.error ?? 'something went wrong'}${paused ? ' — paused after 3 failures' : ''}`).slice(0, 220),
        silent: true,
      }).show();
    }
  } catch {
    /* notifications unavailable */
  }
}

function tick(): void {
  if (!deps || running) return;
  const now = new Date();
  for (const r of getSettings().routines) {
    if (r.enabled && r.prompt.trim() && !queue.includes(r.id) && isDue(r, now)) queue.push(r.id);
  }
  if (!queue.length) return;
  if (deps.busy()) return; // wait for the turn / question to finish
  if (!net.isOnline()) return; // offline: try again later (still within the grace window)
  const id = queue.shift()!;
  const r = getSettings().routines.find((x) => x.id === id);
  if (r && r.enabled) void runOne(r, false);
}

export function initRoutines(d: Deps): void {
  deps = d;
  timer = setInterval(tick, TICK_MS);
  timer.unref?.();
  setTimeout(tick, 5000).unref?.();
  try {
    powerMonitor.on('resume', () => setTimeout(tick, 10_000));
  } catch {
    /* ignore */
  }
}

/** Settings › routines › "run now". */
export async function runRoutineNow(id: string): Promise<void> {
  const r = getSettings().routines.find((x) => x.id === id);
  if (!r || !deps) throw new Error('no such routine');
  if (running) throw new Error('a routine is already running');
  await runOne(r, true);
}

/** For tests: check now instead of waiting for the 30 s tick. */
export function checkRoutinesNow(): void {
  tick();
}

export function stopRoutines(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
