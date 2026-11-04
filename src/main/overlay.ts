// Overlay windows: one transparent, click-through, always-on-top window per display.
// Also polls the global cursor position and fans it out to every overlay.
import path from 'node:path';
import { BrowserWindow, ipcMain, screen, type Display, type Point } from 'electron';
import { IPC } from '../shared/ipc';
import type { OverlayConfig } from '../shared/types';
import { getSettings } from './settings-store';
import { hotkeyLabel } from './hotkey';
import { log } from './log';

const CURSOR_POLL_MS = 16;
const REBUILD_DEBOUNCE_MS = 250;

/** displayId → overlay window */
const overlays = new Map<number, BrowserWindow>();
/** overlay webContents id → display it covers */
const displayOf = new Map<number, Display>();

let cursorTimer: NodeJS.Timeout | null = null;
let rebuildTimer: NodeJS.Timeout | null = null;
let lastCursor: Point = { x: Number.NaN, y: Number.NaN };
let visible = true;
let initialized = false;

/* ───────────────────────── window creation ───────────────────────── */

function createOverlay(display: Display): BrowserWindow {
  const { x, y, width, height } = display.bounds;
  const win = new BrowserWindow({
    x,
    y,
    width,
    height,
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
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    enableLargerThanScreen: true,
    roundedCorners: false,
    // macOS: a non-activating panel is the only way to float over *other apps'* fullscreen
    // spaces without hiding the dock icon (setVisibleOnAllWorkspaces' visibleOnFullScreen
    // needs dock.hide() unless skipTransformProcessType, which we pass to keep the dock icon).
    // It also lets the type box take keyboard focus without activating clickity, which
    // macOS 14+ refuses for a background app (cooperative activation).
    ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
    title: 'clickity overlay',
    webPreferences: {
      preload: path.join(__dirname, '../preload/overlay.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      // TTS audio starts without a user gesture (the hotkey happens outside the page).
      autoplayPolicy: 'no-user-gesture-required',
      spellcheck: false,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(true, { forward: true });
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  if (process.platform === 'darwin') win.setHiddenInMissionControl?.(true);
  // Some window managers ignore the constructor bounds for frameless windows.
  win.setBounds(display.bounds);

  const wcId = win.webContents.id;
  displayOf.set(wcId, display);
  win.on('closed', () => displayOf.delete(wcId));

  // Never let the overlay navigate or open windows.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // Diagnostics: overlay errors (mic, whisper, speech) land in clickity.log.
  win.webContents.on('console-message', (...args: unknown[]) => {
    const ev = args[0] as { level?: unknown; message?: string; sourceId?: string; lineNumber?: number };
    // electron ≥ 35 passes one event object; older versions pass (event, level, message, line, sourceId)
    const level = typeof ev?.level === 'string' ? ev.level : args[1] === 3 ? 'error' : args[1] === 2 ? 'warning' : 'info';
    const message = typeof ev?.message === 'string' ? ev.message : String(args[2] ?? '');
    if (level === 'error' || level === 'warning') log(`overlay ${display.id}`, `console.${level}:`, message.slice(0, 600));
  });
  win.webContents.on('render-process-gone', (_e, details) => log(`overlay ${display.id}`, 'renderer gone:', details));
  win.webContents.on('did-fail-load', (_e, code, desc, url) => log(`overlay ${display.id}`, 'failed to load', code, desc, url));

  win.once('ready-to-show', () => {
    if (visible && !win.isDestroyed()) win.showInactive();
  });
  void win.loadFile(path.join(__dirname, '../renderer/overlay/overlay.html'));
  return win;
}

/** Make the set of overlays match the current displays (create / move / destroy). */
function reconcileOverlays(): void {
  const displays = screen.getAllDisplays();
  const ids = new Set(displays.map((d) => d.id));

  for (const [id, win] of overlays) {
    if (!ids.has(id)) {
      overlays.delete(id);
      if (!win.isDestroyed()) win.destroy();
    }
  }

  for (const display of displays) {
    const existing = overlays.get(display.id);
    if (existing && !existing.isDestroyed()) {
      displayOf.set(existing.webContents.id, display);
      const b = existing.getBounds();
      const d = display.bounds;
      if (b.x !== d.x || b.y !== d.y || b.width !== d.width || b.height !== d.height) existing.setBounds(d);
      sendOverlayConfig(existing);
    } else {
      overlays.set(display.id, createOverlay(display));
    }
  }
}

function scheduleRebuild(): void {
  if (rebuildTimer) clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => {
    rebuildTimer = null;
    reconcileOverlays();
  }, REBUILD_DEBOUNCE_MS);
}

/* ───────────────────────── cursor polling ───────────────────────── */

function pollCursor(): void {
  const p = screen.getCursorScreenPoint();
  if (p.x === lastCursor.x && p.y === lastCursor.y) return;
  lastCursor = p;
  broadcastToOverlays(IPC.overlayCursor, { x: p.x, y: p.y });
}

/* ───────────────────────── public API ───────────────────────── */

/** Create overlays for every display, start cursor polling and listen for display changes. Call once after app ready. */
export function initOverlays(): void {
  if (initialized) return;
  initialized = true;

  ipcMain.on(IPC.overlayLog, (e, entry: { level?: string; message?: string } | undefined) => {
    const msg = String(entry?.message ?? '').slice(0, 1000);
    if (msg) log(`overlay ${displayOf.get(e.sender.id)?.id ?? '?'}`, entry?.level === 'info' ? '' : `${entry?.level}:`, msg);
  });

  ipcMain.on(IPC.overlaySetInteractive, (e, on: unknown) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (win && isOverlay(win)) setOverlayInteractive(win, on === true);
  });

  ipcMain.on(IPC.overlayReady, (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win || !isOverlay(win)) return;
    sendOverlayConfig(win);
    const p = screen.getCursorScreenPoint();
    sendToOverlay(win, IPC.overlayCursor, { x: p.x, y: p.y });
  });

  screen.on('display-added', scheduleRebuild);
  screen.on('display-removed', scheduleRebuild);
  screen.on('display-metrics-changed', scheduleRebuild);

  reconcileOverlays();
  cursorTimer = setInterval(pollCursor, CURSOR_POLL_MS);
}

/** Tear down everything (app quit). */
export function destroyOverlays(): void {
  if (cursorTimer) clearInterval(cursorTimer);
  if (rebuildTimer) clearTimeout(rebuildTimer);
  cursorTimer = rebuildTimer = null;
  for (const win of overlays.values()) if (!win.isDestroyed()) win.destroy();
  overlays.clear();
}

export function getOverlays(): BrowserWindow[] {
  return [...overlays.values()].filter((w) => !w.isDestroyed());
}

export function isOverlay(win: BrowserWindow): boolean {
  return getOverlays().includes(win);
}

/** The display an overlay covers (global DIP bounds). */
export function overlayDisplay(win: BrowserWindow): Display | undefined {
  if (win.isDestroyed()) return undefined;
  return displayOf.get(win.webContents.id);
}

/** Overlay covering the display with the given id. */
export function overlayForDisplay(displayId: number): BrowserWindow | null {
  const win = overlays.get(displayId);
  return win && !win.isDestroyed() ? win : null;
}

/** Overlay covering the display nearest to a global DIP point. */
export function overlayForPoint(p: Point): BrowserWindow | null {
  const display = screen.getDisplayNearestPoint({ x: Math.round(p.x), y: Math.round(p.y) });
  return overlayForDisplay(display.id) ?? getOverlays()[0] ?? null;
}

/** Overlay whose webContents has the given id (to match IPC senders). */
export function overlayForWebContentsId(id: number): BrowserWindow | null {
  return getOverlays().find((w) => w.webContents.id === id) ?? null;
}

export function sendToOverlay(win: BrowserWindow | null | undefined, channel: string, payload?: unknown): void {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
  win.webContents.send(channel, payload);
}

export function broadcastToOverlays(channel: string, payload?: unknown): void {
  for (const win of getOverlays()) sendToOverlay(win, channel, payload);
}

function buildConfig(win: BrowserWindow): OverlayConfig | null {
  const display = overlayDisplay(win);
  if (!display) return null;
  const s = getSettings();
  return {
    companion: s.companion,
    theme: s.theme,
    displayBounds: { ...display.bounds },
    hotkeyLabel: hotkeyLabel(s.hotkeys.talk, process.platform),
    stt: s.speech.stt,
    // one overlay warms up the on-device model (they share the browser cache)
    preloadStt: display.id === screen.getPrimaryDisplay().id,
  };
}

export function sendOverlayConfig(win: BrowserWindow): void {
  const cfg = buildConfig(win);
  if (cfg) sendToOverlay(win, IPC.overlayConfig, cfg);
}

/** Re-send config to every overlay (call on settings change). */
export function refreshOverlayConfigs(): void {
  for (const win of getOverlays()) sendOverlayConfig(win);
}

/**
 * Temporarily make an overlay interactive for the type box (focusable, receives clicks),
 * or restore it to a passive click-through layer.
 */
const typingWins = new WeakSet<BrowserWindow>();

/**
 * While the pointer is over the reply bubble, let the overlay take mouse clicks so the
 * bubble can be dragged; otherwise stay click-through. (No-op while the type box is open:
 * the window is already interactive then.)
 */
export function setOverlayInteractive(win: BrowserWindow | null | undefined, on: boolean): void {
  if (!win || win.isDestroyed() || typingWins.has(win)) return;
  win.setIgnoreMouseEvents(!on, { forward: true });
}

export function setOverlayTyping(win: BrowserWindow | null | undefined, typing: boolean): void {
  if (!win || win.isDestroyed()) return;
  if (typing) typingWins.add(win);
  else typingWins.delete(win);
  if (typing) {
    win.setFocusable(true);
    win.setIgnoreMouseEvents(false);
    if (!win.isVisible()) win.showInactive();
    win.focus();
    win.webContents.focus();
  } else {
    win.setIgnoreMouseEvents(true, { forward: true });
    if (win.isFocused()) win.blur();
    win.setFocusable(false);
    // Re-assert stacking; toggling focusability can drop the level on some platforms.
    win.setAlwaysOnTop(true, 'screen-saver');
  }
}

/** Show or hide all overlays (pause companion). */
export function setOverlaysVisible(show: boolean): void {
  visible = show;
  for (const win of getOverlays()) {
    if (show) win.showInactive();
    else win.hide();
  }
}

export function overlaysVisible(): boolean {
  return visible;
}
