// The settings / onboarding window. A single instance, opened or focused on demand.
import path from 'node:path';
import { app, BrowserWindow, nativeTheme, shell } from 'electron';
import type { Theme } from '../shared/types';
import { getSettings } from './settings-store';

const isMac = process.platform === 'darwin';
let win: BrowserWindow | null = null;

/** Opal `--bg` for the effective theme, so the window never flashes the wrong color. */
export function themeBackground(theme: Theme): string {
  const dark = theme === 'dark' || (theme === 'system' && nativeTheme.shouldUseDarkColors);
  return dark ? '#0b0b0b' : '#fafafa';
}

function isSafeExternal(url: string): boolean {
  return /^(https?:|mailto:|x-apple\.systempreferences:)/i.test(url);
}

export function getSettingsWindow(): BrowserWindow | null {
  return win && !win.isDestroyed() ? win : null;
}

export function openSettingsWindow(): BrowserWindow {
  const existing = getSettingsWindow();
  if (existing) {
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
    if (isMac) app.focus({ steal: true });
    return existing;
  }

  const settings = getSettings();
  nativeTheme.themeSource = settings.theme;

  win = new BrowserWindow({
    width: 880,
    height: 720,
    minWidth: 560,
    minHeight: 560,
    show: false,
    title: 'clicky',
    backgroundColor: themeBackground(settings.theme),
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: isMac ? { x: 18, y: 18 } : undefined,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/settings.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
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
    // With the dock hidden we're an accessory app; show the dock icon while settings
    // are open so the window behaves normally (cmd-tab, app menu).
    if (isMac) void app.dock?.show();
    w.show();
    w.focus();
    if (isMac) app.focus({ steal: true });
  });
  w.on('closed', () => {
    win = null;
    if (isMac) app.dock?.hide();
  });

  void w.loadFile(path.join(__dirname, '../renderer/settings/settings.html'));
  return w;
}

/** Send a message to the settings window if it is open. */
export function sendToSettings(channel: string, payload?: unknown): void {
  const w = getSettingsWindow();
  if (w && !w.webContents.isDestroyed()) w.webContents.send(channel, payload);
}

/** Keep native chrome + background in sync with the theme setting. */
export function applySettingsTheme(theme: Theme): void {
  nativeTheme.themeSource = theme;
  getSettingsWindow()?.setBackgroundColor(themeBackground(theme));
}
