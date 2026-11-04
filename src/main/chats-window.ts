// The chats window: stored conversations + a composer. Single instance, always dark.
import path from 'node:path';
import { app, BrowserWindow, shell } from 'electron';

const isMac = process.platform === 'darwin';
let win: BrowserWindow | null = null;

function isSafeExternal(url: string): boolean {
  return /^(https?:|mailto:|x-apple\.systempreferences:)/i.test(url);
}

export function getChatsWindow(): BrowserWindow | null {
  return win && !win.isDestroyed() ? win : null;
}

export function openChatsWindow(): BrowserWindow {
  const existing = getChatsWindow();
  if (existing) {
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
    if (isMac) app.focus({ steal: true });
    return existing;
  }

  win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 720,
    minHeight: 520,
    show: false,
    title: 'clickity chats',
    backgroundColor: '#0a0a0b',
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: isMac ? { x: 18, y: 18 } : undefined,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/chats.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: true,
    },
  });
  const w = win;

  // External links open in the user's browser; the window itself never navigates away.
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternal(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  w.webContents.on('will-navigate', (e, url) => {
    if (url === w.webContents.getURL()) return;
    e.preventDefault();
    if (isSafeExternal(url)) void shell.openExternal(url);
  });

  w.once('ready-to-show', () => {
    w.show();
    w.focus();
    if (isMac) app.focus({ steal: true });
  });
  w.on('closed', () => {
    win = null;
  });

  void w.loadFile(path.join(__dirname, '../renderer/chats/chats.html'));
  return w;
}

/** Send a message to the chats window if it is open. */
export function sendToChats(channel: string, payload?: unknown): void {
  const w = getChatsWindow();
  if (w && !w.webContents.isDestroyed()) w.webContents.send(channel, payload);
}
