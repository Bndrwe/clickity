// App bootstrap: single instance, settings, overlays, hotkeys, tray, settings window and IPC.
import { app, ipcMain, shell } from 'electron';
import { IPC } from '../shared/ipc';
import { PROVIDER_KINDS, type ChatSendRequest, type DeepPartial, type PermissionKind, type ProviderKind, type Settings } from '../shared/types';
import { getSettings, loadSettings, onSettingsChanged, resetSettings, updateSettings } from './settings-store';
import { getProvider, openLogin, testProvider } from './providers/index';
import { startHotkeys, stopHotkeys, suspendHotkeys, updateHotkeys } from './hotkey';
import { notifyHotkeyHeard, registerHotkeyIpc } from './hotkey-ipc';
import { cleanupCaptures } from './capture';
import { destroyOverlays, initOverlays, refreshOverlayConfigs, setOverlaysVisible } from './overlay';
import {
  clearHistory,
  getActiveChatId,
  initConversation,
  newChat,
  onEscape,
  onTalkDown,
  onTalkUp,
  onType,
  openChat,
  removeChat,
  sendFromWindow,
  shutdownConversation,
  stopChat,
  testSpeak,
} from './conversation';
import { getChat, listChats, onChatsChanged, renameChat } from './chat-store';
import { openChatsWindow, sendToChats } from './chats-window';
import { getPermissions, installPermissionHandlers, requestPermission, resetPermissions } from './permissions';
import { createTray, destroyTray, refreshTray } from './tray';
import { installAppMenu, launchedAtLogin } from './app-menu';
import { applySettingsTheme, openSettingsWindow, sendToSettings } from './settings-window';
import { log, logPath, logStartup } from './log';
import { installTestHook } from './test-hook';

const isMac = process.platform === 'darwin';

/* ───────────────────────── single instance ───────────────────────── */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => openMainWindow());
  void bootstrap();
}

/* ───────────────────────── pause / hotkey suspension ───────────────────────── */

let paused = false;
let suspendedBySettings = false;

function syncHotkeySuspension(): void {
  suspendHotkeys(paused || suspendedBySettings);
}

const appMenuActions = {
  openSettings: () => void openSettingsWindow(),
  openChats: () => void openChatsWindow(),
  isPaused: () => paused,
  setPaused: (p: boolean) => setPaused(p),
  clearConversation: () => clearHistory(),
};

function setPaused(next: boolean): void {
  if (paused === next) return;
  paused = next;
  if (paused) shutdownConversation();
  setOverlaysVisible(!paused);
  syncHotkeySuspension();
  refreshTray();
  installAppMenu(appMenuActions); // keep the menu's pause checkbox in sync
}

/* ───────────────────────── settings side effects ───────────────────────── */

function applyLaunchAtLogin(enabled: boolean): void {
  // In dev this would register the bare electron binary, which can't start the app.
  if (!app.isPackaged) return;
  try {
    // --hidden: start quietly in the menu bar / tray when the OS launches us at login.
    app.setLoginItemSettings({ openAtLogin: enabled, args: ['--hidden'] });
  } catch (err) {
    console.warn('[main] setLoginItemSettings failed:', err);
  }
}

function handleSettingsChanged(s: Settings, prev: Settings): void {
  sendToSettings(IPC.settingsChanged, s);
  sendToChats(IPC.settingsChanged, s);
  refreshOverlayConfigs();
  refreshTray();
  if (JSON.stringify(s.hotkeys) !== JSON.stringify(prev.hotkeys)) {
    updateHotkeys(s.hotkeys);
    syncHotkeySuspension();
  }
  if (s.theme !== prev.theme) applySettingsTheme(s.theme);
  if (s.launchAtLogin !== prev.launchAtLogin) applyLaunchAtLogin(s.launchAtLogin);
  // finishing onboarding takes you to the main window
  if (!prev.onboarded && s.onboarded) openChatsWindow();
}

/** The window to show when the app icon is clicked: chats once set up, settings before. */
function openMainWindow(): void {
  if (getSettings().onboarded) openChatsWindow();
  else openSettingsWindow();
}

/* ───────────────────────── IPC ───────────────────────── */

function assertKind(kind: unknown): ProviderKind {
  if (typeof kind !== 'string' || !PROVIDER_KINDS.includes(kind as ProviderKind)) {
    throw new Error(`unknown provider: ${String(kind)}`);
  }
  return kind as ProviderKind;
}

function assertPermission(kind: unknown): PermissionKind {
  if (kind !== 'microphone' && kind !== 'screen' && kind !== 'accessibility') {
    throw new Error(`unknown permission: ${String(kind)}`);
  }
  return kind;
}

function assertId(id: unknown): string {
  if (typeof id !== 'string' || !id) throw new Error('missing chat id');
  return id;
}

function shortError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.split('\n')[0].toLowerCase();
}

function registerIpc(): void {
  ipcMain.handle(IPC.settingsGet, () => getSettings());
  ipcMain.handle(IPC.settingsSet, (_e, patch: DeepPartial<Settings>) => updateSettings(patch ?? {}));
  ipcMain.handle(IPC.settingsReset, () => resetSettings());

  ipcMain.handle(IPC.providersStatus, async (_e, k: unknown) => {
    const kind = assertKind(k);
    try {
      return await getProvider(kind).status(getSettings().providers[kind] ?? {});
    } catch (err) {
      return { ok: false, detail: shortError(err) };
    }
  });
  ipcMain.handle(IPC.providersModels, async (_e, k: unknown) => {
    const kind = assertKind(k);
    return getProvider(kind).listModels(getSettings().providers[kind] ?? {});
  });
  ipcMain.handle(IPC.providersTest, async (_e, k: unknown) => {
    const kind = assertKind(k);
    const s = getSettings();
    try {
      return await testProvider(kind, s.providers[kind] ?? {}, s.models[kind]);
    } catch (err) {
      return { ok: false, message: shortError(err) };
    }
  });
  ipcMain.handle(IPC.providersLogin, async (_e, k: unknown) => {
    const kind = assertKind(k);
    await openLogin(kind, getSettings().providers[kind] ?? {});
  });

  ipcMain.handle(IPC.hotkeySuspend, (_e, suspended: unknown) => {
    suspendedBySettings = !!suspended;
    syncHotkeySuspension();
  });

  registerHotkeyIpc();

  ipcMain.handle(IPC.permissionsGet, () => getPermissions());
  ipcMain.handle(IPC.permissionsRequest, (_e, kind: unknown) => requestPermission(assertPermission(kind)));
  ipcMain.handle(IPC.permissionsReset, () => resetPermissions());

  ipcMain.handle(IPC.historyClear, () => clearHistory());
  ipcMain.handle(IPC.openExternal, async (_e, url: unknown) => {
    if (typeof url !== 'string' || !/^(https?:|mailto:|x-apple\.systempreferences:)/i.test(url)) {
      throw new Error('refusing to open that url');
    }
    await shell.openExternal(url);
  });
  ipcMain.handle(IPC.appInfo, () => ({ version: app.getVersion(), platform: process.platform, packaged: app.isPackaged }));
  ipcMain.handle(IPC.appRelaunch, () => {
    app.relaunch();
    app.exit(0);
  });
  ipcMain.handle(IPC.testSpeak, () => testSpeak());
  ipcMain.handle(IPC.appQuit, () => app.quit());

  ipcMain.handle(IPC.openChats, () => void openChatsWindow());
  ipcMain.handle(IPC.openSettings, (_e, section?: string) => void openSettingsWindow(section));

  ipcMain.handle(IPC.chatsList, () => listChats());
  ipcMain.handle(IPC.chatsGet, (_e, id: unknown) => getChat(assertId(id)));
  ipcMain.handle(IPC.chatsNew, () => newChat());
  ipcMain.handle(IPC.chatsOpen, (_e, id: unknown) => openChat(assertId(id)));
  ipcMain.handle(IPC.chatsRename, (_e, id: unknown, title: unknown) => renameChat(assertId(id), String(title ?? '')));
  ipcMain.handle(IPC.chatsDelete, (_e, id: unknown) => removeChat(assertId(id)));
  ipcMain.handle(IPC.chatsSend, (_e, req: ChatSendRequest) => sendFromWindow(req));
  ipcMain.handle(IPC.chatsStop, (_e, id: unknown) => stopChat(assertId(id)));
  ipcMain.handle(IPC.chatsActive, () => getActiveChatId());

  ipcMain.handle(IPC.openLogs, async () => {
    log('app', 'open logs');
    const err = await shell.openPath(logPath());
    if (err) shell.showItemInFolder(logPath());
  });
}

/* ───────────────────────── lifecycle ───────────────────────── */

async function bootstrap(): Promise<void> {
  if (process.platform === 'win32') app.setAppUserModelId('com.clickity.app');

  // Keep running with no visible windows: we live in the tray and the overlays.
  app.on('window-all-closed', () => {
    /* stay alive */
  });
  app.on('before-quit', () => {
    try {
      stopHotkeys();
    } catch {
      /* ignore */
    }
    shutdownConversation();
    destroyOverlays();
    destroyTray();
    try {
      cleanupCaptures();
    } catch {
      /* ignore */
    }
  });
  // mac: clicking the dock icon or re-launching from Finder / Launchpad.
  app.on('activate', () => openMainWindow());

  await app.whenReady();

  const settings = loadSettings();
  logStartup({ provider: settings.provider, stt: settings.speech.stt.provider, sttModel: settings.speech.stt.model, tts: settings.speech.tts.provider, hotkeys: settings.hotkeys });
  installTestHook();
  applySettingsTheme(settings.theme);
  applyLaunchAtLogin(settings.launchAtLogin);
  installPermissionHandlers();

  registerIpc();
  initConversation();
  initOverlays();

  try {
    const { backend } = startHotkeys(settings.hotkeys, {
      onTalkDown: () => {
        notifyHotkeyHeard('talk', getSettings().hotkeys.talk);
        onTalkDown();
      },
      onTalkUp,
      onType: () => {
        notifyHotkeyHeard('type', getSettings().hotkeys.type);
        onType();
      },
      onEscape,
    });
    console.log(`[main] hotkeys ready (${backend})`);
    log('hotkey', `ready (${backend})`);
  } catch (err) {
    console.error('[main] hotkeys failed to start:', err);
    log('hotkey', 'failed to start:', err);
  }

  createTray({
    openSettings: () => openSettingsWindow(),
    openChats: () => openChatsWindow(),
    isPaused: () => paused,
    setPaused,
    clearConversation: () => clearHistory(),
    quit: () => app.quit(),
  });

  installAppMenu(appMenuActions);

  onSettingsChanged(handleSettingsChanged);
  onChatsChanged((list) => sendToChats(IPC.chatsChanged, list));

  // Opening the app from its icon shows the settings window, like any app.
  // Started by the OS at login: stay quiet in the menu bar / tray.
  // Chats is the main window; settings (with onboarding) opens first until setup is done.
  if (!settings.onboarded) openSettingsWindow();
  else if (!launchedAtLogin()) openChatsWindow();
}
