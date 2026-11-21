// Wake word ("hey clickity"), opt-in (settings › voice › wake word). The primary display's
// overlay keeps a low-power mic open with an energy voice-activity gate; only short voiced
// segments are transcribed, on this computer (on-device whisper), at a capped rate
// (src/shared/wake.ts WakeGate). When a segment starts with the wake word (or a clicky's name),
// the rest of it becomes a normal voice turn; a bare "hey clickity" opens a short follow-up
// window in which the next utterance is the question.
//
// This module is the arbiter, like hands-free.ts: it tells that overlay when it may listen —
// never while a turn records / thinks / speaks (plus an echo tail), while dictation holds the
// mic, or while hands-free is on (hands-free already hears everything).
import { BrowserWindow, ipcMain, screen } from 'electron';
import { IPC } from '../shared/ipc';
import type { HandsFreeUtterance, Settings, WakeHeard, WakeState, WakeStatus } from '../shared/types';
import { WAKE_FOLLOW_MS, matchWake, wakeTargets, type WakeTarget } from '../shared/wake';
import { getSettings, onSettingsChanged } from './settings-store';
import { broadcastToOverlays, getOverlays, overlayDisplay, sendToOverlay } from './overlay';
import { micHeld } from './hands-free';
import { microphoneStatus } from './permissions';
import { sendToSettings } from './settings-window';
import { switchClicky } from './clickys';
import { log } from './log';

const POLL_MS = 250;
/** after a reply ends, keep listening shut this long so our own voice isn't heard */
const ECHO_TAIL_MS = 900;
/** on-device model used for the check when speech-to-text isn't on-device anyway */
const CHECK_MODEL = 'Xenova/whisper-tiny.en';

type Activity = 'idle' | 'recording' | 'working';

let activity: () => Activity = () => 'idle';
let runTurn: (u: HandsFreeUtterance, win: BrowserWindow) => void = () => undefined;
let lastActivity: Activity = 'idle';
let tailUntil = 0;
let followUntil = 0;
let lastSent = '';
let lastOverlays = '';
let timer: NodeJS.Timeout | null = null;
let status: WakeStatus = { state: 'off' };

export function wakeOn(s: Settings = getSettings()): boolean {
  return !!s.wakeWord?.enabled && !s.handsFree?.enabled;
}

export function wakeStatus(): WakeStatus {
  const s = getSettings();
  if (!s.wakeWord?.enabled) return { state: 'off' };
  if (s.handsFree?.enabled) return { state: 'hands-free' };
  const mic = microphoneStatus();
  if (mic === 'denied' || mic === 'restricted') return { state: 'no-mic', detail: micBlockedText() };
  return status.state === 'off' || status.state === 'hands-free' ? { state: 'starting' } : status;
}

function micBlockedText(): string {
  if (process.platform === 'darwin') return 'microphone blocked — allow clickity in system settings › privacy & security › microphone';
  if (process.platform === 'win32') return 'microphone blocked — allow it in windows settings › privacy › microphone';
  return 'microphone blocked';
}

function owner(): BrowserWindow | null {
  const primary = screen.getPrimaryDisplay().id;
  const wins = getOverlays();
  return wins.find((w) => overlayDisplay(w)?.id === primary) ?? wins[0] ?? null;
}

function listeningNow(): boolean {
  const a = activity();
  if (a !== lastActivity) {
    if (a === 'idle' && lastActivity !== 'idle') tailUntil = Date.now() + ECHO_TAIL_MS;
    lastActivity = a;
  }
  return a === 'idle' && !micHeld() && Date.now() >= tailUntil;
}

function targets(s: Settings): WakeTarget[] {
  return wakeTargets(s.clickys);
}

function stateFor(win: BrowserWindow, mic: BrowserWindow | null, s: Settings): WakeState {
  const blocked = ['denied', 'restricted'].includes(microphoneStatus());
  const on = wakeOn(s) && !blocked;
  const stt = s.speech.stt;
  return {
    on,
    mic: on && win === mic,
    listening: on && win === mic && listeningNow(),
    sensitivity: s.wakeWord.sensitivity,
    targets: targets(s),
    model: stt.provider === 'on-device' && stt.model ? stt.model : CHECK_MODEL,
    followUp: Date.now() < followUntil,
    stt,
    // CLICKITY_TEST=1 only: the overlay logs what it heard (never in normal runs)
    debug: process.env.CLICKITY_TEST === '1' || undefined,
  };
}

function sync(): void {
  const s = getSettings();
  const mic = owner();
  const wins = getOverlays();
  const states = wins.map((w) => stateFor(w, mic, s));
  const key = JSON.stringify([wins.map((w) => w.id), states.map((st) => ({ ...st, stt: st.stt?.provider }))]);
  if (key === lastSent) return;
  lastSent = key;
  wins.forEach((w, i) => sendToOverlay(w, IPC.overlayWake, states[i]));
}

function setStatus(st: WakeStatus): void {
  const before = JSON.stringify(status);
  status = st;
  if (JSON.stringify(st) !== before) sendToSettings(IPC.wakeStatusChanged, wakeStatus());
}

/** The overlay heard its name (or the follow-up question). */
function onHeard(h: WakeHeard, win: BrowserWindow): void {
  const s = getSettings();
  if (!wakeOn(s) || !h) return;
  if (h.error) {
    log('wake', `heard ${Math.round(h.durationMs)}ms, error: ${h.error}`);
    return;
  }
  if (activity() !== 'idle') {
    log('wake', 'heard speech while busy: dropped');
    return;
  }
  if (h.kind === 'followup') {
    if (Date.now() > followUntil + 1500) return log('wake', 'follow-up came too late: dropped');
    followUntil = 0;
    log('wake', `follow-up question: ${Math.round(h.durationMs)}ms (${h.text !== undefined ? 'on-device text' : 'audio for speech-to-text'})`);
    broadcastToOverlays(IPC.overlayCue, null);
    runTurn({ text: h.text, wav: h.wav, durationMs: h.durationMs, peak: h.peak }, win);
    sync();
    return;
  }
  const m = matchWake(h.text ?? '', targets(s), s.wakeWord.sensitivity);
  if (!m) return log('wake', 'no wake word after all (main re-check)');
  // "hey study buddy": talk to that clicky (switches the active one live: voice, color, cursor)
  if (m.target.id && m.target.id !== s.activeClicky && switchClicky(m.target.id)) log('wake', `switched to ${m.target.id}`);
  log('wake', `wake word (score ${m.score}${m.greeted ? ', greeted' : ''}); ${m.rest ? `${m.rest.split(/\s+/).length} words after it` : 'waiting for the question'}`);
  if (m.rest) {
    runTurn({ text: m.rest, durationMs: h.durationMs, peak: h.peak }, win);
    return;
  }
  followUntil = Date.now() + WAKE_FOLLOW_MS;
  broadcastToOverlays(IPC.overlayCue, { text: "i'm listening", kind: 'listening', ttl: WAKE_FOLLOW_MS });
  sync();
}

export function initWakeWord(opts: {
  activity(): Activity;
  /** run a voice turn from this utterance (conversation.runUtterance) */
  onUtterance(u: HandsFreeUtterance, win: BrowserWindow): void;
}): void {
  activity = opts.activity;
  runTurn = opts.onUtterance;
  ipcMain.on(IPC.overlayReady, () => {
    lastSent = '';
    setTimeout(sync, 60);
  });
  ipcMain.on(IPC.wakeHeard, (e, h: WakeHeard) => {
    const win = getOverlays().find((w) => w.webContents.id === e.sender.id);
    if (win) onHeard(h, win);
  });
  ipcMain.on(IPC.wakeStatus, (_e, st: WakeStatus) => {
    if (!st || typeof st.state !== 'string') return;
    // once per state (download progress would otherwise log every percent)
    if (st.state !== status.state) log('wake', `status: ${st.state}${st.detail ? ` (${st.detail})` : ''}`);
    setStatus(st);
  });
  ipcMain.handle(IPC.wakeStatusGet, () => wakeStatus());
  onSettingsChanged((s, prev) => {
    const was = wakeOn(prev);
    const now = wakeOn(s);
    if (was !== now) {
      log('wake', now ? `on (${s.wakeWord.sensitivity})` : 'off');
      followUntil = 0;
      if (!now) status = { state: 'off' };
      broadcastToOverlays(IPC.overlayCue, { text: now ? 'say “hey clickity”' : 'wake word off', kind: 'info', ttl: 1800 });
      sendToSettings(IPC.wakeStatusChanged, wakeStatus());
    }
    sync();
  });
  timer = setInterval(() => {
    const ids = getOverlays().map((w) => w.id).join();
    if (ids !== lastOverlays) {
      lastOverlays = ids;
      lastSent = '';
    }
    if (followUntil && Date.now() > followUntil) {
      followUntil = 0;
      log('wake', 'no question after the wake word');
    }
    sync();
  }, POLL_MS);
  timer.unref?.();
}

export function stopWakeWord(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** CLICKITY_TEST=1: state for assertions */
export function wakeTestState(): { status: WakeStatus; followUp: boolean; listening: boolean } {
  return { status: wakeStatus(), followUp: Date.now() < followUntil, listening: wakeOn() && listeningNow() };
}
