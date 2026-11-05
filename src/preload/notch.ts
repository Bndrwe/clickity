// Preload for the notch panel: exposes `window.notch` (NotchApi) over IPC.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC, type NotchApi, type NotchState } from '../shared/ipc';

const api: NotchApi = {
  onState: (cb) => {
    ipcRenderer.on(IPC.notchState, (_e: IpcRendererEvent, s: NotchState) => cb(s));
  },
  onCollapse: (cb) => {
    ipcRenderer.on(IPC.notchCollapse, () => cb());
  },
  ready: () => ipcRenderer.send(IPC.notchReady),
  setExpanded: (expanded, focus) => ipcRenderer.send(IPC.notchExpand, { expanded, focus }),
  send: (req) => ipcRenderer.invoke(IPC.notchSend, req),
  action: (a) => ipcRenderer.send(IPC.notchAction, a),
  switchClicky: async (id) => {
    await ipcRenderer.invoke(IPC.settingsSet, { activeClicky: id });
  },
};

contextBridge.exposeInMainWorld('notch', api);
