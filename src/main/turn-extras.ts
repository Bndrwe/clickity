// Per-turn extras on top of conversation.ts: the system prompt sections for memory, highlights,
// walkthroughs, routines, live context and self-help; [REMEMBER] / [HIGHLIGHT] / [STEP] /
// [ROUTINE] handling after a reply; the guided walkthrough; agent-mode safety helpers.
// conversation.ts calls into this module at a handful of points (see ARCHITECTURE.md).
import { BrowserWindow, ipcMain, type Point } from 'electron';
import { IPC } from '../shared/ipc';
import type { OverlayHighlight, OverlayPoint, OverlayState, Routine, Settings } from '../shared/types';
import { screenshotToGlobal, type CapturedScreen } from './capture';
import { pickPointScreen } from './point-tags';
import { MAX_STEPS, parseExtraTags, stripExtraTags, type ParsedHighlight, type ParsedRoutine, type ParsedStep } from './extra-tags';
import { memoryPrompt, rememberFacts } from './memory';
import { liveContextPrompt, selfHelpPrompt } from './live-context';
import { broadcastToOverlays, overlayDisplay, overlayForDisplay, overlayForPoint, sendToOverlay } from './overlay';
import { grabKeys, hotkeyLabel, releaseKeys } from './hotkey';
import { getSettings, updateSettings } from './settings-store';
import { describeSchedule } from './schedule';
import { log } from './log';

/* ───────────────────────── system prompt ───────────────────────── */

function protocolPrompt(settings: Settings, screens: CapturedScreen[]): string {
  const parts: string[] = [];
  if (screens.length && settings.companion.pointing) {
    parts.push(`

HIGHLIGHTING AND WALKTHROUGHS
- To outline an area instead of pointing at one spot (a panel, a group of settings, a paragraph), add [HIGHLIGHT:x1,y1,x2,y2:label:screenN] with the top-left and bottom-right corners in screenshot pixels. It draws a soft outline that fades with your reply.
- When the user asks how to do something that takes several clicks ("walk me through…", "show me how to…"), give a guided walkthrough instead of POINT tags: one tag per step, in order, up to ${MAX_STEPS}: [STEP:n:x,y:label:instruction:screenN]. n starts at 1, x,y is where that step happens (screenshot pixels, like POINT), label is 1-4 words, instruction is one short sentence the user reads ("click the gear icon to open settings"). The companion goes to step 1 and the user presses enter for the next one. Only include steps you can see on the current screen; if later steps depend on screens you can't see yet, describe them in the last instruction.
- Your sentence before the tags should briefly say what you'll walk them through; never mention the tags.`);
  }
  parts.push(`

ROUTINES
If the user asks you to do something on a schedule ("every weekday at 9, summarise my screen"), add [ROUTINE:days|HH:MM|what to do] (days: daily, weekdays, weekends or e.g. mon,wed,fri; time in 24h). The user confirms it before it's saved; say you'll set it up once they confirm.`);
  return parts.join('');
}

/** Everything this module adds to the system prompt (async: live context probes the desktop). */
export async function extrasPrompt(settings: Settings, screens: CapturedScreen[]): Promise<string> {
  const h = settings.hotkeys;
  const p = process.platform;
  const live = await liveContextPrompt().catch(() => '');
  return (
    memoryPrompt(settings.memory?.enabled !== false, settings.activeClicky) + // the turn's clicky (named companions)
    protocolPrompt(settings, screens) +
    live +
    selfHelpPrompt({
      talk: hotkeyLabel(h.talk, p),
      type: hotkeyLabel(h.type, p),
      dictate: hotkeyLabel(h.dictate ?? [], p),
      typeTap: hotkeyLabel(h.typeTap ?? [], p),
      alwaysOn: hotkeyLabel(h.alwaysOn ?? [], p),
    })
  );
}

/** Visible text: also hide this module's tags. */
export function stripExtras(text: string, streaming: boolean): string {
  return stripExtraTags(text, streaming);
}

/* ───────────────────────── after a reply ───────────────────────── */

export interface ReplyExtras {
  steps: ParsedStep[];
  routines: ParsedRoutine[];
  highlights: number;
}

/** Store [REMEMBER] facts, draw [HIGHLIGHT]s, and return walkthrough steps / routine offers. */
export function handleReplyExtras(raw: string, screens: CapturedScreen[], settings: Settings): ReplyExtras {
  const tags = parseExtraTags(raw);
  if (tags.remember.length && settings.memory?.enabled !== false) rememberFacts(tags.remember, settings.activeClicky);
  let drawn = 0;
  if (tags.highlights.length && screens.length && settings.companion.pointing) drawn = drawHighlights(tags.highlights, screens);
  return { steps: screens.length ? tags.steps : [], routines: tags.routines, highlights: drawn };
}

function localRect(h: ParsedHighlight, screens: CapturedScreen[]): { win: BrowserWindow; rect: OverlayHighlight } | null {
  const target = pickPointScreen({ x: h.x1, y: h.y1, label: h.label, screen: h.screen }, screens);
  if (!target) return null;
  const clampX = (v: number) => Math.min(Math.max(v, 0), target.image.width);
  const clampY = (v: number) => Math.min(Math.max(v, 0), target.image.height);
  const a = screenshotToGlobal(target, clampX(h.x1), clampY(h.y1));
  const b = screenshotToGlobal(target, clampX(h.x2), clampY(h.y2));
  const win = overlayForDisplay(target.displayId) ?? overlayForPoint(a);
  if (!win) return null;
  const origin = overlayDisplay(win)?.bounds ?? win.getBounds();
  return { win, rect: { x: a.x - origin.x, y: a.y - origin.y, width: Math.max(4, b.x - a.x), height: Math.max(4, b.y - a.y), label: h.label } };
}

let highlighted = new Set<BrowserWindow>();
let clearTimer: NodeJS.Timeout | null = null;

function drawHighlights(list: ParsedHighlight[], screens: CapturedScreen[]): number {
  clearHighlights(0);
  const byWin = new Map<BrowserWindow, OverlayHighlight[]>();
  for (const h of list) {
    const r = localRect(h, screens);
    if (!r) continue;
    byWin.set(r.win, [...(byWin.get(r.win) ?? []), r.rect]);
  }
  for (const [win, rects] of byWin) {
    sendToOverlay(win, IPC.overlayHighlight, rects);
    highlighted.add(win);
  }
  log('turn', `highlighted ${[...byWin.values()].flat().length} area(s)`);
  return [...byWin.values()].flat().length;
}

/** Fade the outlines (after `delayMs`, so they leave together with the reply bubble). */
export function clearHighlights(delayMs = 2600): void {
  if (clearTimer) clearTimeout(clearTimer);
  clearTimer = null;
  if (!highlighted.size) return;
  const fade = () => {
    for (const w of highlighted) sendToOverlay(w, IPC.overlayHighlight, null);
    highlighted = new Set();
  };
  if (delayMs <= 0) fade();
  else clearTimer = setTimeout(fade, delayMs);
}

/* ───────────────────────── walkthrough ───────────────────────── */

const STEP_TIMEOUT_MS = 5 * 60 * 1000;
let walkNext: (() => void) | null = null;
let walkInit = false;
/** the same enter press can arrive twice (global-shortcut grab + the chord engine): one step per press */
let lastAdvance = 0;
const ADVANCE_DEBOUNCE_MS = 350;

function initWalkIpc(): void {
  if (walkInit) return;
  walkInit = true;
  ipcMain.on(IPC.walkNext, () => walkNext?.());
}

/** Enter (chord-engine backup): advance a running walkthrough. Returns whether one was running. */
export function walkthroughEnter(): boolean {
  if (!walkNext) return false;
  walkNext();
  return true;
}

export function walkthroughActive(): boolean {
  return !!walkNext;
}

function resolveStep(s: ParsedStep, screens: CapturedScreen[]): { win: BrowserWindow; point: OverlayPoint } | null {
  const target = pickPointScreen({ x: s.x, y: s.y, label: s.label, screen: s.screen }, screens);
  if (!target) return null;
  const g: Point = screenshotToGlobal(target, Math.min(Math.max(s.x, 0), target.image.width), Math.min(Math.max(s.y, 0), target.image.height));
  const win = overlayForDisplay(target.displayId) ?? overlayForPoint(g);
  if (!win) return null;
  const origin = overlayDisplay(win)?.bounds ?? win.getBounds();
  return { win, point: { x: g.x - origin.x, y: g.y - origin.y, label: s.label } };
}

/**
 * Guided walkthrough: fly to each step, show its instruction in the bubble, wait for enter / a
 * click on the bubble (next) or esc (end). Resolves when finished or stopped; never throws on esc.
 */
export async function runWalkthrough(opts: {
  steps: ParsedStep[];
  screens: CapturedScreen[];
  signal: AbortSignal;
  /** the turn's overlay (bubble) */
  overlay: BrowserWindow | null;
  /** remember overlays we pointed on, so the turn can recall the companion */
  pointed: Set<BrowserWindow>;
  /** say an instruction (voice on); resolves when spoken or immediately */
  say?: (text: string) => void;
}): Promise<'done' | 'ended'> {
  initWalkIpc();
  const steps = opts.steps.slice(0, MAX_STEPS).map((s) => ({ s, r: resolveStep(s, opts.screens) })).filter((x) => x.r);
  if (!steps.length) return 'done';
  log('turn', `walkthrough: ${steps.length} step(s)`);
  let prev: BrowserWindow | null = null;
  let outcome: 'done' | 'ended' = 'done';
  try {
    for (let i = 0; i < steps.length; i++) {
      if (opts.signal.aborted) return 'ended';
      const { s, r } = steps[i];
      const { win, point } = r!;
      if (prev && prev !== win) {
        sendToOverlay(prev, IPC.overlayPoint, null);
        sendToOverlay(prev, IPC.overlayWalkthrough, false);
        opts.pointed.delete(prev);
      }
      prev = win;
      const last = i === steps.length - 1;
      const st: OverlayState = { phase: 'speaking', reply: s.instruction, step: `step ${i + 1} of ${steps.length} · ${last ? 'enter to finish' : 'enter for next'} · esc to end` };
      sendToOverlay(win, IPC.overlayState, st);
      if (opts.overlay && opts.overlay !== win) sendToOverlay(opts.overlay, IPC.overlayState, { phase: 'idle' });
      sendToOverlay(win, IPC.overlayPoint, point);
      sendToOverlay(win, IPC.overlayWalkthrough, true);
      opts.pointed.add(win);
      opts.say?.(s.instruction);
      const next = await new Promise<'next' | 'end'>((resolve) => {
        const finish = (v: 'next' | 'end') => {
          clearTimeout(timer);
          opts.signal.removeEventListener('abort', onAbort);
          walkNext = null;
          releaseKeys('walkthrough');
          resolve(v);
        };
        const onAbort = () => finish('end');
        const timer = setTimeout(() => finish('end'), STEP_TIMEOUT_MS);
        opts.signal.addEventListener('abort', onAbort, { once: true });
        const next = () => {
          if (Date.now() - lastAdvance < ADVANCE_DEBOUNCE_MS) return;
          lastAdvance = Date.now();
          finish('next');
        };
        walkNext = next;
        grabKeys('walkthrough', { Return: next, Escape: () => finish('end') });
      });
      if (next === 'end') {
        outcome = 'ended';
        log('turn', `walkthrough ended at step ${i + 1}`);
        break;
      }
    }
  } finally {
    walkNext = null;
    releaseKeys('walkthrough');
    if (prev) sendToOverlay(prev, IPC.overlayWalkthrough, false);
  }
  return outcome;
}

/* ───────────────────────── routines from a reply ───────────────────────── */

let routineConfirm: ((ok: boolean) => void) | null = null;

let routineAnsweredAt = 0;
export function routineEnter(): boolean {
  if (!routineConfirm) return Date.now() - routineAnsweredAt < ADVANCE_DEBOUNCE_MS; // the echo of the same press
  routineAnsweredAt = Date.now();
  routineConfirm(true);
  return true;
}
export function routineEscape(): boolean {
  if (!routineConfirm) return false;
  routineConfirm(false);
  return true;
}

/** Ask (bubble: enter / esc) before saving a routine the model proposed. */
export async function offerRoutines(list: ParsedRoutine[], win: BrowserWindow | null, signal: AbortSignal): Promise<number> {
  let added = 0;
  for (const r of list.slice(0, 3)) {
    if (signal.aborted) break;
    const desc = `${describeSchedule(r)}: ${r.prompt}`;
    const ok = await new Promise<boolean>((resolve) => {
      const finish = (v: boolean) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        routineConfirm = null;
        releaseKeys('routine');
        resolve(v);
      };
      const onAbort = () => finish(false);
      const timer = setTimeout(() => finish(false), 60_000);
      signal.addEventListener('abort', onAbort, { once: true });
      routineConfirm = finish;
      grabKeys('routine', { Return: () => routineEnter(), Escape: () => finish(false) });
      sendToOverlay(win, IPC.overlayState, { phase: 'speaking', reply: desc, confirm: 'add this routine? (settings › routines)' });
    });
    if (!ok) continue;
    const routine: Routine = { id: `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, days: r.days, time: r.time, prompt: r.prompt, screen: /screen|look/i.test(r.prompt), speak: false, enabled: true, createdAt: Date.now() };
    updateSettings({ routines: [...getSettings().routines, routine] });
    log('routines', `added from a reply: ${desc}`);
    added++;
  }
  if (added) sendToOverlay(win, IPC.overlayCue, { text: added === 1 ? 'routine added' : `${added} routines added`, kind: 'done', ttl: 2200 });
  return added;
}

/* ───────────────────────── agent safety ───────────────────────── */

const DESTRUCTIVE = /\b(send|sent|delete|deleting|remove|erase|trash|discard|pay|payment|purchase|buy|checkout|check out|order|place order|post|publish|tweet|submit|transfer|wire|unsubscribe|sign out|log out|format|uninstall|empty trash|confirm payment)\b/i;

/**
 * A destructive step (send / delete / pay / post…) that must be confirmed even in automatic
 * mode. Looks at click labels, typed text and keys like cmd+enter / delete.
 */
export function destructiveReason(actions: Array<{ type: string; label?: string; text?: string; keys?: string[] }>): string | null {
  for (const a of actions) {
    if ((a.type === 'click' || a.type === 'doubleclick') && a.label && DESTRUCTIVE.test(a.label)) return a.label.toLowerCase();
    if (a.type === 'key' && a.keys) {
      const k = a.keys.join('+');
      if (/^(Meta|Control)\+(Enter|Backspace|Delete)$/.test(k) || /^(Shift\+)?Delete$/.test(k)) return k.toLowerCase();
    }
  }
  return null;
}

/** "starting in 3… esc to cancel" before automatic actions run. Rejects (abort) when cancelled. */
export async function countdown(signal: AbortSignal, show: (secondsLeft: number) => void, seconds = 3): Promise<void> {
  for (let n = seconds; n > 0; n--) {
    show(n);
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      const t = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, 1000);
      const onAbort = () => {
        clearTimeout(t);
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}

/** "always allow": agent mode becomes automatic (undo from the chats note or settings). */
export function alwaysAllow(): void {
  log('agent', 'always allow → agent mode automatic');
  updateSettings({ companion: { actions: 'auto' } });
  broadcastToOverlays(IPC.overlayCue, { text: 'agent mode is automatic now · undo in settings › companion', kind: 'info', ttl: 5000 });
}

/** A short "done" when an agent run / routine finishes and the bubble isn't shown. */
export function completionCue(win: BrowserWindow | null, settings: Settings, text = 'done'): void {
  if (settings.companion.showBubble) return;
  sendToOverlay(win, IPC.overlayCue, { text: `${text} ✓`, kind: 'done', ttl: 2400 });
}
