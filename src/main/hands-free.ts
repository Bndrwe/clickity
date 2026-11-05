// Hands-free (always listening) mode. The overlay on the primary display owns a continuous mic
// with an energy voice-activity detector (src/shared/vad.ts); each utterance it hears becomes a
// normal voice turn. This module is the mic arbiter: it tells that overlay when it may listen —
// never while push-to-talk / dictation record, never while the companion thinks or speaks (plus
// a short echo tail), except that with headphones speech during a reply interrupts it (barge-in).
import { BrowserWindow, ipcMain, screen } from 'electron';
import { IPC } from '../shared/ipc';
import type { HandsFreeState, HandsFreeUtterance, Settings } from '../shared/types';
import { getSettings, onSettingsChanged, updateSettings } from './settings-store';
import { broadcastToOverlays, getOverlays, overlayDisplay, sendToOverlay } from './overlay';
import { log } from './log';

/** after a reply ends, keep the mic shut this long so the tail of our own voice isn't heard */
const ECHO_TAIL_MS = 800;
const POLL_MS = 200;

type Activity = 'idle' | 'recording' | 'working';

let activity: () => Activity = () => 'idle';
let onUtterance: (u: HandsFreeUtterance, win: BrowserWindow) => void = () => undefined;
let bargeIn: () => void = () => undefined;
const holds = new Map<number, string>();
let holdSeq = 0;
let tailUntil = 0;
let lastActivity: Activity = 'idle';
let lastSent = '';
let timer: NodeJS.Timeout | null = null;
let barged = 0;

/** Pause hands-free listening while something else uses the mic; call the returned function to release. */
export function holdHandsFree(reason: string): () => void {
  const id = ++holdSeq;
  holds.set(id, reason);
  sync();
  return () => {
    if (holds.delete(id)) {
      tailUntil = Math.max(tailUntil, Date.now() + 300);
      sync();
    }
  };
}

export function handsFreeOn(settings: Settings = getSettings()): boolean {
  return !!settings.handsFree?.enabled;
}

/** Triple-tap control / settings switch. */
export function toggleHandsFree(): void {
  const on = !handsFreeOn();
  log('hands-free', on ? 'on' : 'off');
  updateSettings({ handsFree: { enabled: on } });
}

function owner(): BrowserWindow | null {
  const primary = screen.getPrimaryDisplay().id;
  const wins = getOverlays();
  return wins.find((w) => overlayDisplay(w)?.id === primary) ?? wins[0] ?? null;
}

function listeningNow(): boolean {
  if (!handsFreeOn() || holds.size) return false;
  const a = activity();
  if (a !== lastActivity) {
    if (lastActivity === 'working' && a === 'idle') tailUntil = Date.now() + ECHO_TAIL_MS;
    lastActivity = a;
  }
  return a === 'idle' && Date.now() >= tailUntil;
}

function sync(): void {
  const on = handsFreeOn();
  const mic = owner();
  const listening = listeningNow();
  // with headphones the renderer keeps listening while we reply, so speaking interrupts us
  const replying = on && !holds.size && activity() === 'working';
  const key = `${on}|${mic?.id}|${listening}|${replying}`;
  if (key === lastSent) return;
  lastSent = key;
  for (const w of getOverlays()) {
    const st: HandsFreeState = { on, mic: w === mic, listening: listening && w === mic, bargeIn: replying && w === mic };
    sendToOverlay(w, IPC.overlayHandsFree, st);
  }
}

export function initHandsFree(opts: {
  activity(): Activity;
  /** run a voice turn from this utterance */
  onUtterance(u: HandsFreeUtterance, win: BrowserWindow): void;
  /** the user started talking over a reply (headphones): stop it */
  onBargeIn(): void;
}): void {
  activity = opts.activity;
  onUtterance = opts.onUtterance;
  bargeIn = opts.onBargeIn;
  // an overlay (re)loaded: it missed earlier state, send it again
  ipcMain.on(IPC.overlayReady, () => {
    lastSent = '';
    setTimeout(sync, 50);
  });
  ipcMain.on(IPC.handsFreeSpeech, () => {
    if (!handsFreeOn() || holds.size) return;
    if (activity() === 'working') {
      log('hands-free', 'barge-in: stopping the reply');
      barged = Date.now();
      bargeIn();
    }
  });
  ipcMain.on(IPC.handsFreeUtterance, (e, u: HandsFreeUtterance) => {
    const win = getOverlays().find((w) => w.webContents.id === e.sender.id);
    if (!win || !u || !handsFreeOn()) return;
    const recentBarge = Date.now() - barged < 30_000;
    if (!listeningNow() && !recentBarge) {
      log('hands-free', 'dropped an utterance heard while busy');
      return;
    }
    barged = 0;
    log('hands-free', `utterance: ${Math.round(u.durationMs)}ms${u.error ? `, error: ${u.error}` : ''}`);
    onUtterance(u, win);
  });
  onSettingsChanged((s, prev) => {
    if (!!s.handsFree?.enabled !== !!prev.handsFree?.enabled) {
      lastSent = '';
      if (s.handsFree?.enabled) broadcastToOverlays(IPC.overlayCue, { text: 'hands-free on', kind: 'info', ttl: 1600 });
      else broadcastToOverlays(IPC.overlayCue, { text: 'hands-free off', kind: 'info', ttl: 1600 });
    }
    sync();
  });
  // overlays come and go with displays; re-send state to new ones
  timer = setInterval(() => {
    if (getOverlays().map((w) => w.id).join() !== lastOverlays) {
      lastOverlays = getOverlays().map((w) => w.id).join();
      lastSent = '';
    }
    sync();
  }, POLL_MS);
  timer.unref?.();
}
let lastOverlays = '';

export function stopHandsFree(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
