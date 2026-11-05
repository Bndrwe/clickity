// Preload for the chats window: exposes `window.chats` (ChatsApi) over IPC.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { updateApi } from './update';
import { IPC, type ChatsApi } from '../shared/ipc';
import type { ChatEvent, ChatSummary, Settings } from '../shared/types';

const api: ChatsApi = {
  ...updateApi,
  list: () => ipcRenderer.invoke(IPC.chatsList),
  get: (id) => ipcRenderer.invoke(IPC.chatsGet, id),
  create: () => ipcRenderer.invoke(IPC.chatsNew),
  open: (id) => ipcRenderer.invoke(IPC.chatsOpen, id),
  rename: (id, title) => ipcRenderer.invoke(IPC.chatsRename, id, title),
  remove: (id) => ipcRenderer.invoke(IPC.chatsDelete, id),
  send: (req) => ipcRenderer.invoke(IPC.chatsSend, req),
  stop: (chatId) => ipcRenderer.invoke(IPC.chatsStop, chatId),
  active: () => ipcRenderer.invoke(IPC.chatsActive),
  approve: (turnId) => ipcRenderer.invoke(IPC.chatsApprove, turnId),
  deny: (turnId) => ipcRenderer.invoke(IPC.chatsDeny, turnId),
  answer: (req) => ipcRenderer.invoke(IPC.chatsAnswer, req),
  onEvent: (cb) => {
    ipcRenderer.on(IPC.chatsEvent, (_e: IpcRendererEvent, ev: ChatEvent) => cb(ev));
  },
  onChanged: (cb) => {
    ipcRenderer.on(IPC.chatsChanged, (_e: IpcRendererEvent, list: ChatSummary[]) => cb(list));
  },
  getSettings: () => ipcRenderer.invoke(IPC.settingsGet),
  setSettings: (patch) => ipcRenderer.invoke(IPC.settingsSet, patch),
  onSettingsChanged: (cb) => {
    ipcRenderer.on(IPC.settingsChanged, (_e: IpcRendererEvent, s: Settings) => cb(s));
  },
  providerModels: (kind) => ipcRenderer.invoke(IPC.providersModels, kind),
  openSettings: (section?: string) => ipcRenderer.invoke(IPC.openSettings, section),
};

contextBridge.exposeInMainWorld('chats', api);
