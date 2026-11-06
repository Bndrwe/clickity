// The notch panel: a small frameless black pill pinned top-centre of the cursor's display (just
// under the menu bar / mac notch). Shows the active clicky, what it is doing and a compact
// "ask <name>…" box; hover or click expands it into the last few messages + quick actions.
// settings.companion.notch: 'off' (no window) · 'hover' (appears at the top edge) · 'always'.
import path from 'node:path';
import { BrowserWindow, ipcMain, screen, type Display, type Point } from 'electron';
import { IPC, type NotchSendRequest, type NotchState } from '../shared/ipc';
import type { OverlayState, Settings } from '../shared/types';
import { activeClicky } from '../shared/clickys';
import { getSettings, onSettingsChanged } from './settings-store';
import { getChat, onChatsChanged } from './chat-store';
import { getActiveChatId, newChat, pauseCurrent, resumeAgent, sendFromWindow, stopEverything } from './conversation';
import { currentBusy, onBusyChanged } from './busy';
import { stopHint } from './stop-logic';
import { onCursorMove, onOverlayState } from './overlay';
import { openChatsWindow } from './chats-window';
import { openSettingsWindow } from './settings-window';
import { hotkeyLabel } from './hotkey';
import { log } from './log';

export const NOTCH_COLLAPSED = { width: 420, height: 56 };
export const NOTCH_EXPANDED = { width: 420, height: 360 };
/** gap under the menu bar (mac) / the top of the work area */
const TOP_GAP = 6;
/** hover mode: how far below the top edge the cursor may be to summon it */
const HOVER_EDGE = 6;
/** hover mode: margin around the panel the cursor may wander before it hides */
const HOVER_KEEP = 28;
const HOVER_HIDE_MS = 700;
const MAX_TURNS = 6;

type Mode = NonNullable<Settings['companion']['notch']>;

let win: BrowserWindow | null = null;
let mode: Mode = 'off';
let expanded = false;
/** expanded by a click / typing: it has keyboard focus and stays until esc / a click outside */
let focused = false;
let displayId: number | null = null;
let phase: OverlayState['phase'] = 'idle';
let reply = '';
let transcript = '';
/** agent mode: actions waiting for enter (the notch has no bubble to show them in) */
let confirm = '';
let pushTimer: NodeJS.Timeout | null = null;
let hideTimer: NodeJS.Timeout | null = null;
let lastDisplayCheck = 0;
let initialized = false;

const alive = (): BrowserWindow | null => (win && !win.isDestroyed() ? win : null);

/* ───────────────────────── geometry ───────────────────────── */

function cursorDisplay(p: Point = screen.getCursorScreenPoint()): Display {
  return screen.getDisplayNearestPoint({ x: Math.round(p.x), y: Math.round(p.y) });
}

/** Top-centre of the display's work area (below the mac menu bar / notch; top of the screen elsewhere). */
export function notchBounds(display: Display, big: boolean): Electron.Rectangle {
  const size = big ? NOTCH_EXPANDED : NOTCH_COLLAPSED;
  const wa = display.workArea;
  // a full-screen app has no menu bar: workArea == bounds; keep clear of the camera notch anyway
  const top = process.platform === 'darwin' && wa.y === display.bounds.y ? display.bounds.y + 32 : wa.y;
  return { x: Math.round(wa.x + (wa.width - size.width) / 2), y: top + TOP_GAP, width: size.width, height: size.height };
}

function place(display?: Display): void {
  const w = alive();
  if (!w) return;
  const d = display ?? screen.getAllDisplays().find((x) => x.id === displayId) ?? cursorDisplay();
  displayId = d.id;
  w.setBounds(notchBounds(d, expanded));
}

/* ───────────────────────── window ───────────────────────── */

function createWindow(): BrowserWindow {
  const d = cursorDisplay();
  displayId = d.id;
  const w = new BrowserWindow({
    ...notchBounds(d, false),
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    // collapsed it never takes focus; a click / typing makes it focusable (setExpanded)
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    roundedCorners: false,
    // macOS: a non-activating panel floats over other apps' full-screen spaces and can take
    // the keyboard without activating clickity (same as the overlay's type box)
    ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
    title: 'clickity notch',
    webPreferences: {
      preload: path.join(__dirname, '../preload/notch.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  w.setAlwaysOnTop(true, 'screen-saver');
  w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  if (process.platform === 'darwin') w.setHiddenInMissionControl?.(true);
  w.webContents.on('will-navigate', (e) => e.preventDefault());
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.webContents.on('render-process-gone', (_e, details) => log('notch', 'renderer gone:', details));
  // clicked somewhere else: fold back into the pill
  w.on('blur', () => {
    if (focused) sendCollapse();
  });
  w.on('closed', () => {
    if (win === w) win = null;
  });
  w.once('ready-to-show', () => {
    if (mode === 'always') showPanel();
  });
  void w.loadFile(path.join(__dirname, '../renderer/notch/notch.html'));
  return w;
}

function showPanel(): void {
  const w = alive();
  if (!w) return;
  if (!w.isVisible()) {
    place(cursorDisplay());
    w.showInactive();
  }
  w.setAlwaysOnTop(true, 'screen-saver');
  w.moveTop(); // above the overlays (same level)
}

function hidePanel(): void {
  const w = alive();
  if (!w || !w.isVisible()) return;
  if (expanded) setExpanded(false, false);
  w.hide();
}

function sendCollapse(): void {
  const w = alive();
  if (w) w.webContents.send(IPC.notchCollapse);
}

/** Grow / shrink the window; `focus` = it needs the keyboard (typing, after a click). */
function setExpanded(next: boolean, focus: boolean): void {
  const w = alive();
  if (!w) return;
  const wasFocused = focused;
  expanded = next;
  focused = next && (focus || focused);
  place();
  if (focused && !wasFocused) {
    w.setFocusable(true);
    w.focus();
    w.webContents.focus();
  } else if (!focused && wasFocused) {
    if (w.isFocused()) w.blur();
    w.setFocusable(false);
    w.setAlwaysOnTop(true, 'screen-saver'); // toggling focusability can drop the level
  }
  pushState(true);
}

function applyMode(next: Mode): void {
  if (next === mode && (next === 'off' || alive())) return;
  mode = next;
  log('notch', `mode ${mode}`);
  if (mode === 'off') {
    const w = alive();
    win = null;
    expanded = focused = false;
    if (w) w.destroy();
    return;
  }
  if (!alive()) win = createWindow();
  if (mode === 'always') showPanel();
  else hidePanel();
}

/* ───────────────────────── state ───────────────────────── */

function buildState(): NotchState {
  const s = getSettings();
  const c = activeClicky(s);
  const chatId = getActiveChatId();
  const chat = chatId ? getChat(chatId) : null;
  const turns = (chat?.turns ?? [])
    .filter((t) => t.text.trim() || t.error)
    .slice(-MAX_TURNS)
    .map((t) => ({ id: t.id, role: t.role, text: t.text, error: t.error }));
  const busy = phase !== 'idle';
  const firstLine = (reply || '').split(/(?<=[.!?])\s|\n/)[0]?.trim() ?? '';
  return {
    clicky: { id: c.id, name: c.name, color: c.color },
    clickys: s.clickys.map((x) => ({ id: x.id, name: x.name, color: x.color })),
    phase,
    line: currentBusy()?.mode === 'paused' ? stopHint('paused', hotkeyLabel(s.hotkeys.stop ?? ['Escape'], process.platform)) : confirm ? `${confirm} · enter to allow` : busy ? (phase === 'speaking' ? firstLine : phase === 'thinking' ? transcript : phase === 'error' ? reply : undefined) : undefined,
    expanded,
    turns: busy && reply && phase === 'speaking' && turns[turns.length - 1]?.role !== 'assistant' ? [...turns, { id: 'live', role: 'assistant', text: reply }] : turns,
    chatId,
    theme: 'dark',
    hotkeyLabel: hotkeyLabel(s.hotkeys.talk, process.platform),
    busy: currentBusy()?.mode ?? null,
    stopLabel: hotkeyLabel(s.hotkeys.stop ?? ['Escape'], process.platform),
  };
}

/** Send the state now (force) or within ~40ms (coalesced). */
function pushState(force = false): void {
  const w = alive();
  if (!w) return;
  const send = () => {
    pushTimer = null;
    const ww = alive();
    if (ww && !ww.webContents.isDestroyed()) ww.webContents.send(IPC.notchState, buildState());
  };
  if (force) {
    if (pushTimer) clearTimeout(pushTimer);
    send();
  } else if (!pushTimer) pushTimer = setTimeout(send, 40);
}

function onState(st: OverlayState): void {
  phase = st.phase;
  if (st.phase === 'idle' || st.phase === 'listening') reply = transcript = '';
  if (st.reply !== undefined) reply = st.reply;
  if (st.transcript !== undefined) transcript = st.transcript;
  if (st.phase === 'error') reply = st.error ?? '';
  confirm = st.confirm ?? '';
  pushState();
}

/* ───────────────────────── cursor: follow display, hover mode ───────────────────────── */

function inside(p: Point, r: Electron.Rectangle, margin: number): boolean {
  return p.x >= r.x - margin && p.x <= r.x + r.width + margin && p.y >= r.y - margin && p.y <= r.y + r.height + margin;
}

function onCursor(p: Point, t: number): void {
  const w = alive();
  if (!w || mode === 'off') return;
  if (mode === 'always') {
    // follow the cursor to another display (not while it is open / being typed in)
    if (expanded || t - lastDisplayCheck < 250) return;
    lastDisplayCheck = t;
    const d = cursorDisplay(p);
    if (d.id !== displayId) place(d);
    return;
  }
  // hover: the cursor touching the top edge near the middle summons it
  const d = cursorDisplay(p);
  const zone = notchBounds(d, false);
  const atEdge = p.y <= Math.max(d.workArea.y, d.bounds.y) + HOVER_EDGE && p.x >= zone.x - 40 && p.x <= zone.x + zone.width + 40;
  if (!w.isVisible()) {
    if (atEdge) {
      displayId = d.id;
      showPanel();
    }
    return;
  }
  if (focused || inside(p, w.getBounds(), HOVER_KEEP) || atEdge) {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = null;
    return;
  }
  if (!hideTimer) {
    hideTimer = setTimeout(() => {
      hideTimer = null;
      const ww = alive();
      if (ww && mode === 'hover' && !focused && !inside(screen.getCursorScreenPoint(), ww.getBounds(), HOVER_KEEP)) hidePanel();
    }, HOVER_HIDE_MS);
  }
}

/* ───────────────────────── init ───────────────────────── */

export function initNotch(): void {
  if (initialized) return;
  initialized = true;

  ipcMain.on(IPC.notchReady, () => pushState(true));
  ipcMain.on(IPC.notchExpand, (_e, arg: { expanded?: unknown; focus?: unknown } | undefined) => setExpanded(arg?.expanded === true, arg?.focus === true));
  ipcMain.handle(IPC.notchSend, async (_e, req: NotchSendRequest) => {
    const res = await sendFromWindow({
      chatId: getActiveChatId(),
      text: String(req?.text ?? ''),
      includeScreen: req?.includeScreen === true,
      attachments: Array.isArray(req?.attachments) ? req.attachments : undefined,
      noBubble: true, // the panel shows the reply
    });
    pushState(true);
    return res;
  });
  ipcMain.on(IPC.notchAction, (_e, a: unknown) => {
    if (a === 'new-chat') {
      newChat();
      pushState(true);
    } else if (a === 'open-chats') {
      sendCollapse();
      openChatsWindow();
    } else if (a === 'open-settings') {
      sendCollapse();
      openSettingsWindow('clickys');
    } else if (a === 'stop') {
      stopEverything('notch');
    } else if (a === 'pause') {
      pauseCurrent();
    } else if (a === 'continue') {
      resumeAgent();
    }
  });

  onOverlayState(onState);
  onBusyChanged(() => pushState());
  onChatsChanged(() => pushState());
  onCursorMove(onCursor);
  onSettingsChanged((s, prev) => {
    if (s.companion.notch !== prev.companion.notch) applyMode(s.companion.notch ?? 'off');
    if (s.activeClicky !== prev.activeClicky || JSON.stringify(s.clickys) !== JSON.stringify(prev.clickys) || s.hotkeys.talk.join() !== prev.hotkeys.talk.join()) pushState(true);
  });
  const reposition = () => {
    if (alive()) place(screen.getAllDisplays().find((d) => d.id === displayId) ?? cursorDisplay());
  };
  screen.on('display-added', reposition);
  screen.on('display-removed', reposition);
  screen.on('display-metrics-changed', reposition);

  applyMode(getSettings().companion.notch ?? 'off');
}

/** The panel window, if it exists (tests). */
export function getNotchWindow(): BrowserWindow | null {
  return alive();
}
