// Preload for the settings window: exposes `window.clicky` (SettingsApi) over IPC.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC, type SettingsApi } from '../shared/ipc';
import type { Settings } from '../shared/types';

const api: SettingsApi = {
  getSettings: () => ipcRenderer.invoke(IPC.settingsGet),
  setSettings: (patch) => ipcRenderer.invoke(IPC.settingsSet, patch),
  resetSettings: () => ipcRenderer.invoke(IPC.settingsReset),
  onSettingsChanged: (cb) => {
    ipcRenderer.on(IPC.settingsChanged, (_e: IpcRendererEvent, s: Settings) => cb(s));
  },
  providerStatus: (kind) => ipcRenderer.invoke(IPC.providersStatus, kind),
  providerModels: (kind) => ipcRenderer.invoke(IPC.providersModels, kind),
  providerTest: (kind) => ipcRenderer.invoke(IPC.providersTest, kind),
  providerLogin: (kind) => ipcRenderer.invoke(IPC.providersLogin, kind),
  suspendHotkeys: (suspended) => ipcRenderer.invoke(IPC.hotkeySuspend, suspended),
  getPermissions: () => ipcRenderer.invoke(IPC.permissionsGet),
  requestPermission: (kind) => ipcRenderer.invoke(IPC.permissionsRequest, kind),
  clearHistory: () => ipcRenderer.invoke(IPC.historyClear),
  openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url),
  appInfo: () => ipcRenderer.invoke(IPC.appInfo),
  testSpeak: () => ipcRenderer.invoke(IPC.testSpeak),
  quit: () => ipcRenderer.invoke(IPC.appQuit),
};

contextBridge.exposeInMainWorld('clicky', api);
