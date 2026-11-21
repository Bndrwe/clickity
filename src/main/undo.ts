// Undo for agent mode. conversation.runAgent journals every action it performs; when a run is
// over the bubble offers "undo" for a few seconds (the undo key, default u, is grabbed only then)
// and the chats window shows "undo" under the run. See undo-plan.ts for what can be undone.
//
//   key (u)       → shows the plan in the bubble, enter does it, esc keeps everything
//   bubble / chats "undo" button → does it (the click is the yes)
//   the local part (backspaces / scroll back) runs right away; steps it can't reverse go to the
//   model as an agent turn with a fresh screenshot — that turn follows the normal ask / automatic
//   confirm, takes at most 4 steps and stops at anything that would send / delete / pay.
import { screen, type BrowserWindow } from 'electron';
import type { ChatEvent, InputAction, OverlayState } from '../shared/types';
import type { UndoResult } from '../shared/ipc';
import { IPC } from '../shared/ipc';
import { describeAction, type ParsedAction } from './action-tags';
import { LOCAL_MAX_AGE_MS, planUndo, undoHint, undoPrompt, undoSummary, type DoneAction, type UndoPlan } from './undo-plan';
import { chordToAccelerator, grabKeys, hotkeyLabel, releaseKeys, setAgentKeysSuspended } from './hotkey';
import { performActions } from './agent-input';
import { activeAppName } from './live-context';
import { getSettings } from './settings-store';
import { overlayForPoint, sendToOverlay } from './overlay';
import { sendToChats } from './chats-window';
import { log } from './log';

/** How long the bubble offers "undo" (and the undo key is grabbed) after a run. */
export const UNDO_OFFER_MS = 8000;

interface RunRecord {
  runId: number;
  chatId: string;
  /** the newest assistant turn of the run (the chats window's undo sits under it) */
  turnId: string;
  done: DoneAction[];
  at: number;
  /** focused app when the run ended (backspacing elsewhere would delete the wrong text) */
  app: string;
  overlay: BrowserWindow | null;
  over: boolean;
}

let last: RunRecord | null = null;
let offerTimer: NodeJS.Timeout | null = null;
let undoing = false;

/** conversation.ts: run the model part as an agent turn (fresh screenshot) */
type Runner = (chatId: string, modelText: string, userText: string) => Promise<void>;
let runner: Runner | null = null;
let busy: () => boolean = () => false;
export function setUndoRunner(r: Runner, isBusy: () => boolean): void {
  runner = r;
  busy = isBusy;
}

function emit(ev: ChatEvent): void {
  sendToChats(IPC.chatsEvent, ev);
}

function withdraw(): void {
  if (offerTimer) clearTimeout(offerTimer);
  offerTimer = null;
  releaseKeys('undo');
  if (last?.over) emit({ type: 'undo', chatId: last.chatId, turnId: last.turnId, available: false });
}

/** An agent-mode action just ran (conversation.performPlanned). */
export function journalAction(runId: number, chatId: string | null, turnId: string | null, parsed: ParsedAction, input: InputAction): void {
  if (!chatId) return;
  if (!last || last.runId !== runId) {
    withdraw();
    last = { runId, chatId, turnId: turnId ?? '', done: [], at: Date.now(), app: '', overlay: null, over: false };
  }
  if (turnId) last.turnId = turnId;
  last.done.push({ parsed, input: { ...input } as InputAction });
  last.at = Date.now();
}

function undoKeys(): string[] {
  return getSettings().hotkeys.undo ?? ['KeyU'];
}

/**
 * The run is over. Offer undo: the chats window's button, and (with `reply`: the run ended
 * normally and its final words are in the bubble) "u to undo" in the bubble for a few seconds.
 */
export function journalEnd(runId: number, overlay: BrowserWindow | null, reply: string | null): void {
  if (!last || last.runId !== runId || last.over || !last.done.some((d) => d.input.type !== 'wait')) return;
  last.over = true;
  last.overlay = overlay;
  const rec = last;
  void activeAppName()
    .catch(() => '')
    .then((app) => {
      if (last === rec) rec.app = app;
    });
  emit({ type: 'undo', chatId: rec.chatId, turnId: rec.turnId, available: true });
  const keys = undoKeys();
  // the key is only grabbed while the bubble says so (a run that failed shows its error instead)
  const accel = keys.length && reply !== null && overlay ? chordToAccelerator(keys) : null;
  const grabbed = accel ? grabKeys('undo', { [accel]: () => void requestUndo('key') }).includes(accel) : false;
  const hint = undoHint(grabbed ? hotkeyLabel(keys, process.platform) : '');
  if (reply !== null && overlay) sendToOverlay(overlay, IPC.overlayState, { phase: 'idle', reply, undo: { hint, ms: UNDO_OFFER_MS } } satisfies OverlayState);
  if (offerTimer) clearTimeout(offerTimer);
  offerTimer = setTimeout(() => {
    offerTimer = null;
    releaseKeys('undo'); // the chats window's button stays
  }, UNDO_OFFER_MS);
  log('undo', `offered for run ${runId}: ${rec.done.length} action(s)${grabbed ? ` (${accel})` : ''}`);
}

/** The chats window (re)loaded: show its undo button again. */
export function resendUndo(): void {
  if (last?.over) emit({ type: 'undo', chatId: last.chatId, turnId: last.turnId, available: true });
}

/** Is there something to undo in this chat (or anywhere)? */
export function undoAvailable(chatId?: string): boolean {
  return !!last?.over && (!chatId || last.chatId === chatId);
}

const describe = (a: ParsedAction): string => describeAction(a, 'past');

/** Ask for enter (yes) / esc (no) in the bubble. */
function confirmInBubble(overlay: BrowserWindow | null, plan: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (yes: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      releaseKeys('undo-confirm');
      resolve(yes);
    };
    const timer = setTimeout(() => finish(false), 30_000);
    grabKeys('undo-confirm', { Return: () => finish(true), Escape: () => finish(false) });
    sendToOverlay(overlay, IPC.overlayState, { phase: 'speaking', reply: 'undo what i just did?', confirm: plan } satisfies OverlayState);
  });
}

function show(overlay: BrowserWindow | null, state: OverlayState): void {
  sendToOverlay(overlay, IPC.overlayState, state);
}

/**
 * Undo the last agent run. `key`: the plan is shown first (enter / esc) so a stray "u" never
 * acts; a click on "undo" (bubble, chats window) is the yes.
 */
export async function requestUndo(source: 'key' | 'bubble' | 'chats', chatId?: string): Promise<UndoResult> {
  const rec = last;
  if (!rec?.over || (chatId && rec.chatId !== chatId)) return { ok: false, message: 'nothing to undo' };
  if (undoing) return { ok: false, message: 'already undoing' };
  if (busy()) return { ok: false, message: 'busy right now — stop it first, then undo' };
  undoing = true;
  if (offerTimer) clearTimeout(offerTimer);
  offerTimer = null;
  releaseKeys('undo');
  const overlay = rec.overlay ?? overlayForPoint(screen.getCursorScreenPoint());
  try {
    const app = await activeAppName().catch(() => '');
    const age = Date.now() - rec.at;
    const sameApp = rec.app && app ? rec.app === app : age < 60_000;
    const plan: UndoPlan = planUndo(rec.done, sameApp && age < LOCAL_MAX_AGE_MS);
    const summary = undoSummary(plan, describe);
    log('undo', `${source}: ${summary}${sameApp ? '' : ` (focused app changed: ${rec.app || '?'} → ${app || '?'})`}`);
    if (!plan.local.length && !plan.rest.length) return { ok: false, message: 'nothing to undo' };
    if (source === 'key' && !(await confirmInBubble(overlay, summary))) {
      show(overlay, { phase: 'idle', reply: 'kept it as it is.' });
      return { ok: false, message: 'kept it as it is' };
    }
    // used up: a second undo would reverse the reversal
    last = null;
    emit({ type: 'undo', chatId: rec.chatId, turnId: rec.turnId, available: false });
    if (plan.local.length) {
      show(overlay, { phase: 'acting', reply: 'undoing…', step: 'undo' });
      setAgentKeysSuspended(true); // our own backspaces must not reach the chord engine
      try {
        await performActions(plan.local);
      } finally {
        setAgentKeysSuspended(false);
      }
    }
    const did = plan.localNotes.length ? `undid it: ${plan.localNotes.join(', ')}` : '';
    if (!plan.rest.length) {
      show(overlay, { phase: 'idle', reply: `${did}.` });
      return { ok: true, message: did };
    }
    if (!runner) return { ok: !!did, message: did || "can't undo that here" };
    // the rest needs eyes: an agent turn with a fresh screenshot (ask / automatic confirm as usual)
    const user = `undo what you just did${plan.localNotes.length ? ' · the typed text is already deleted' : ''}`;
    void runner(rec.chatId, undoPrompt(plan, describe, process.platform), user).catch((err) => log('undo', 'undo turn failed:', err));
    return { ok: true, message: did ? `${did} · looking at the rest…` : 'looking at what i did…' };
  } catch (err) {
    log('undo', 'failed:', err);
    return { ok: false, message: `couldn't undo: ${err instanceof Error ? err.message.toLowerCase() : String(err)}` };
  } finally {
    undoing = false;
  }
}

/** Forget the journal (chat cleared, quit). */
export function clearUndo(): void {
  withdraw();
  last = null;
}

/** test hook: what is journaled */
export function undoState(): { chatId: string; turnId: string; actions: InputAction[]; over: boolean } | null {
  return last ? { chatId: last.chatId, turnId: last.turnId, actions: last.done.map((d) => d.input), over: last.over } : null;
}
