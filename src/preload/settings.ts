// Preload for the settings window: exposes `window.clicky` (SettingsApi) over IPC.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC, type HotkeyHeard, type HotkeyStatus, type KeyRecordEvent, type SettingsApi } from '../shared/ipc';
import type { Settings } from '../shared/types';

const api: SettingsApi = {
  getSettings: () => ipcRenderer.invoke(IPC.settingsGet),
  setSettings: (patch) => ipcRenderer.invoke(IPC.settingsSet, patch),
  resetSettings: () => ipcRenderer.invoke(IPC.settingsReset),
  onSettingsChanged: (cb) => {
    ipcRenderer.on(IPC.settingsChanged, (_e: IpcRendererEvent, s: Settings) => cb(s));
  },
  onGoto: (cb) => {
    ipcRenderer.on(IPC.settingsGoto, (_e: IpcRendererEvent, section: string) => cb(section));
  },
  providerStatus: (kind) => ipcRenderer.invoke(IPC.providersStatus, kind),
  providerModels: (kind) => ipcRenderer.invoke(IPC.providersModels, kind),
  providerTest: (kind) => ipcRenderer.invoke(IPC.providersTest, kind),
  providerLogin: (kind) => ipcRenderer.invoke(IPC.providersLogin, kind),
  suspendHotkeys: (suspended) => ipcRenderer.invoke(IPC.hotkeySuspend, suspended),
  recordKeysStart: () => ipcRenderer.invoke(IPC.recordKeysStart),
  recordKeysStop: () => ipcRenderer.invoke(IPC.recordKeysStop),
  onRecordKeys: (cb) => {
    ipcRenderer.on(IPC.recordKeys, (_e: IpcRendererEvent, ev: KeyRecordEvent) => cb(ev));
  },
  hotkeyStatus: () => ipcRenderer.invoke(IPC.hotkeyStatusGet),
  onHotkeyStatus: (cb) => {
    ipcRenderer.on(IPC.hotkeyStatusChanged, (_e: IpcRendererEvent, st: HotkeyStatus) => cb(st));
  },
  onHotkeyHeard: (cb) => {
    ipcRenderer.on(IPC.hotkeyHeard, (_e: IpcRendererEvent, ev: HotkeyHeard) => cb(ev));
  },
  getPermissions: () => ipcRenderer.invoke(IPC.permissionsGet),
  requestPermission: (kind) => ipcRenderer.invoke(IPC.permissionsRequest, kind),
  clearHistory: () => ipcRenderer.invoke(IPC.historyClear),
  openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url),
  appInfo: () => ipcRenderer.invoke(IPC.appInfo),
  relaunch: () => ipcRenderer.invoke(IPC.appRelaunch),
  testSpeak: () => ipcRenderer.invoke(IPC.testSpeak),
  quit: () => ipcRenderer.invoke(IPC.appQuit),
  openChats: () => ipcRenderer.invoke(IPC.openChats),
  openLogs: () => ipcRenderer.invoke(IPC.openLogs),
};

contextBridge.exposeInMainWorld('clicky', api);
