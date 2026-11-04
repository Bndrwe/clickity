// Updater calls shared by the settings and chats preloads (bundled into each).
import { ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC, type UpdateApi, type UpdateState } from '../shared/ipc';

export const updateApi: UpdateApi = {
  getUpdate: () => ipcRenderer.invoke(IPC.updateGet),
  checkForUpdate: () => ipcRenderer.invoke(IPC.updateCheck),
  installUpdate: () => ipcRenderer.invoke(IPC.updateInstall),
  dismissUpdateNote: () => ipcRenderer.invoke(IPC.updateDismissNote),
  onUpdate: (cb) => {
    ipcRenderer.on(IPC.updateChanged, (_e: IpcRendererEvent, s: UpdateState) => cb(s));
  },
};
